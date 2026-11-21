//! Noctbeat Tauri shell: thin adapter over noctbeat-core.
//! Commands/event names are the contract in docs/CONTRACT.md.

use noctbeat_core::energy::{BeatDetector, EnergyUpdate};
use noctbeat_core::history::{play_threshold_ms, History, PlayRecord, Stats, Wrapped};
use noctbeat_core::licensing::{Http, LicenseClient, LicenseState, UreqHttp};
use noctbeat_core::lyrics::{active_line, LrcLine, LrclibClient, LyricsCache};
use noctbeat_core::media::{
    now_ms, Control, DemoSource, NowPlaying, NowPlayingSource, PlaybackStatus, Track,
};
use noctbeat_core::palette::{extract_palette_bytes, Palette, Rgb};
use noctbeat_core::player::{LocalPlayer, QueueItem, RepeatMode};
use noctbeat_core::providers::{self, RemoteTrack, YtDlp};

mod audio;
#[cfg(target_os = "linux")]
mod mpris;
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
    /// Linux MPRIS server (media keys / DE widgets), set up in `setup`.
    #[cfg(target_os = "linux")]
    mpris: std::sync::OnceLock<mpris::MprisHandle>,
    history_path: PathBuf,
    /// session.json beside settings: queue + position for resume-on-launch.
    session_path: PathBuf,
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
    /// Tray icon handle for the live cover + beat ring (iBaila-style).
    tray: Mutex<Option<tauri::tray::TrayIcon>>,
    /// Bundled icon restored when the live icon is disabled.
    tray_default: Mutex<Option<tauri::image::Image<'static>>>,
    /// Arc-shared so the artwork fetch thread can store into it.
    tray_dyn: std::sync::Arc<Mutex<TrayDyn>>,
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
    let rt = map.lock().map_err(|e| e.to_string())?.get(key).cloned();
    let Some(rt) = rt else {
        // A restored queue can reference a remote track whose metadata
        // is gone; the cache name derives from the key alone, so a
        // downloaded file still plays.
        let (source, id) = key
            .split_once(':')
            .ok_or_else(|| format!("unknown remote track {key}"))?;
        let name = format!(
            "{source}-{}",
            id.replace(|c: char| !c.is_alphanumeric(), "_")
        );
        return providers::cached_file(cache, &name)
            .ok_or_else(|| format!("unknown remote track {key}"));
    };
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

