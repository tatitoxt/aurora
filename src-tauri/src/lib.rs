//! Noctbeat Tauri shell: thin adapter over noctbeat-core.
//! Commands/event names are the contract in docs/CONTRACT.md.

use noctbeat_core::energy::{BeatDetector, EnergyUpdate};
use noctbeat_core::history::{play_threshold_ms, History, PlayRecord, Stats, Wrapped};
use noctbeat_core::licensing::{Http, LicenseClient, LicenseState, UreqHttp};
use noctbeat_core::lyrics::{active_line, LrcLine, LrclibClient, LyricsCache};
use noctbeat_core::media::{
    now_ms, Control, DemoSource, NowPlaying, NowPlayingSource, PlaybackStatus, Track,
};
use noctbeat_core::palette::{extract_palette_bytes, Palette};
use noctbeat_core::player::{LocalPlayer, QueueItem, RepeatMode};
use noctbeat_core::providers::{self, RemoteTrack, YtDlp};

mod audio;
use noctbeat_core::settings::{Profile, Settings};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

struct AppState {
    source: Mutex<Box<dyn NowPlayingSource>>,
    /// In-app player for local files; wins over `source` while active.
    player: Mutex<LocalPlayer>,
    /// Arc-shared with the player's path resolver so settings edits reach it.
    settings: std::sync::Arc<Mutex<Settings>>,
    settings_path: PathBuf,
    beat: Mutex<BeatDetector>,
    last_energy: Mutex<EnergyUpdate>,
    lyrics: Mutex<Option<(String, Vec<LrcLine>)>>,
    lyrics_cache: LyricsCache,
    license_path: PathBuf,
    /// Latest HUD position reported by the Moved event, debounced before
    /// persisting so a drag does not write settings on every pixel.
    hud_pos_pending: Mutex<Option<((i32, i32), std::time::Instant)>>,
    /// Same debounce for the desktop-lyrics overlay window.
    desk_lyrics_pos_pending: Mutex<Option<((i32, i32), std::time::Instant)>>,
    /// Concrete audio output, kept beside the trait object so the output
    /// device can be swapped live.
    rodio: Option<std::sync::Arc<audio::RodioOut>>,
    /// Listening history, persisted to history.json beside settings.
    history: Mutex<History>,
    history_path: PathBuf,
    /// Wall-clock time accumulated on the track currently playing.
    listen: Mutex<ListenTracker>,
    /// Metadata for queue items whose `path` is a `remote:<source>:<id>`
    /// pseudo-path; the player's resolver downloads them on demand.
    remote: std::sync::Arc<Mutex<std::collections::HashMap<String, RemoteTrack>>>,
    /// Streams cache dir shared by the resolver and prefetch.
    stream_cache: PathBuf,
    /// Remote keys with a prefetch download already running, so the
    /// per-tick poller does not stack duplicate yt-dlp workers.
    prefetching: std::sync::Arc<Mutex<std::collections::HashSet<String>>>,
    demo: bool,
}

/// Accumulates wall-clock listening per track; on change/stop the stretch
/// becomes a PlayRecord once it passes `play_threshold_ms`.
#[derive(Default)]
struct ListenTracker {
    track: Option<Track>,
    source: String,
    ms: u64,
    since_ms: u64,
    last_pos_ms: u64,
}

impl ListenTracker {
    fn update(
        &mut self,
        np: &NowPlaying,
        tick_ms: u64,
        hist: &Mutex<History>,
        path: &std::path::Path,
    ) {
        // Stopped (even with track metadata still attached) ends the
        // listen: flush it and stay idle instead of buffering forever.
        if np.status == PlaybackStatus::Stopped {
            self.flush(hist, path);
            self.ms = 0;
            return;
        }
        // Boundary: the track id changed, or the position rewound — repeat
        // and restart reset it near zero. A >2 s user seek-back also reads
        // as a new play; an accepted trade-off for catching repeats.
        let same_track = matches!((&self.track, &np.track), (Some(a), Some(b)) if a.id == b.id);
        let rewound = same_track && np.position_ms + 2_000 < self.last_pos_ms;
        if !same_track || rewound {
            self.flush(hist, path);
            self.track = np.track.clone();
            self.source = np.source.clone();
            self.ms = 0;
            self.since_ms = np.updated_at_ms;
        }
        if np.status == PlaybackStatus::Playing && np.track.is_some() {
            self.ms += tick_ms;
        }
        self.last_pos_ms = np.position_ms;
    }

    fn flush(&mut self, hist: &Mutex<History>, path: &std::path::Path) {
        self.last_pos_ms = 0;
        let Some(t) = self.track.take() else { return };
        if self.ms >= play_threshold_ms(t.duration_ms) {
            let rec = PlayRecord {
                track_id: t.id,
                title: t.title,
                artist: t.artist,
                source: self.source.clone(),
                duration_ms: t.duration_ms,
                ms_listened: self.ms,
                played_at_ms: self.since_ms,
            };
            if let Ok(mut h) = hist.lock() {
                h.record(rec);
                let _ = h.save(path);
            }
        }
    }
}

fn config_dir() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(&noctbeat_core::branding::branding().short_name)
}

/// Cache file name a downloaded stream lands under.
fn remote_cache_name(rt: &RemoteTrack) -> String {
    format!(
        "{}-{}",
        rt.source,
        rt.id.replace(|c: char| !c.is_alphanumeric(), "_")
    )
}

/// Map a `remote:` queue key to an on-disk file: reuse the cache hit or
/// download with yt-dlp. Lock order is always player → remote: callers
/// inside play paths already hold the player lock, so this never takes
/// it.
fn resolve_remote(
    map: &Mutex<std::collections::HashMap<String, RemoteTrack>>,
    settings: &Mutex<Settings>,
    cache: &std::path::Path,
    key: &str,
) -> Result<PathBuf, String> {
    let rt = map
        .lock()
        .map_err(|e| e.to_string())?
        .get(key)
        .cloned()
        .ok_or_else(|| format!("unknown remote track {key}"))?;
    let name = remote_cache_name(&rt);
    if let Some(f) = providers::cached_file(cache, &name) {
        return Ok(f);
    }
    let ytdlp = {
        let s = settings.lock().map_err(|e| e.to_string())?;
        YtDlp::detect(s.ytdlp_path.as_deref())
    }
    .ok_or("yt-dlp not installed")?;
    ytdlp.download(&rt.url, cache, &name)
}

/// Kick a background download for the queue item right after `index` when
/// it is a remote track, so auto-advance almost never waits on yt-dlp.
fn prefetch_next(state: &AppState, index: usize) {
    let Ok(p) = state.player.lock() else {
        return;
    };
    let key = p
        .queue()
        .get(index + 1)
        .and_then(|i| i.path.strip_prefix("remote:"))
        .map(str::to_owned);
    drop(p);
    let Some(key) = key else { return };
    let Ok(mut in_flight) = state.prefetching.lock() else {
        return;
    };
    if !in_flight.insert(key.clone()) {
        return;
    }
    drop(in_flight);
    let map = state.remote.clone();
    let settings = state.settings.clone();
    let cache = state.stream_cache.clone();
    let done = state.prefetching.clone();
    std::thread::spawn(move || {
        let _ = resolve_remote(&map, &settings, &cache, &key);
        if let Ok(mut f) = done.lock() {
            f.remove(&key);
        }
    });
}

/// The local player claims the transport while it is playing or paused;
/// otherwise whatever the OS reports (Spotify, browser, …) wins.
fn local_active(state: &AppState) -> bool {
    state
        .player
        .lock()
        .map(|p| p.status() != PlaybackStatus::Stopped)
        .unwrap_or(false)
}

fn poll_np(state: &AppState) -> NowPlaying {
    if local_active(state) {
        if let Ok(mut p) = state.player.lock() {
            let idx = p.current_index();
            if let Ok(np) = p.poll() {
                drop(p);
                if let Some(i) = idx {
                    prefetch_next(state, i);
                }
                return np;
            }
        }
    }
    state
        .source
        .lock()
        .ok()
        .and_then(|mut s| s.poll().ok())
        .unwrap_or(NowPlaying {
            track: None,
            status: PlaybackStatus::Stopped,
            position_ms: 0,
            source: "null".into(),
            updated_at_ms: now_ms(),
        })
}

#[tauri::command]
fn get_now_playing(state: State<AppState>) -> Result<NowPlaying, String> {
    Ok(poll_np(&state))
}

#[tauri::command]
fn get_stats(state: State<AppState>) -> Result<Stats, String> {
    let h = state.history.lock().map_err(|e| e.to_string())?;
    Ok(h.stats(14, now_ms()))
}

/// Monthly recap (wrapped) for the calendar month containing now.
#[tauri::command]
fn get_wrapped(state: State<AppState>) -> Result<Wrapped, String> {
    let h = state.history.lock().map_err(|e| e.to_string())?;
    Ok(h.wrapped(now_ms()))
}

#[tauri::command]
fn clear_history(state: State<AppState>) -> Result<(), String> {
    let mut h = state.history.lock().map_err(|e| e.to_string())?;
    h.records.clear();
    h.save(&state.history_path).map_err(|e| e.to_string())
}