/// Per-artist totals + full ranked track list (unlike stats()' top-10).
#[tauri::command]
fn get_artist_stats(
    state: State<AppState>,
    artist: String,
) -> Result<noctbeat_core::history::ArtistStats, String> {
    let h = state.history.lock().map_err(|e| e.to_string())?;
    Ok(h.artist_stats(&artist))
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

/// Transport routing shared by the IPC command, the tray menu and
/// global hotkeys: the local player when it holds the queue, the
/// external source otherwise.
fn media_control_inner(state: &AppState, cmd: Control) -> Result<(), String> {
    if local_active(state) {
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

/// Async: a play/pause/next that lands on an uncached remote track can
/// block for a yt-dlp download — that must happen on the runtime pool,
/// not the IPC thread.
#[tauri::command]
async fn media_control(state: State<'_, AppState>, cmd: Control) -> Result<(), String> {
    media_control_inner(&state, cmd)
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

/// Last local playback context, persisted so the next launch can offer
/// "Continue Playing" paused where the user left off.
#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionState {
    items: Vec<QueueItem>,
    index: Option<usize>,
    position_ms: u64,
    repeat: RepeatMode,
    shuffle: bool,
    /// Remote metadata for `remote:` queue paths, so a relaunched app
    /// can resolve them even if they were never cached.
    #[serde(default)]
    remote: std::collections::HashMap<String, RemoteTrack>,
}

/// Write the player's queue + cursor + position to session.json; an
/// empty queue removes the file (nothing to continue).
fn write_session(state: &AppState) {
    let Ok(p) = state.player.lock() else { return };
    let (items, index, position_ms, repeat, shuffle) = p.session();
    if items.is_empty() {
        let _ = std::fs::remove_file(&state.session_path);
        return;
    }
    let session = SessionState {
        items: items.to_vec(),
        index,
        position_ms,
        repeat,
        shuffle,
        remote: state.remote.lock().map(|m| m.clone()).unwrap_or_default(),
    };
    if let Ok(json) = serde_json::to_string(&session) {
        let _ = std::fs::write(&state.session_path, json);
    }
}

/// Restore the saved session paused at its position — no file or
/// stream is opened until the user presses play.
fn restore_session(state: &AppState) {
    let resume = state
        .settings
        .lock()
        .map(|s| s.resume_on_launch)
        .unwrap_or(false);
    if !resume {
        return;
    }
    let Ok(text) = std::fs::read_to_string(&state.session_path) else {
        return;
    };
    let Ok(s) = serde_json::from_str::<SessionState>(&text) else {
        return;
    };
    if s.items.is_empty() {
        return;
    }
    // Repopulate resolver metadata first — the resolver rejects remote
    // keys it doesn't know, even for files already in the cache.
    if let Ok(mut m) = state.remote.lock() {
        m.extend(s.remote);
    }
    if let Ok(mut p) = state.player.lock() {
        p.restore(s.items, s.index, s.position_ms, s.repeat, s.shuffle);
    }
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

/// Remove a queued track; removing the selected one is rejected.
#[tauri::command]
fn queue_remove(app: tauri::AppHandle, state: State<AppState>, index: usize) -> Result<(), String> {
    state
        .player
        .lock()
        .map_err(|e| e.to_string())?
        .remove(index)?;
    emit_queue(&app, &state);
    Ok(())
}

/// Reorder the queue, keeping the cursor on the same track.
#[tauri::command]
fn queue_move(
    app: tauri::AppHandle,
    state: State<AppState>,
    from: usize,
    to: usize,
) -> Result<(), String> {
    state
        .player
        .lock()
        .map_err(|e| e.to_string())?
        .move_item(from, to)?;
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

/// Resolve the music dir: explicit `dir`, else `settings.music_dir`,
/// expanding a leading `~`. Error strings are shown to the user.
fn resolve_music_dir(state: &State<AppState>, dir: Option<String>) -> Result<String, String> {
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
    if !std::path::Path::new(&dir).is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    Ok(dir)
}

/// Scan `dir` (or the configured music dir) and replace the play queue.
#[tauri::command]
fn scan_library(
    app: tauri::AppHandle,
    state: State<AppState>,
    dir: Option<String>,
) -> Result<Vec<QueueItem>, String> {
    let items =
        noctbeat_core::library::scan(std::path::Path::new(&resolve_music_dir(&state, dir)?));
    state
        .player
        .lock()
        .map_err(|e| e.to_string())?
        .set_queue(items.clone());
    emit_queue(&app, &state);
    Ok(items)
}

/// Read-only scan: returns the library without replacing the queue
/// (artist/album views browse without clobbering playback).
#[tauri::command]
fn library_tracks(state: State<AppState>, dir: Option<String>) -> Result<Vec<QueueItem>, String> {
    Ok(noctbeat_core::library::scan(std::path::Path::new(
        &resolve_music_dir(&state, dir)?,
    )))
}

/// Replace the queue with `items` and start playing `index`
/// (artist/album context play — the queue becomes that track list).
#[tauri::command]
async fn play_items(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    items: Vec<QueueItem>,
    index: usize,
) -> Result<(), String> {
    if index >= items.len() {
        return Err(format!("no item at index {index}"));
    }
    // Resolve a remote item before taking the player lock (same rule as
    // play_queue_index).
    if let Some(key) = items[index].path.strip_prefix("remote:").map(str::to_owned) {
        resolve_remote(&state.remote, &state.settings, &state.stream_cache, &key)?;
    }
    {
        let mut p = state.player.lock().map_err(|e| e.to_string())?;
        p.set_queue(items);
        p.play_index(index)?;
    }
    prefetch_next(&state, index);
    emit_queue(&app, &state);
    Ok(())
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

/// Outcome of `export_playlist`: where the .m3u8 landed, how many local
/// tracks were written and how many remote items were skipped.
#[derive(serde::Serialize)]
struct ExportResult {
    path: String,
    exported: u32,
    skipped_remote: u32,
}

/// Save the current queue as an extended M3U (`<music dir>/<name>.m3u8`).
/// `name` is reduced to a safe file stem; an existing file gets `-2`,
/// `-3`, … appended. Remote (not-yet-downloaded) items can't round-trip
/// through a local playlist and are skipped.
#[tauri::command]
fn export_playlist(state: State<AppState>, name: String) -> Result<ExportResult, String> {
    let dir = resolve_music_dir(&state, None)?;
    let stem = std::path::Path::new(name.trim())
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("playlist");
    let stem: String = stem
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || " _-()".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let stem = if stem.is_empty() {
        "playlist"
    } else {
        stem.as_str()
    };
    let dir_path = std::path::Path::new(&dir);
    let mut file = dir_path.join(format!("{stem}.m3u8"));
    let mut n = 2u32;
    while file.exists() {
        file = dir_path.join(format!("{stem}-{n}.m3u8"));
        n += 1;
    }
    let player = state.player.lock().map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    let mut skipped = 0u32;
    for it in player.queue() {
        if it.path.starts_with("remote:") {
            skipped += 1;
            continue;
        }
        // Playlists land in the music dir, but queue paths can be relative
        // to the launch cwd — anchor them absolute so reimport resolves
        // against the playlist's own directory-independent location.
        let path = match std::fs::canonicalize(&it.path) {
            Ok(p) => p.to_string_lossy().into_owned(),
            Err(_) => {
                let p = std::path::Path::new(&it.path);
                if p.is_absolute() {
                    it.path.clone()
                } else {
                    std::env::current_dir()
                        .map(|cwd| cwd.join(p).to_string_lossy().into_owned())
                        .unwrap_or_else(|_| it.path.clone())
                }
            }
        };
        items.push(noctbeat_core::playlists::M3uItem {
            path,
            title: it.track.title.clone(),
            artist: it.track.artist.clone(),
            duration_ms: it.track.duration_ms,
        });
    }
    if items.is_empty() {
        return Err("nothing to export — the queue has no local tracks".into());
    }
    let exported = items.len() as u32;
    std::fs::write(&file, noctbeat_core::playlists::write_m3u(&items))
        .map_err(|e| format!("write {}: {e}", file.display()))?;
    Ok(ExportResult {
        path: file.to_string_lossy().into_owned(),
        exported,
        skipped_remote: skipped,
    })
}

/// One playlist file discovered in the music folder.
#[derive(serde::Serialize)]
struct PlaylistFile {
    name: String,
    path: String,
}

/// Playlist files sitting at the top level of the configured music dir.
#[tauri::command]
fn list_playlists(state: State<AppState>) -> Result<Vec<PlaylistFile>, String> {
    let dir = resolve_music_dir(&state, None)?;
    Ok(noctbeat_core::playlists::list(std::path::Path::new(&dir))
        .into_iter()
        .map(|p| PlaylistFile {
            name: p
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| p.to_string_lossy().into_owned()),
            path: p.to_string_lossy().into_owned(),
        })
        .collect())
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
async fn deactivate_license(state: State<'_, AppState>) -> Result<LicenseState, String> {
    let http = UreqHttp;
    license_client(&http, &state)
        .deactivate()
        .map_err(|e| format!("could not remove stored license: {e}"))?;
    Ok(LicenseState::Unlicensed)
}

/// Open an external https:// URL in the system browser (e.g. the checkout
/// link). Refuses non-http schemes so the UI can't hand us `file:`/`shell:`.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("refusing non-http url".into());
    }
    #[cfg(target_os = "linux")]
    let r = std::process::Command::new("xdg-open").arg(&url).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn();
    match r {
        Ok(mut child) => {
            // Reap the launcher so exited helpers don't linger as zombies.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn get_energy(state: State<AppState>) -> Result<EnergyUpdate, String> {
    Ok(*state.last_energy.lock().map_err(|e| e.to_string())?)
}

/// True while any system battery is discharging. The edge auto-dim polls
/// this because WebKit/WKWebView webviews lack `navigator.getBattery`.
#[tauri::command]
fn on_battery() -> bool {
    system_on_battery()
}

#[cfg(target_os = "linux")]
fn system_on_battery() -> bool {
    let Ok(rd) = std::fs::read_dir("/sys/class/power_supply") else {
        return false;
    };
    rd.flatten().any(|e| {
        // Only the system battery dims: peripheral entries (hidpp_*,
        // xpadneo_*, ...) also report type "Battery" and discharging status.
        // scope is absent on many fuel-gauge drivers (cw2015, rk817), so
        // fall back to excluding known peripheral name prefixes.
        let name = e.file_name().to_string_lossy().to_lowercase();
        let peripheral = ["hid", "xpadneo", "bluez", "sony_controller", "devc_"]
            .iter()
            .any(|p| name.starts_with(p));
        let system = std::fs::read_to_string(e.path().join("scope"))
            .map(|s| s.trim().eq_ignore_ascii_case("system"))
            .unwrap_or(!peripheral);
        system
            && std::fs::read_to_string(e.path().join("type"))
                .map(|t| t.trim() == "Battery")
                .unwrap_or(false)
            && std::fs::read_to_string(e.path().join("status"))
                .map(|s| s.trim() == "Discharging")
                .unwrap_or(false)
    })
}

#[cfg(target_os = "macos")]
fn system_on_battery() -> bool {
    std::process::Command::new("pmset")
        .args(["-g", "batt"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("'Battery Power'"))
        .unwrap_or(false)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn system_on_battery() -> bool {
    false
}

/// True while another application owns a fullscreen window. The edge hides
/// then; own windows (e.g. the fullscreen player) are excluded by pid.
/// Async so the per-OS subprocess probes never stall Tauri's event thread.
#[tauri::command]
async fn fullscreen_app_active() -> bool {
    system_fullscreen_app_active()
}

#[cfg(target_os = "linux")]
fn system_fullscreen_app_active() -> bool {
    // X11 only; Wayland gives no cross-app window state, so report false.
    if std::env::var_os("DISPLAY").is_none() {
        return false;
    }
    let out = std::process::Command::new("xprop")
        .args(["-root", "_NET_ACTIVE_WINDOW"])
        .output();
    let Ok(out) = out else { return false };
    let text = String::from_utf8_lossy(&out.stdout);
    // "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3c00007"
    let id = text.split('#').nth(1).map(str::trim).unwrap_or("");
    if id.is_empty() || id == "0x0" {
        return false;
    }
    let own = std::process::id().to_string();
    let mine = std::process::Command::new("xprop")
        .args(["-id", id, "_NET_WM_PID"])
        .output()
        .map(|o| {
            // "_NET_WM_PID(CARDINAL) = 2698" — exact match, not substring
            // (a foreign pid containing ours must not self-exclude).
            String::from_utf8_lossy(&o.stdout)
                .rsplit('=')
                .next()
                .map(str::trim)
                == Some(own.as_str())
        })
        .unwrap_or(false);
    if mine {
        return false;
    }
    std::process::Command::new("xprop")
        .args(["-id", id, "_NET_WM_STATE"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("_NET_WM_STATE_FULLSCREEN"))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn system_fullscreen_app_active() -> bool {
    // Foreground window covering its whole monitor = fullscreen; maximized
    // windows stop at the taskbar so they do not match. Shell windows and
    // our own pid are excluded. Prints "1" or "0".
    let script = format!(
        r#"$own={}
$sig=@'
using System;
using System.Runtime.InteropServices;
public static class U32 {{
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern long GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MI i);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  public struct RECT {{ public int Left, Top, Right, Bottom; }}
  public struct MI {{ public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint flags; }}
}}
'@
Add-Type -TypeDefinition $sig
$h=[U32]::GetForegroundWindow()
if($h -eq [IntPtr]::Zero){{'0';exit}}
$p=[uint32]0;[void][U32]::GetWindowThreadProcessId($h,[ref]$p)
if($p -eq $own){{'0';exit}}
$cls=New-Object System.Text.StringBuilder 256;[void][U32]::GetClassName($h,$cls,256)
if(@('Progman','WorkerW','Shell_TrayWnd','Shell_SecondaryTrayWnd') -contains $cls.ToString()){{'0';exit}}
$wr=New-Object U32+RECT;[void][U32]::GetWindowRect($h,[ref]$wr)
$mi=New-Object U32+MI;$mi.cbSize=[Runtime.InteropServices.Marshal]::SizeOf([U32+MI])
[void][U32]::GetMonitorInfo([U32]::MonitorFromWindow($h,2),[ref]$mi)
$covers=$wr.Left -le $mi.rcMonitor.Left -and $wr.Top -le $mi.rcMonitor.Top -and $wr.Right -ge $mi.rcMonitor.Right -and $wr.Bottom -ge $mi.rcMonitor.Bottom
# A maximized window on a taskbar-free monitor also covers it; real
# fullscreen windows strip WS_CAPTION (0x00C00000).
$borderless=([U32]::GetWindowLongPtr($h,-16) -band 0xC00000L) -eq 0
if($covers -and $borderless){{'1'}}else{{'0'}}"#,
        std::process::id()
    );
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "1")
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn system_fullscreen_app_active() -> bool {
    // AXFullScreen on the frontmost process needs accessibility permission;
    // any error means "cannot determine" -> false, never hide on a guess.
    std::process::Command::new("osascript")
        .args([
            "-e",
            "tell application \"System Events\"",
            "-e",
            "set p to first process whose frontmost is true",
            "-e",
            &format!(
                "if unix id of p is {} then return false",
                std::process::id()
            ),
            "-e",
            "if (count of windows of p) is 0 then return false",
            "-e",
            "try",
            "-e",
            "return value of attribute \"AXFullScreen\" of window 1 of p",
            "-e",
            "on error",
            "-e",
            "return false",
            "-e",
            "end try",
            "-e",
            "end tell",
        ])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn system_fullscreen_app_active() -> bool {
    false
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

const TRAY_SIZE: u32 = 64;

/// Live tray icon state: decoded cover + accent + the inputs of the last
/// render, so `set_icon` only runs when the ring would visibly change.
#[derive(Default)]
struct TrayDyn {
    /// (artwork url, 64x64 cover-cropped pixels, dominant accent)
    art: Option<(String, image::RgbaImage, Rgb)>,
    /// Artwork url with a fetch already in flight.
    pending: Option<String>,
    /// Artwork url that failed to fetch or decode; not retried while the
    /// track stays the same, or a broken cover would re-download every tick.
    failed: Option<String>,
    last_bucket: u32,
    last_level: u8,
    last_playing: Option<bool>,
    last_art_url: String,
    last_had_art: bool,
    last_tip: String,
    using_live: bool,
}

/// iBaila-style live tray icon: the cover with an accent ring that fills
/// with progress and brightens on the beat. Artwork fetch+decode runs on a
/// side thread so an http fetch never stalls the poller.
fn update_tray(state: &AppState, np: &NowPlaying, energy: &EnergyUpdate) {
    let live = state
        .settings
        .lock()
        .map(|s| s.tray_live_icon)
        .unwrap_or(true);
    let Ok(tray_guard) = state.tray.lock() else {
        return;
    };
    let Some(tray) = tray_guard.as_ref() else {
        return;
    };
    let Ok(default_icon) = state.tray_default.lock().map(|d| d.clone()) else {
        return;
    };

    let playing = np.status == PlaybackStatus::Playing;
    let art_url = np
        .track
        .as_ref()
        .map(|t| t.artwork_url.clone())
        .unwrap_or_default();

    {
        let Ok(mut d) = state.tray_dyn.lock() else {
            return;
        };
        if !art_url.is_empty()
            && d.art.as_ref().map(|a| a.0 != art_url).unwrap_or(true)
            && d.pending.as_deref() != Some(art_url.as_str())
            && d.failed.as_deref() != Some(art_url.as_str())
        {
            d.pending = Some(art_url.clone());
            let dyn2 = state.tray_dyn.clone();
            let url = art_url.clone();
            std::thread::spawn(move || {
                let art = fetch_artwork(&url).ok().and_then(|bytes| {
                    let img = image::load_from_memory(&bytes).ok()?;
                    let accent = extract_palette_bytes(&bytes)
                        .map(|p| p.dominant)
                        .unwrap_or(Rgb(150, 120, 255));
                    let side = img.width().min(img.height());
                    let cropped = image::imageops::crop_imm(
                        &img.to_rgba8(),
                        (img.width() - side) / 2,
                        (img.height() - side) / 2,
                        side,
                        side,
                    )
                    .to_image();
                    let px = image::imageops::resize(
                        &cropped,
                        TRAY_SIZE,
                        TRAY_SIZE,
                        image::imageops::FilterType::Triangle,
                    );
                    Some((url.clone(), px, accent))
                });
                if let Ok(mut d) = dyn2.lock() {
                    if d.pending.as_deref() == Some(url.as_str()) {
                        d.pending = None;
                    }
                    match art {
                        Some(art) => d.art = Some(art),
                        None => d.failed = Some(url),
                    }
                }
            });
        }

        let tip = np
            .track
            .as_ref()
            .map(|t| {
                format!(
                    "{} — {} · {}",
                    noctbeat_core::branding::branding().short_name,
                    t.title,
                    t.artist
                )
            })
            .unwrap_or_else(|| noctbeat_core::branding::branding().short_name.clone());
        if tip != d.last_tip {
            let _ = tray.set_tooltip(Some(tip.as_str()));
            d.last_tip = tip;
        }

        if !live {
            if d.using_live || d.last_playing.is_none() {
                if let Some(icon) = default_icon {
                    let _ = tray.set_icon(Some(icon));
                }
                d.using_live = false;
                d.last_playing = None;
            }
            return;
        }

        let progress = np
            .track
            .as_ref()
            .filter(|t| t.duration_ms > 0)
            .map(|t| (np.position_ms as f32 / t.duration_ms as f32).clamp(0.0, 1.0))
            .unwrap_or(0.0);
        // Never paint the previous track's cover under the new track's
        // progress: art counts only while its url matches the live track.
        let art = d.art.as_ref().filter(|a| a.0 == art_url);
        let has_art = art.is_some();
        let level_q = (energy.level.clamp(0.0, 1.0) * 16.0) as u8;
        let bucket = (progress * 64.0) as u32;
        let changed = bucket != d.last_bucket
            || level_q != d.last_level
            || d.last_playing != Some(playing)
            || d.last_art_url != art_url
            || d.last_had_art != has_art;
        if !changed {
            return;
        }
        let icon = compose_tray_icon(art.map(|a| (&a.1, a.2)), progress, energy.level, playing);
        let _ = tray.set_icon(Some(icon));
        d.using_live = true;
        d.last_bucket = bucket;
        d.last_level = level_q;
        d.last_playing = Some(playing);
        d.last_art_url = art_url;
        d.last_had_art = has_art;
    }
}

/// 64x64 RGBA: circular cover inside a ring whose arc fills with playback
/// progress (top, clockwise) and whose lit section brightens with energy.
fn compose_tray_icon(
    art: Option<(&image::RgbaImage, Rgb)>,
    progress: f32,
    level: f32,
    playing: bool,
) -> tauri::image::Image<'static> {
    const S: u32 = TRAY_SIZE;
    let c = S as f32 / 2.0 - 0.5;
    let accent = art.map(|(_, a)| a).unwrap_or(Rgb(150, 120, 255));
    let art_alpha = if playing { 255 } else { 150 };
    let lit_alpha = if playing {
        (140.0 + level.clamp(0.0, 1.0) * 115.0) as u8
    } else {
        70
    };
    let mut buf = image::RgbaImage::new(S, S);
    for y in 0..S {
        for x in 0..S {
            let dx = x as f32 - c;
            let dy = y as f32 - c;
            let r = (dx * dx + dy * dy).sqrt();
            if r > 31.5 {
                continue;
            }
            if r >= 26.0 {
                let frac = ((dy.atan2(dx) + std::f32::consts::FRAC_PI_2) / std::f32::consts::TAU)
                    .rem_euclid(1.0);
                let a = if frac <= progress { lit_alpha } else { 60 };
                buf.put_pixel(x, y, image::Rgba([accent.0, accent.1, accent.2, a]));
            } else if let Some((img, _)) = art {
                let px = img.get_pixel(x, y);
                buf.put_pixel(x, y, image::Rgba([px[0], px[1], px[2], art_alpha]));
            } else {
                buf.put_pixel(x, y, image::Rgba([24, 24, 28, art_alpha]));
            }
        }
    }
    tauri::image::Image::new_owned(buf.into_raw(), S, S)
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
        let mut last_track_id: Option<String> = None;
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
            // Now Playing notification on track change while playing.
            {
                let cur_id = np.track.as_ref().map(|t| t.id.clone());
                if cur_id != last_track_id {
                    if np.status == PlaybackStatus::Playing {
                        if let Some(t) = np.track.as_ref() {
                            let notify = state
                                .settings
                                .lock()
                                .map(|s| s.notify_track_change)
                                .unwrap_or(false);
                            if notify {
                                use tauri_plugin_notification::NotificationExt;
                                let _ = app
                                    .notification()
                                    .builder()
                                    .title(&t.title)
                                    .body(&t.artist)
                                    .show();
                            }
                        }
                    }
                    last_track_id = cur_id;
                }
            }
            // Persist the local queue + position ~every 5s so the next
            // launch can offer Continue Playing (final flush on Exit).
            if ticks.is_multiple_of(25) {
                write_session(&state);
            }
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
            #[cfg(target_os = "linux")]
            if let Some(m) = state.mpris.get() {
                m.update(&np, local_active(&state));
            }
            update_tray(&state, &np, &energy);
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
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    use tauri_plugin_global_shortcut::Code;
                    let cmd = match shortcut.key {
                        Code::MediaPlayPause => Control::PlayPause,
                        Code::MediaTrackNext => Control::Next,
                        Code::MediaTrackPrevious => Control::Previous,
                        _ => return,
                    };
                    // The hotkey thread must not block on a remote
                    // resolve — same reason media_control is async.
                    let app = app.clone();
                    std::thread::spawn(move || {
                        let state = app.state::<AppState>();
                        let _ = media_control_inner(&state, cmd);
                    });
                })
                .build(),
        )
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
            session_path: dir.join("session.json"),
            listen: Mutex::new(ListenTracker::default()),
            hud_pos_pending: Mutex::new(None),
            desk_lyrics_pos_pending: Mutex::new(None),
            rodio,
            remote: remote_map,
            stream_cache,
            prefetching: std::sync::Arc::new(Mutex::new(std::collections::HashSet::new())),
            tray: Mutex::new(None),
            tray_default: Mutex::new(None),
            tray_dyn: std::sync::Arc::new(Mutex::new(TrayDyn::default())),
            #[cfg(target_os = "linux")]
            mpris: std::sync::OnceLock::new(),
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
            deactivate_license,
            open_url,
            get_energy,
            on_battery,
            fullscreen_app_active,
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
            queue_remove,
            queue_move,
            set_shuffle,
            get_shuffle,
            set_repeat,
            get_repeat,
            get_volume,
            scan_library,
            library_tracks,
            play_items,
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
            export_playlist,
            list_playlists,
            get_stats,
            get_artist_stats,
            get_wrapped,
            clear_history,
        ])
        .setup(move |app| {
            #[cfg(target_os = "linux")]
            if let Some(h) = mpris::start(app.handle()) {
                let _ = app.state::<AppState>().mpris.set(h);
            }
            let state = app.state::<AppState>();
            restore_session(&state);
            emit_queue(app.handle(), &state);
            spawn_poller(app.handle());
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
            register_media_hotkeys(app.handle());
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
                // Final position flush — the periodic save can lag a
                // few seconds behind an abrupt quit.
                write_session(&state);
            }
        });
}

/// Tray menu events run on the main thread; a next/prev that lands on an
/// uncached remote track blocks on a yt-dlp resolve, so bounce to a
/// worker thread — same reason `media_control` is an async command.
fn tray_media_control(app: &tauri::AppHandle, cmd: Control) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let _ = media_control_inner(&state, cmd);
    });
}

/// Register OS-level media keys so play/pause/next/prev work even when
/// no Noctbeat window is focused. Skipped on Linux: the MPRIS2 server
/// already delivers desktop media keys there, and grabbing the keys
/// could double-fire controls.
#[cfg(not(target_os = "linux"))]
fn register_media_hotkeys(app: &tauri::AppHandle) {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut};
    for code in [
        Code::MediaPlayPause,
        Code::MediaTrackNext,
        Code::MediaTrackPrevious,
    ] {
        // Another app may already hold a key (Spotify, a browser):
        // skip that binding instead of failing startup.
        let _ = app.global_shortcut().register(Shortcut::new(None, code));
    }
}

/// Linux uses the MPRIS2 server (started in `setup`) for media keys.
#[cfg(target_os = "linux")]
fn register_media_hotkeys(_app: &tauri::AppHandle) {}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let playpause = MenuItem::with_id(app, "playpause", "Play / Pause", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Next track", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "Previous track", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let hud = MenuItem::with_id(app, "hud", "Floating HUD", true, None::<&str>)?;
    let dlyrics = MenuItem::with_id(app, "dlyrics", "Desktop lyrics", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open, &playpause, &next, &prev, &sep, &settings, &hud, &dlyrics, &quit,
        ],
    )?;
    // Owned 'static icon: the live tray state keeps a copy to restore when
    // the live cover is disabled, and `default_window_icon` is borrowed.
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
    let default_icon = icon.clone();
    let tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                if let Some(w) = app.get_webview_window("player") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "playpause" => tray_media_control(app, Control::PlayPause),
            "next" => tray_media_control(app, Control::Next),
            "prev" => tray_media_control(app, Control::Previous),
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
    let state = app.state::<AppState>();
    if let Ok(mut t) = state.tray.lock() {
        *t = Some(tray);
    }
    if let Ok(mut d) = state.tray_default.lock() {
        *d = Some(default_icon);
    }
    Ok(())
}