/// Async: a play/pause/next that lands on an uncached remote track can
/// block for a yt-dlp download — that must happen on the runtime pool,
/// not the IPC thread.
#[tauri::command]
async fn media_control(state: State<'_, AppState>, cmd: Control) -> Result<(), String> {
    if local_active(&state) {
        return state
            .player
            .lock()
            .map_err(|e| e.to_string())?
            .control(cmd)
            .map_err(|e| e.to_string());
    }
    state
        .source
        .lock()
        .map_err(|e| e.to_string())?
        .control(cmd)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn seek(state: State<AppState>, position_ms: u64) -> Result<(), String> {
    if !local_active(&state) {
        return Err("seek is only supported for local playback".into());
    }
    state
        .player
        .lock()
        .map_err(|e| e.to_string())?
        .seek(position_ms)
}

#[tauri::command]
fn set_volume(state: State<AppState>, volume: f32) -> Result<(), String> {
    state
        .player
        .lock()
        .map_err(|e| e.to_string())?
        .set_volume(volume);
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct QueueOut {
    items: Vec<QueueItem>,
    current_index: Option<usize>,
}

#[tauri::command]
fn get_queue(state: State<AppState>) -> Result<QueueOut, String> {
    let p = state.player.lock().map_err(|e| e.to_string())?;
    Ok(QueueOut {
        items: p.queue().to_vec(),
        current_index: p.current_index(),
    })
}

/// Push the current queue to every window after a mutation, so panels
/// like the fullscreen "Continue Playing" list stay live.
fn emit_queue(app: &tauri::AppHandle, state: &State<AppState>) {
    if let Ok(p) = state.player.lock() {
        let _ = app.emit(
            "queue",
            QueueOut {
                items: p.queue().to_vec(),
                current_index: p.current_index(),
            },
        );
    }
}

#[tauri::command]
async fn play_queue_index(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    index: usize,
) -> Result<(), String> {
    // Pre-resolve on the runtime pool: the resolver also runs under the
    // player lock (auto-advance), but a UI-initiated first play must not
    // hold it through a whole download.
    let path = state
        .player
        .lock()
        .map_err(|e| e.to_string())?
        .queue()
        .get(index)
        .map(|i| i.path.clone());
    if let Some(key) = path.and_then(|p| p.strip_prefix("remote:").map(str::to_owned)) {
        let map = state.remote.clone();
        let settings = state.settings.clone();
        let cache = state.stream_cache.clone();
        resolve_remote(&map, &settings, &cache, &key)?;
    }
    state
        .player
        .lock()
        .map_err(|e| e.to_string())?
        .play_index(index)?;
    prefetch_next(&state, index);
    emit_queue(&app, &state);
    Ok(())
}

/// Toggle queue shuffle; applies to explicit Next and auto-advance.
#[tauri::command]
fn set_shuffle(state: State<AppState>, on: bool) -> Result<bool, String> {
    let mut p = state.player.lock().map_err(|e| e.to_string())?;
    p.set_shuffle(on);
    Ok(p.shuffle())
}

#[tauri::command]
fn get_shuffle(state: State<AppState>) -> bool {
    state.player.lock().map(|p| p.shuffle()).unwrap_or(false)
}

/// Queue repeat: "off" | "all" | "one".
#[tauri::command]
fn set_repeat(state: State<AppState>, mode: String) -> Result<String, String> {
    let m = match mode.as_str() {
        "off" => RepeatMode::Off,
        "all" => RepeatMode::All,
        "one" => RepeatMode::One,
        other => return Err(format!("unknown repeat mode {other}")),
    };
    let mut p = state.player.lock().map_err(|e| e.to_string())?;
    p.set_repeat(m);
    Ok(format!("{:?}", p.repeat()).to_lowercase())
}

#[tauri::command]
fn get_repeat(state: State<AppState>) -> String {
    state
        .player
        .lock()
        .map(|p| format!("{:?}", p.repeat()).to_lowercase())
        .unwrap_or_else(|_| "off".into())
}

#[tauri::command]
fn get_volume(state: State<AppState>) -> f32 {
    state.player.lock().map(|p| p.volume()).unwrap_or(1.0)
}

#[tauri::command]
fn clear_queue(app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    state.player.lock().map_err(|e| e.to_string())?.clear();
    emit_queue(&app, &state);
    Ok(())
}

/// Scan `dir` (or the configured music dir) and replace the play queue.
#[tauri::command]
fn scan_library(
    app: tauri::AppHandle,
    state: State<AppState>,
    dir: Option<String>,
) -> Result<Vec<QueueItem>, String> {
    let dir = dir.or_else(|| state.settings.lock().ok().and_then(|s| s.music_dir.clone()));
    let Some(dir) = dir else {
        return Err("no music folder configured".into());
    };
    // Expand a leading ~ or ~/ against the user's home directory.
    let dir = if dir == "~" || dir.starts_with("~/") {
        match std::env::home_dir() {
            Some(h) => h.join(dir.trim_start_matches("~/")).display().to_string(),
            None => dir,
        }
    } else {
        dir
    };
    let dir_path = std::path::Path::new(&dir);
    if !dir_path.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    let items = noctbeat_core::library::scan(dir_path);
    state
        .player
        .lock()
        .map_err(|e| e.to_string())?
        .set_queue(items.clone());
    emit_queue(&app, &state);
    Ok(items)
}

// ---------- remote providers (yt-dlp-backed) ----------

fn detected_ytdlp(state: &State<AppState>) -> Result<YtDlp, String> {
    let explicit = state
        .settings
        .lock()
        .map_err(|e| e.to_string())?
        .ytdlp_path
        .clone();
    YtDlp::detect(explicit.as_deref())
        .ok_or_else(|| "yt-dlp not found — install it or set its path in Settings".into())
}

#[tauri::command]
fn provider_status(state: State<AppState>) -> bool {
    detected_ytdlp(&state).is_ok()
}

/// Async so the synchronous yt-dlp extraction runs on the runtime pool, not
/// the UI thread.
#[tauri::command]
async fn provider_search(
    state: State<'_, AppState>,
    source: String,
    query: String,
) -> Result<Vec<RemoteTrack>, String> {
    detected_ytdlp(&state)?.search(&source, &query, 8)
}

/// Download the track's audio into the app cache and play it through the
/// local player, so seek/queue/energy all work identically to local files.
#[tauri::command]
async fn provider_play(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    track: RemoteTrack,
) -> Result<QueueItem, String> {
    let ytdlp = detected_ytdlp(&state)?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("streams");
    let name = format!(
        "{}-{}",
        track.source,
        track.id.replace(|c: char| !c.is_alphanumeric(), "_")
    );
    let path = ytdlp.download(&track.url, &cache, &name)?;
    let item = QueueItem {
        track: Track {
            id: format!("{}:{}", track.source, track.id),
            title: track.title,
            artist: track.artist,
            album: String::new(),
            artwork_url: track.artwork_url,
            duration_ms: track.duration_ms,
        },
        path: path.display().to_string(),
    };
    let mut p = state.player.lock().map_err(|e| e.to_string())?;
    p.set_queue(std::slice::from_ref(&item).to_vec());
    p.play_index(0)?;
    drop(p);
    emit_queue(&app, &state);
    Ok(item)
}

/// Outcome of `import_playlist`: tracks enqueued, http(s) entries left for
/// the provider layer, and file entries that no longer exist on disk.
#[derive(serde::Serialize)]
struct ImportResult {
    imported: u32,
    remote: u32,
    missing: u32,
}

/// Parse a playlist file (.m3u/.m3u8/.pls/.xspf) and enqueue every local
/// track it lists. Remote URLs are counted, not dropped silently — the UI
/// reports them as needing provider support.
#[tauri::command]
fn import_playlist(
    app: tauri::AppHandle,
    state: State<AppState>,
    path: String,
) -> Result<ImportResult, String> {
    let file = std::path::PathBuf::from(&path);
    let content = std::fs::read_to_string(&file).map_err(|e| format!("read {path}: {e}"))?;
    let entries = noctbeat_core::playlists::parse(&file, &content);
    let mut player = state.player.lock().map_err(|e| e.to_string())?;
    let mut res = ImportResult {
        imported: 0,
        remote: 0,
        missing: 0,
    };
    for entry in entries {
        match entry {
            noctbeat_core::playlists::PlaylistEntry::File {
                path,
                title,
                artist,
                duration_ms,
            } => {
                if !path.is_file() {
                    res.missing += 1;
                    continue;
                }
                let name = path.to_string_lossy().into_owned();
                // Tag probing fills duration/artist/album the playlist lacks,
                // so imported tracks stay seekable.
                let mut track = noctbeat_core::library::tag_track(&path);
                track.id = name.clone();
                if let Some(t) = title {
                    track.title = t;
                }
                if let Some(a) = artist {
                    track.artist = a;
                }
                if let Some(d) = duration_ms {
                    track.duration_ms = d;
                }
                player.add(noctbeat_core::player::QueueItem { track, path: name });
                res.imported += 1;
            }
            noctbeat_core::playlists::PlaylistEntry::Remote(_) => res.remote += 1,
        }
    }
    drop(player);
    emit_queue(&app, &state);
    Ok(res)
}

/// Outcome of `import_playlist_url`: the playlist's own title and how
/// many tracks were queued for lazy download.
#[derive(serde::Serialize)]
struct PlaylistUrlResult {
    title: String,
    imported: u32,
}

/// Enqueue every entry of a remote playlist/mix URL. Tracks carry a
/// `remote:` pseudo-path and download one by one as playback reaches
/// them — a 200-track list must not trigger 200 downloads up front.
#[tauri::command]
async fn import_playlist_url(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<PlaylistUrlResult, String> {
    let ytdlp = detected_ytdlp(&state)?;
    let pl = ytdlp.playlist(&url, 200)?;
    // Lock order player → remote matches the resolver inside play_index;
    // taking remote first here deadlocks against auto-advance.
    let mut player = state.player.lock().map_err(|e| e.to_string())?;
    let mut map = state.remote.lock().map_err(|e| e.to_string())?;
    for t in &pl.tracks {
        let key = format!("{}:{}", t.source, t.id);
        map.insert(key.clone(), t.clone());
        player.add(QueueItem {
            track: Track {
                id: key.clone(),
                title: t.title.clone(),
                artist: t.artist.clone(),
                album: pl.title.clone(),
                artwork_url: t.artwork_url.clone(),
                duration_ms: t.duration_ms,
            },
            path: format!("remote:{key}"),
        });
    }
    drop(map);
    drop(player);
    emit_queue(&app, &state);
    Ok(PlaylistUrlResult {
        title: pl.title,
        imported: pl.tracks.len() as u32,
    })
}

/// Retune the live EQ (dB per band) and persist the choice.
#[tauri::command]
fn set_eq(app: tauri::AppHandle, preset: String, bands: Vec<f32>) -> Result<(), String> {
    let state = app.state::<AppState>();
    if let Some(rodio) = &state.rodio {
        rodio.eq().set(&bands);
    }
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    s.eq_preset = preset;
    s.eq_bands = bands;
    s.save(&state.settings_path).map_err(|e| e.to_string())?;
    let _ = app.emit("settings", s.clone());
    Ok(())
}

/// Capture the current look+sound as a named profile (same name upserts).
#[tauri::command]
fn save_profile(app: tauri::AppHandle, name: String) -> Result<Profile, String> {
    let state = app.state::<AppState>();
    let name = name.trim();
    if name.is_empty() {
        return Err("name required".into());
    }
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    let id = s.save_profile(name, now_ms());
    s.save(&state.settings_path).map_err(|e| e.to_string())?;
    let p = s
        .profiles
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or("profile vanished")?;
    let _ = app.emit("settings", s.clone());
    Ok(p)
}

/// Apply a saved profile: theme, EQ, lyrics mode and video backdrop go
/// live at once (theme via the settings event, EQ via the live chain).
#[tauri::command]
fn apply_profile(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    if !s.apply_profile(&id) {
        return Err("unknown profile".into());
    }
    if let Some(rodio) = &state.rodio {
        rodio.eq().set(&s.eq_bands);
    }
    s.save(&state.settings_path).map_err(|e| e.to_string())?;
    let _ = app.emit("settings", s.clone());
    Ok(())
}

#[tauri::command]
fn delete_profile(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    if !s.delete_profile(&id) {
        return Err("unknown profile".into());
    }
    s.save(&state.settings_path).map_err(|e| e.to_string())?;
    let _ = app.emit("settings", s.clone());
    Ok(())
}

/// Arm or clear the sleep timer. `minutes` sets an absolute deadline
/// (persisted, so a relaunch still honors it); `None` clears it.
#[tauri::command]
fn set_sleep_timer(app: tauri::AppHandle, minutes: Option<u64>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    s.sleep_timer_ends_ms = minutes.map(|m| now_ms() + m.saturating_mul(60_000));
    s.save(&state.settings_path).map_err(|e| e.to_string())?;
    let _ = app.emit("settings", s.clone());
    Ok(())
}

/// OS audio output device names for the settings picker.
#[tauri::command]
fn list_outputs() -> Vec<String> {
    audio::RodioOut::list_outputs()
}

/// Switch the output device live: swap the sink, persist the choice, and
/// re-open the current track so playback resumes where it was.
#[tauri::command]
fn set_output_device(app: tauri::AppHandle, name: Option<String>) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        // Hold the player lock across the whole swap: the poller can never
        // observe the empty stream and mistake it for a finished track.
        let mut player = state.player.lock().map_err(|e| e.to_string())?;
        if let Some(rodio) = &state.rodio {
            // Read the position from the old stream before it is dropped.
            let (pos, playing) = player.reopen_snapshot();
            rodio.set_device(name.as_deref())?;
            player.reopen_current(pos, playing)?;
        }
    }
    // Persist after playback is already safe — a save failure must not
    // strand the track on the new sink.
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    s.audio_output = name;
    s.save(&state.settings_path).map_err(|e| e.to_string())?;
    let _ = app.emit("settings", s.clone());
    Ok(())
}

/// Resolve the track's music video to a direct stream URL for the karaoke
/// backdrop. `Ok(None)` when yt-dlp is missing or no video resolves — the
/// player falls back to the blurred artwork.
#[tauri::command]
async fn resolve_video(
    state: State<'_, AppState>,
    artist: String,
    title: String,
) -> Result<Option<String>, String> {
    match detected_ytdlp(&state) {
        Ok(ytdlp) => ytdlp.resolve_video(&artist, &title),
        Err(_) => Ok(None),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PaletteOut {
    dominant: String,
    accents: Vec<String>,
}

#[tauri::command]
async fn get_palette(artwork_url: String) -> Result<PaletteOut, String> {
    let bytes = fetch_artwork(&artwork_url)?;
    let Palette { dominant, accents } = extract_palette_bytes(&bytes).map_err(|e| e.to_string())?;
    Ok(PaletteOut {
        dominant: noctbeat_core::palette::to_hex(dominant),
        accents: accents
            .iter()
            .map(|c| noctbeat_core::palette::to_hex(*c))
            .collect(),
    })
}

fn fetch_artwork(url: &str) -> Result<Vec<u8>, String> {
    if url.is_empty() {
        return Err("no artwork".into());
    }
    if let Some(path) = url.strip_prefix("file://") {
        return std::fs::read(path).map_err(|e| e.to_string());
    }
    {
        // Bare absolute path (embedded artwork cache) — not a URL.
        let p = std::path::Path::new(url);
        if p.is_absolute() && p.exists() {
            return std::fs::read(p).map_err(|e| e.to_string());
        }
    }
    let resp = ureq::get(url)
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| e.to_string())?
        .into_reader();
    use std::io::Read;
    let mut body = Vec::new();
    resp.take(4 * 1024 * 1024)
        .read_to_end(&mut body)
        .map_err(|e| e.to_string())?;
    Ok(body)
}

#[tauri::command]
async fn get_lyrics(state: State<'_, AppState>) -> Result<Option<Vec<LrcLine>>, String> {
    let np = get_now_playing(state.clone())?;
    let Some(track) = np.track else {
        return Ok(None);
    };
    {
        let cache = state.lyrics.lock().map_err(|e| e.to_string())?;
        if let Some((id, lines)) = cache.as_ref() {
            if *id == track.id {
                return Ok(Some(lines.clone()));
            }
        }
    }
    let client = LrclibClient::new();
    let lines = client
        .fetch_cached(&track, &state.lyrics_cache)
        .map_err(|e| e.to_string())?;
    let mut cache = state.lyrics.lock().map_err(|e| e.to_string())?;
    *cache = lines.clone().map(|l| (track.id.clone(), l));
    Ok(lines)
}

#[tauri::command]
fn get_lyrics_index(state: State<AppState>, position_ms: u64) -> Result<Option<usize>, String> {
    let cache = state.lyrics.lock().map_err(|e| e.to_string())?;
    Ok(cache
        .as_ref()
        .and_then(|(_, lines)| active_line(lines, position_ms)))
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Result<Settings, String> {
    Ok(state.settings.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
fn update_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    let state = app.state::<AppState>();
    // The sleep timer is owned by `set_sleep_timer`: a settings snapshot
    // rendered before the timer was armed would otherwise resurrect or
    // erase the live deadline on every unrelated save.
    let mut incoming = settings;
    {
        let mut guard = state.settings.lock().map_err(|e| e.to_string())?;
        incoming.sleep_timer_ends_ms = guard.sleep_timer_ends_ms;
        incoming
            .save(&state.settings_path)
            .map_err(|e| e.to_string())?;
        *guard = incoming.clone();
    }
    sync_edge_windows(&app, &incoming);
    sync_hud_window(&app, &incoming);
    sync_desk_lyrics_window(&app, &incoming);
    let _ = app.emit("settings", incoming);
    Ok(())
}

#[tauri::command]
fn set_hud_pinned(app: tauri::AppHandle, pinned: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut s = state.settings.lock().map_err(|e| e.to_string())?;
        s.hud_always_on_top = pinned;
        s.save(&state.settings_path).map_err(|e| e.to_string())?;
        let _ = app.emit("settings", s.clone());
    }
    if let Some(win) = app.get_webview_window("hud") {
        win.set_always_on_top(pinned).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Begin an OS-native drag of the lyrics overlay (called on mousedown).
#[tauri::command]
fn desk_lyrics_start_drag(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("desklyrics") {
        win.start_dragging().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Begin an OS-native drag of the HUD window (called on mousedown in the pill).
#[tauri::command]
fn hud_start_drag(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("hud") {
        win.start_dragging().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Bring the full player window forward (HUD expand button).
#[tauri::command]
fn show_player(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("player") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    Ok(())
}

/// iBaila-style "wallpaper" mode: fullscreen the player window so karaoke
/// and the visualizer take over the screen. Returns the new state.
#[tauri::command]
fn toggle_fullscreen(app: tauri::AppHandle) -> Result<bool, String> {
    let win = app.get_webview_window("player").ok_or("no player window")?;
    let on = !win.is_fullscreen().map_err(|e| e.to_string())?;
    win.set_fullscreen(on).map_err(|e| e.to_string())?;
    Ok(on)
}

fn license_client<'a>(http: &'a dyn Http, state: &AppState) -> LicenseClient<'a> {
    LicenseClient::new(http, state.license_path.clone())
}

#[tauri::command]
async fn get_license_state(state: State<'_, AppState>) -> Result<LicenseState, String> {
    let http = UreqHttp;
    Ok(license_client(&http, &state).refresh())
}

#[tauri::command]
async fn activate_license(state: State<'_, AppState>, key: String) -> Result<LicenseState, String> {
    let http = UreqHttp;
    Ok(license_client(&http, &state).activate(&key))
}

#[tauri::command]
fn get_energy(state: State<AppState>) -> Result<EnergyUpdate, String> {
    Ok(*state.last_energy.lock().map_err(|e| e.to_string())?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DisplayInfo {
    id: String,
    name: String,
    primary: bool,
}

#[tauri::command]
fn list_displays(app: tauri::AppHandle) -> Result<Vec<DisplayInfo>, String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    Ok(monitors
        .into_iter()
        .enumerate()
        .map(|(i, m)| DisplayInfo {
            id: format!("display-{i}"),
            name: m
                .name()
                .cloned()
                .unwrap_or_else(|| format!("Display {}", i + 1)),
            primary: i == 0,
        })
        .collect())
}

/// One click-through, transparent overlay window per enabled display.
fn sync_edge_windows(app: &tauri::AppHandle, settings: &Settings) {
    let monitors = app.available_monitors().unwrap_or_default();
    for (i, monitor) in monitors.iter().enumerate() {
        let id = format!("display-{i}");
        let label = format!("edge-{id}");
        let enabled = settings
            .displays
            .iter()
            .find(|d| d.display_id == id)
            .map(|d| d.enabled)
            .unwrap_or(true);
        if let Some(win) = app.get_webview_window(&label) {
            if !enabled {
                let _ = win.close();
            }
            continue;
        }
        if !enabled {
            continue;
        }
        let size = monitor.size();
        let pos = monitor.position();
        if let Ok(win) = tauri::WebviewWindowBuilder::new(
            app,
            &label,
            tauri::WebviewUrl::App("index.html#/edge".into()),
        )
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .inner_size(size.width as f64, size.height as f64)
        .position(pos.x as f64, pos.y as f64)
        .build()
        {
            let _ = win.set_ignore_cursor_events(true);
        }
    }
}

/// Floating HUD pill: borderless, transparent, draggable anywhere, optionally
/// pinned above other windows. Position persists via the Moved event.
fn sync_hud_window(app: &tauri::AppHandle, settings: &Settings) {
    if let Some(win) = app.get_webview_window("hud") {
        if settings.hud_enabled {
            let _ = win.set_always_on_top(settings.hud_always_on_top);
        } else {
            let _ = win.close();
        }
        return;
    }
    if !settings.hud_enabled {
        return;
    }
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        "hud",
        tauri::WebviewUrl::App("index.html#/hud".into()),
    )
    .transparent(true)
    .decorations(false)
    .always_on_top(settings.hud_always_on_top)
    .skip_taskbar(true)
    .resizable(false)
    .inner_size(460.0, 76.0);
    if let Ok(win) = builder.build() {
        // Moved reports physical pixels; restore them physically too, or a
        // scaled display would double-apply the scale factor.
        if let Some((x, y)) = settings.hud_position {
            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        }
        let app2 = app.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::Moved(pos) = event {
                let state = app2.state::<AppState>();
                if let Ok(mut pending) = state.hud_pos_pending.lock() {
                    *pending = Some(((pos.x, pos.y), std::time::Instant::now()));
                };
            }
        });
    }
}

/// Floating desktop-lyrics overlay: same window recipe as the HUD —
/// borderless, transparent, draggable, pinned on top — showing the karaoke
/// line instead of transport controls.
fn sync_desk_lyrics_window(app: &tauri::AppHandle, settings: &Settings) {
    if let Some(win) = app.get_webview_window("desklyrics") {
        if !settings.desk_lyrics_enabled {
            let _ = win.close();
        }
        return;
    }
    if !settings.desk_lyrics_enabled {
        return;
    }
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        "desklyrics",
        tauri::WebviewUrl::App("index.html#/desklyrics".into()),
    )
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .inner_size(720.0, 170.0);
    if let Ok(win) = builder.build() {
        if let Some((x, y)) = settings.desk_lyrics_position {
            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        }
        let app2 = app.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::Moved(pos) = event {
                let state = app2.state::<AppState>();
                if let Ok(mut pending) = state.desk_lyrics_pos_pending.lock() {
                    *pending = Some(((pos.x, pos.y), std::time::Instant::now()));
                };
            }
        });
    }
}

/// Persist a floating window's resting position once it stops moving for
/// 300ms — dragging must not write settings on every pixel.
fn flush_position(
    app: &tauri::AppHandle,
    pending: &Mutex<Option<((i32, i32), std::time::Instant)>>,
    read: impl Fn(&Settings) -> Option<(i32, i32)>,
    write: impl Fn(&mut Settings, (i32, i32)),
) {
    let state = app.state::<AppState>();
    let pos = {
        let Ok(p) = pending.lock() else {
            return;
        };
        match *p {
            Some((pos, at)) if at.elapsed() > std::time::Duration::from_millis(300) => pos,
            _ => return,
        }
    };
    if let Ok(mut p) = pending.lock() {
        *p = None;
    }
    let Ok(mut s) = state.settings.lock() else {
        return;
    };
    if read(&s) == Some(pos) {
        return;
    }
    write(&mut s, pos);
    if s.save(&state.settings_path).is_ok() {
        let _ = app.emit("settings", s.clone());
    }
}

fn flush_hud_position(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    flush_position(
        app,
        &state.hud_pos_pending,
        |s| s.hud_position,
        |s, p| s.hud_position = Some(p),
    );
}

fn flush_desk_lyrics_position(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    flush_position(
        app,
        &state.desk_lyrics_pos_pending,
        |s| s.desk_lyrics_position,
        |s, p| s.desk_lyrics_position = Some(p),
    );
}

/// Synthetic energy for demo/fallback: tempo-synced pulses while playing,
/// with a rotating spectrum so the visualizer still reads as music.
fn synthetic_energy(np: &NowPlaying, prev: &EnergyUpdate) -> EnergyUpdate {
    match np.status {
        noctbeat_core::media::PlaybackStatus::Playing => {
            // 120 BPM pulse train.
            let beat = np.position_ms % 500 < 40;
            let level = if beat {
                (prev.level * 0.5 + 0.5).min(1.0)
            } else {
                (prev.level * 0.94).max(0.25)
            };
            // Deterministic rotating hump across bands, scaled by level.
            let center = (np.position_ms / 400 % 16) as f32;
            let bands = std::array::from_fn(|i| {
                let d = (i as f32 - center)
                    .abs()
                    .min(16.0 - (i as f32 - center).abs());
                (level * (1.0 - d / 7.0).max(0.08)).min(1.0)
            });
            EnergyUpdate {
                level,
                beat,
                bpm: Some(120.0),
                bands,
            }
        }
        _ => EnergyUpdate {
            level: prev.level * 0.9,
            beat: false,
            bpm: prev.bpm,
            bands: std::array::from_fn(|i| prev.bands[i] * 0.9),
        },
    }
}

fn spawn_poller(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut ticks = 0u64;
        let mut last_tick = std::time::Instant::now();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            ticks += 1;
            // Real elapsed time: polling work (e.g. subprocess calls in
            // external sources) adds to the interval beyond the sleep.
            let tick_ms = last_tick.elapsed().as_millis() as u64;
            last_tick = std::time::Instant::now();
            let state = app.state::<AppState>();
            let np = {
                if !local_active(&state) {
                    // Rediscover the platform player source while idle.
                    if !state.demo
                        && ticks.is_multiple_of(25)
                        && state
                            .source
                            .lock()
                            .map(|s| s.name() == "null")
                            .unwrap_or(false)
                    {
                        if let Ok(mut src) = state.source.lock() {
                            *src = noctbeat_core::media::platform_source();
                        }
                    }
                }
                poll_np(&state)
            };
            // Sleep timer: pause whatever is playing when the deadline hits.
            {
                let ends = state
                    .settings
                    .lock()
                    .ok()
                    .and_then(|s| s.sleep_timer_ends_ms);
                if ends.is_some_and(|t| now_ms() >= t) {
                    if local_active(&state) {
                        if let Ok(mut p) = state.player.lock() {
                            if p.status() == PlaybackStatus::Playing {
                                let _ = p.control(Control::PlayPause);
                            }
                        }
                    } else if np.status == PlaybackStatus::Playing {
                        if let Ok(mut s) = state.source.lock() {
                            // np is a stale sample: re-poll so an external
                            // pause in between isn't toggled back to playing.
                            let still_playing = s
                                .poll()
                                .map(|fresh| fresh.status)
                                .unwrap_or(PlaybackStatus::Stopped);
                            if still_playing == PlaybackStatus::Playing {
                                let _ = s.control(Control::PlayPause);
                            }
                        }
                    }
                    if let Ok(mut s) = state.settings.lock() {
                        // A timer re-armed between the read above and this
                        // lock must survive: only clear a deadline that
                        // actually fired.
                        if s.sleep_timer_ends_ms.is_some_and(|t| now_ms() >= t) {
                            s.sleep_timer_ends_ms = None;
                            let _ = s.save(&state.settings_path);
                            let _ = app.emit("settings", s.clone());
                        }
                    }
                }
            }
            let energy = {
                let prev = *state.last_energy.lock().unwrap_or_else(|e| e.into_inner());
                let next = if state.demo {
                    synthetic_energy(&np, &prev)
                } else {
                    // Real PCM tap from the playback source; empty while
                    // nothing local plays so the UI rests honestly (OS-level
                    // loopback capture is still the roadmap item).
                    let (samples, rate) = state
                        .rodio
                        .as_ref()
                        .map(|r| r.tap_take())
                        .unwrap_or_default();
                    let mut det = match state.beat.lock() {
                        Ok(d) => d,
                        Err(_) => continue,
                    };
                    if rate != 0 && det.sample_rate() != rate {
                        *det = BeatDetector::new(rate);
                    }
                    if samples.is_empty() {
                        // Nothing playing (or paused): feed silence so the
                        // spectrum decays to rest instead of freezing.
                        det.push(&[0.0f32; 1024])
                    } else {
                        det.push(&samples)
                    }
                };
                *state.last_energy.lock().unwrap_or_else(|e| e.into_inner()) = next;
                next
            };
            if let Ok(mut t) = state.listen.lock() {
                t.update(&np, tick_ms, &state.history, &state.history_path);
            }
            let _ = app.emit("now-playing", &np);
            let _ = app.emit("energy", energy);
            flush_hud_position(&app);
            flush_desk_lyrics_position(&app);
        }
    });
}

pub fn run() {
    let demo = std::env::var("NOCTBEAT_DEMO").is_ok();
    let source: Box<dyn NowPlayingSource> = if demo {
        Box::new(DemoSource::new())
    } else {
        noctbeat_core::media::platform_source()
    };

    let dir = config_dir();
    let settings_path = dir.join("settings.json");
    let settings = Settings::load(&settings_path);
    // Tag reader drops embedded artwork here for the UI to file://.
    std::env::set_var("NOCTBEAT_ART_DIR", dir.join("art"));
    let rodio = audio::RodioOut::open_named(settings.audio_output.as_deref())
        .or_else(audio::RodioOut::open_default)
        .map(std::sync::Arc::new);
    let audio_out: std::sync::Arc<dyn noctbeat_core::player::AudioOut> = match rodio.clone() {
        Some(out) => out,
        None => std::sync::Arc::new(noctbeat_core::player::NullAudio::new()),
    };
    let settings_arc = std::sync::Arc::new(Mutex::new(settings.clone()));
    let remote_map: std::sync::Arc<Mutex<std::collections::HashMap<String, RemoteTrack>>> =
        std::sync::Arc::new(Mutex::new(std::collections::HashMap::new()));
    let stream_cache = dir.join("streams");
    let mut local_player = LocalPlayer::new(audio_out);
    {
        // Resolves `remote:<source>:<id>` queue paths to downloaded files
        // in the streams cache; everything else passes through unchanged.
        let map = remote_map.clone();
        let settings = settings_arc.clone();
        let cache = stream_cache.clone();
        local_player.set_resolver(Box::new(move |item| {
            let Some(key) = item.path.strip_prefix("remote:") else {
                return Ok(item.path.clone());
            };
            resolve_remote(&map, &settings, &cache, key).map(|f| f.display().to_string())
        }));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            source: Mutex::new(source),
            player: Mutex::new(local_player),
            settings: settings_arc,
            settings_path: settings_path.clone(),
            beat: Mutex::new(BeatDetector::new(48_000)),
            last_energy: Mutex::new(EnergyUpdate {
                level: 0.0,
                beat: false,
                bpm: None,
                bands: [0.0; noctbeat_core::energy::BANDS],
            }),
            lyrics: Mutex::new(None),
            lyrics_cache: LyricsCache::new(
                dir.join("lyrics"),
                std::time::Duration::from_secs(7 * 24 * 3600),
            ),
            license_path: dir.join("license.json"),
            history: Mutex::new(History::load(&dir.join("history.json"))),
            history_path: dir.join("history.json"),
            listen: Mutex::new(ListenTracker::default()),
            hud_pos_pending: Mutex::new(None),
            desk_lyrics_pos_pending: Mutex::new(None),
            rodio,
            remote: remote_map,
            stream_cache,
            prefetching: std::sync::Arc::new(Mutex::new(std::collections::HashSet::new())),
            demo,
        })
        .invoke_handler(tauri::generate_handler![
            get_now_playing,
            media_control,
            get_palette,
            get_lyrics,
            get_lyrics_index,
            get_settings,
            update_settings,
            get_license_state,
            activate_license,
            get_energy,
            list_displays,
            set_hud_pinned,
            hud_start_drag,
            desk_lyrics_start_drag,
            show_player,
            toggle_fullscreen,
            seek,
            set_volume,
            get_queue,
            play_queue_index,
            clear_queue,
            set_shuffle,
            get_shuffle,
            set_repeat,
            get_repeat,
            get_volume,
            scan_library,
            provider_status,
            provider_search,
            provider_play,
            resolve_video,
            list_outputs,
            set_output_device,
            set_eq,
            save_profile,
            apply_profile,
            delete_profile,
            set_sleep_timer,
            import_playlist,
            import_playlist_url,
            get_stats,
            get_wrapped,
            clear_history,
        ])
        .setup(move |app| {
            spawn_poller(app.handle());
            let state = app.state::<AppState>();
            if let Some(rodio) = &state.rodio {
                if let Ok(s) = state.settings.lock() {
                    rodio.eq().set(&s.eq_bands);
                }
            }
            let s = state.settings.lock().map_err(|e| e.to_string())?.clone();
            sync_edge_windows(app.handle(), &s);
            sync_hud_window(app.handle(), &s);
            sync_desk_lyrics_window(app.handle(), &s);
            build_tray(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Noctbeat")
        .run(|app, event| {
            // Any exit path (last window closed, tray quit) persists the
            // in-flight play before the process dies.
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                if let Ok(mut t) = state.listen.lock() {
                    t.flush(&state.history, &state.history_path);
                };
            }
        });
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let hud = MenuItem::with_id(app, "hud", "Floating HUD", true, None::<&str>)?;
    let dlyrics = MenuItem::with_id(app, "dlyrics", "Desktop lyrics", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &settings, &hud, &dlyrics, &quit])?;
    let icon = app.default_window_icon().cloned().unwrap_or_else(|| {
        tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")).expect("icon")
    });
    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                if let Some(w) = app.get_webview_window("player") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "settings" => {
                if let Some(w) = app.get_webview_window("player") {
                    let _ = w.show();
                    let _ = w.eval("location.hash = '#/settings'");
                }
            }
            "hud" => {
                let state = app.state::<AppState>();
                if let Ok(mut s) = state.settings.lock() {
                    s.hud_enabled = !s.hud_enabled;
                    let s = s.clone();
                    let _ = s.save(&state.settings_path);
                    sync_hud_window(app, &s);
                    let _ = app.emit("settings", s);
                };
            }
            "dlyrics" => {
                let state = app.state::<AppState>();
                if let Ok(mut s) = state.settings.lock() {
                    s.desk_lyrics_enabled = !s.desk_lyrics_enabled;
                    let s = s.clone();
                    let _ = s.save(&state.settings_path);
                    sync_desk_lyrics_window(app, &s);
                    let _ = app.emit("settings", s);
                };
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}
