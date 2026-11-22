//! Noctbeat Tauri shell: thin adapter over noctbeat-core.
//! Commands/event names are the contract in docs/CONTRACT.md.

use noctbeat_core::energy::{BeatDetector, EnergyUpdate};
use noctbeat_core::history::{play_threshold_ms, History, PlayRecord, Stats, Wrapped};
use noctbeat_core::licensing::{Http, LicenseClient, LicenseState, UreqHttp};
use noctbeat_core::listen::{self, SyncAction};
use noctbeat_core::lyrics::{active_line, LrcLine, LrclibClient, LyricsCache};
use noctbeat_core::media::{
    now_ms, Control, DemoSource, NowPlaying, NowPlayingSource, PlaybackStatus, Track,
};
use noctbeat_core::palette::{extract_palette_bytes, Palette, Rgb};
use noctbeat_core::player::{LocalPlayer, QueueItem, RepeatMode};

mod audio;
mod discord;
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
    /// Discord Rich Presence client (idle unless a client id is configured).
    discord: Mutex<discord::DiscordRpc>,
    /// Listen Along host (None unless the user started a session).
    listen_host: Mutex<Option<AnyHost>>,
    /// Listen Along follower (None unless joined to a host's session).
    listen_follower: Mutex<Option<listen::Follower>>,
    /// Host track we already reported as unmatchable — avoids rescanning
    /// the library every sync tick.
    listen_missing: Mutex<Option<String>>,
    /// Last listen status emitted; the event only fires on change.
    listen_emitted: Mutex<String>,
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

/// The local player claims the transport while it is playing or paused;
/// otherwise whatever the OS reports (Spotify, browser, …) wins.
fn local_active(state: &AppState) -> bool {
    let Ok(p) = state.player.lock() else {
        return false;
    };
    if p.status() != PlaybackStatus::Stopped {
        return true;
    }
    if p.queue().is_empty() {
        return false;
    }
    // Stopped but holding a queue: claim the transport only when the
    // external source isn't reporting playback — Play then starts the
    // local queue instead of being routed away, without hijacking an
    // actively playing Spotify/browser session.
    drop(p);
    state
        .source
        .lock()
        .ok()
        .and_then(|mut s| s.poll().ok())
        .map(|np| np.status == PlaybackStatus::Stopped)
        .unwrap_or(true)
}

fn poll_np(state: &AppState) -> NowPlaying {
    if local_active(state) {
        if let Ok(mut p) = state.player.lock() {
            if let Ok(np) = p.poll() {
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

/// Browser-extension bridge status for the provider picker: how many
/// music tabs are reporting right now and which provider host is active.
/// None when the running source has no extension layer (demo mode).
#[derive(serde::Serialize)]
struct ExtStatus {
    tabs: usize,
    provider: Option<String>,
    providers: Vec<String>,
}

#[tauri::command]
fn system_accent() -> Option<String> {
    read_system_accent()
}

#[cfg(target_os = "windows")]
fn read_system_accent() -> Option<String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\DWM",
            "/v",
            "AccentColor",
        ])
        .creation_flags(0x0800_0000)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let hex = text.split_whitespace().find(|w| w.starts_with("0x"))?;
    let v = u32::from_str_radix(&hex[2..], 16).ok()?;
    // DWORD is 0xAABBGGRR
    Some(format!(
        "#{:02x}{:02x}{:02x}",
        v & 0xff,
        (v >> 8) & 0xff,
        (v >> 16) & 0xff
    ))
}

#[cfg(target_os = "macos")]
fn read_system_accent() -> Option<String> {
    let out = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleAccentColor"])
        .output()
        .ok()?;
    // Key absent = "Multicolor", which renders as blue.
    let code = if out.status.success() {
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse::<i32>()
            .unwrap_or(4)
    } else {
        4
    };
    let hex = match code {
        -1 => "#8e8e93",
        0 => "#ff453a",
        1 => "#ff9f0a",
        2 => "#ffd60a",
        3 => "#32d74b",
        5 => "#bf5af2",
        6 => "#ff375f",
        _ => "#0a84ff",
    };
    Some(hex.to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn read_system_accent() -> Option<String> {
    None
}

#[tauri::command]
fn get_ext_status(state: State<AppState>) -> Result<Option<ExtStatus>, String> {
    let s = state.source.lock().map_err(|e| e.to_string())?;
    let providers = s.ext_providers();
    Ok(s.ext_status().map(|(tabs, provider)| ExtStatus {
        tabs,
        provider,
        providers,
    }))
}

/// Search `query` in the user's open `provider` tab and play the first hit.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogSong {
    title: String,
    artist: String,
    album: String,
    duration_ms: u64,
    artwork_url: String,
}

/// Song metadata for the Spotify-style search results (Apple's public
/// iTunes Search API: free, keyless). Playback is resolved separately
/// through the chosen provider.
#[tauri::command]
async fn catalog_search(query: String) -> Result<Vec<CatalogSong>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let v: serde_json::Value = ureq::get("https://itunes.apple.com/search")
            .query("term", &query)
            .query("media", "music")
            .query("entity", "song")
            .query("limit", "30")
            .timeout(std::time::Duration::from_secs(8))
            .call()
            .map_err(|e| e.to_string())?
            .into_string()
            .map_err(|e| e.to_string())
            .and_then(|b| serde_json::from_str(&b).map_err(|e| e.to_string()))?;
        let s = |r: &serde_json::Value, k: &str| r[k].as_str().unwrap_or_default().to_string();
        Ok(v["results"]
            .as_array()
            .map(|a| a.as_slice())
            .unwrap_or_default()
            .iter()
            .map(|r| CatalogSong {
                title: s(r, "trackName"),
                artist: s(r, "artistName"),
                album: s(r, "collectionName"),
                duration_ms: r["trackTimeMillis"].as_u64().unwrap_or(0),
                artwork_url: s(r, "artworkUrl100").replace("100x100bb", "300x300bb"),
            })
            .filter(|c| !c.title.is_empty())
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Official YouTube embed of the video playing in the user's tab, for the
/// stage backdrop. None for other providers and local files.
#[tauri::command]
fn ext_video(
    state: State<AppState>,
    artist: String,
    title: String,
) -> Result<Option<String>, String> {
    let id = state
        .source
        .lock()
        .map_err(|e| e.to_string())?
        .ext_video_id(&artist, &title);
    Ok(id.map(|id| {
        format!(
            "https://www.youtube.com/embed/{id}?enablejsapi=1&rel=0&modestbranding=1&playsinline=1&controls=0&iv_load_policy=3&mute=1"
        )
    }))
}

#[tauri::command]
fn ext_play(state: State<AppState>, provider: String, query: String) -> Result<bool, String> {
    let sent = state
        .source
        .lock()
        .map_err(|e| e.to_string())?
        .play_in_tab(&provider, &query);
    // The tab takes over: silence the local player so audio and transport
    // don't stay attached to the local queue.
    if sent {
        if let Ok(mut p) = state.player.lock() {
            if p.status() != PlaybackStatus::Stopped {
                p.stop();
            }
        }
    }
    Ok(sent)
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

/// Async: opening/decoding the next file must not run on the IPC thread.
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
fn set_speed(state: State<AppState>, speed: f32) -> Result<(), String> {
    state
        .player
        .lock()
        .map_err(|e| e.to_string())?
        .set_speed(speed);
    Ok(())
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
    // Older sessions can hold `remote:` stream entries, which no longer
    // play; drop them and keep the cursor on the same local track.
    let is_remote = |i: &QueueItem| i.path.starts_with("remote:");
    let index = s
        .index
        .filter(|&i| s.items.get(i).is_some_and(|it| !is_remote(it)))
        .map(|i| i - s.items[..i].iter().filter(|it| is_remote(it)).count());
    let items: Vec<QueueItem> = s.items.into_iter().filter(|i| !is_remote(i)).collect();
    if items.is_empty() {
        return;
    }
    let position_ms = if index.is_some() { s.position_ms } else { 0 };
    if let Ok(mut p) = state.player.lock() {
        p.restore(items, index, position_ms, s.repeat, s.shuffle);
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
    state
        .player
        .lock()
        .map_err(|e| e.to_string())?
        .play_index(index)?;
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

/// Append local files (from a webview drag & drop) to the queue,
/// deduped by path. Folders are expanded one level deep — a dropped
/// album folder should enqueue, not be skipped. Returns how many
/// tracks were added.
#[tauri::command]
fn enqueue_files(
    app: tauri::AppHandle,
    state: State<AppState>,
    paths: Vec<String>,
) -> Result<u32, String> {
    let mut files: Vec<PathBuf> = Vec::new();
    for raw in &paths {
        let p = PathBuf::from(raw);
        if p.is_dir() {
            if let Ok(rd) = std::fs::read_dir(&p) {
                let mut dir_files: Vec<PathBuf> = rd
                    .flatten()
                    .map(|e| e.path())
                    .filter(|f| f.is_file() && noctbeat_core::library::is_audio(f))
                    .collect();
                dir_files.sort();
                files.extend(dir_files);
            }
        } else if p.is_file() && noctbeat_core::library::is_audio(&p) {
            files.push(p);
        }
    }
    let mut added = 0u32;
    {
        let mut player = state.player.lock().map_err(|e| e.to_string())?;
        for path in files {
            let name = path.to_string_lossy().into_owned();
            if player.queue().iter().any(|i| i.path == name) {
                continue;
            }
            let item = QueueItem {
                track: noctbeat_core::library::tag_track(&path),
                path: name,
            };
            player.add(item);
            added += 1;
        }
    }
    emit_queue(&app, &state);
    Ok(added)
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
    // First-run zero-config: fall back to the conventional ~/Music folder so
    // scanning works before the user ever opens Settings.
    let dir = dir.or_else(default_music_dir);
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

/// The conventional per-user music folder, when it exists (`~/Music`).
fn default_music_dir() -> Option<String> {
    let d = std::env::home_dir()?.join("Music");
    d.is_dir().then(|| d.display().to_string())
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
    {
        let mut p = state.player.lock().map_err(|e| e.to_string())?;
        p.set_queue(items);
        p.play_index(index)?;
    }
    emit_queue(&app, &state);
    Ok(())
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
#[serde(rename_all = "camelCase")]
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

/// Guard for the playlist-management commands: resolve `path` (a
/// display string from `list_playlists`) back to the real discovered
/// file. Display names are lossy — non-UTF-8 bytes become `�` — so the
/// incoming string is only a lookup key, never a filesystem path: an
/// `a\xFF.m3u8` and a literal `a�.m3u8` collapse to the same display
/// string, and acting on the string could hit the wrong file. No match
/// or more than one → refuse; exactly one → act on the discovered
/// `PathBuf` (the real bytes).
fn playlist_path_checked(
    state: &State<AppState>,
    path: &str,
) -> Result<std::path::PathBuf, String> {
    let dir = resolve_music_dir(state, None)?;
    let matches: Vec<std::path::PathBuf> =
        noctbeat_core::playlists::list(std::path::Path::new(&dir))
            .into_iter()
            .filter(|p| p.to_string_lossy() == path)
            .collect();
    match matches.as_slice() {
        // Make it absolute without resolving links — `parse`'s base dir
        // must be absolute so relative entries don't double-prefix on
        // rewrite, but canonicalize would point delete/rename at the
        // symlink's target instead of the link itself.
        [one] => std::path::absolute(one).map_err(|e| e.to_string()),
        [] => Err("not a playlist in the music folder".into()),
        _ => Err("name isn't representable — rename it in a file manager first".into()),
    }
}

#[tauri::command]
fn delete_playlist(state: State<AppState>, path: String) -> Result<(), String> {
    let file = playlist_path_checked(&state, &path)?;
    std::fs::remove_file(&file).map_err(|e| e.to_string())
}

/// Rename keeps the original extension; the new file stays in the same
/// directory (the guard above) so only the stem changes.
#[tauri::command]
fn rename_playlist(
    state: State<AppState>,
    path: String,
    name: String,
) -> Result<PlaylistFile, String> {
    let file = playlist_path_checked(&state, &path)?;
    let name = name.trim();
    // `:` is banned on Windows only — `C:Name` parses drive-relative and
    // `:` isn't a valid filename char there anyway — while names like
    // "Live: 2025" are fine on Unix.
    if name.is_empty()
        || name.contains(['/', '\\'])
        || name.starts_with('.')
        || (cfg!(windows) && name.contains(':'))
    {
        return Err("invalid playlist name".into());
    }
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("m3u8");
    let target = file.with_file_name(format!("{name}.{ext}"));
    // Whatever the platform read into the name, the destination must
    // stay beside the original file.
    if target.parent() != file.parent() {
        return Err("invalid playlist name".into());
    }
    // symlink_metadata sees dangling links that Path::exists misses —
    // renaming onto one would silently replace it.
    if target.symlink_metadata().is_ok() {
        return Err("a playlist with that name already exists".into());
    }
    std::fs::rename(&file, &target).map_err(|e| e.to_string())?;
    Ok(PlaylistFile {
        name: name.to_string(),
        path: target.to_string_lossy().into_owned(),
    })
}

/// One row of a playlist opened for editing: display metadata, the
/// resolved path, and whether it is a remote stream URL.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistTrack {
    title: String,
    artist: String,
    duration_ms: u64,
    path: String,
    remote: bool,
}

/// Contents of a discovered playlist file, one row per entry, in order.
/// Remote URLs are included (marked `remote`) so a removal index always
/// lines up with what the file actually lists.
#[tauri::command]
fn playlist_tracks(state: State<AppState>, path: String) -> Result<Vec<PlaylistTrack>, String> {
    let file = playlist_path_checked(&state, &path)?;
    let content = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    Ok(noctbeat_core::playlists::parse(&file, &content)
        .iter()
        .map(|e| match e {
            noctbeat_core::playlists::PlaylistEntry::File {
                path,
                title,
                artist,
                duration_ms,
            } => PlaylistTrack {
                title: title.clone().unwrap_or_default(),
                artist: artist.clone().unwrap_or_default(),
                duration_ms: duration_ms.unwrap_or(0),
                path: path.to_string_lossy().into_owned(),
                remote: false,
            },
            noctbeat_core::playlists::PlaylistEntry::Remote(url) => PlaylistTrack {
                title: String::new(),
                artist: String::new(),
                duration_ms: 0,
                path: url.clone(),
                remote: true,
            },
        })
        .collect())
}

/// Editing rewrites the file as extended M3U, so only .m3u/.m3u8 are
/// writable; .pls and .xspf would lose their format (and metadata the
/// M3U serializer can't express).
fn m3u_editable(file: &std::path::Path) -> Result<(), String> {
    match file
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("m3u") | Some("m3u8") => Ok(()),
        _ => Err("editing works on .m3u/.m3u8 playlists".into()),
    }
}

/// Serialize entries back to `file` as extended M3U. Remote rows keep
/// their URL as the path (no metadata to preserve).
fn rewrite_playlist(
    file: &std::path::Path,
    entries: &[noctbeat_core::playlists::PlaylistEntry],
) -> Result<(), String> {
    let items: Vec<noctbeat_core::playlists::M3uItem> = entries
        .iter()
        .map(|e| match e {
            noctbeat_core::playlists::PlaylistEntry::File {
                path,
                title,
                artist,
                duration_ms,
            } => noctbeat_core::playlists::M3uItem {
                path: path.to_string_lossy().into_owned(),
                title: title.clone().unwrap_or_default(),
                artist: artist.clone().unwrap_or_default(),
                duration_ms: duration_ms.unwrap_or(0),
            },
            noctbeat_core::playlists::PlaylistEntry::Remote(url) => {
                noctbeat_core::playlists::M3uItem {
                    path: url.clone(),
                    title: String::new(),
                    artist: String::new(),
                    duration_ms: 0,
                }
            }
        })
        .collect();
    // Write-then-rename: a failed `write` (e.g. full disk) would leave
    // the original truncated, so stage the new content in a sibling
    // file and swap it in atomically. `create_new` (O_EXCL) picks a
    // name that cannot clobber an existing file — a fixed tmp name
    // could silently destroy an unrelated sibling.
    let body = noctbeat_core::playlists::write_m3u(&items);
    let stem = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "playlist".into());
    let mut tmp = None;
    for n in 0..100u32 {
        let candidate = file.with_file_name(format!(".{stem}.noctbeat-tmp{n}"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut f) => {
                use std::io::Write;
                if let Err(e) = f.write_all(body.as_bytes()) {
                    let _ = std::fs::remove_file(&candidate);
                    return Err(format!("write {}: {e}", candidate.display()));
                }
                tmp = Some(candidate);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("write {}: {e}", candidate.display())),
        }
    }
    let tmp = tmp.ok_or_else(|| "no free temp name beside the playlist".to_string())?;
    std::fs::rename(&tmp, file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("write {}: {e}", file.display())
    })
}

/// Drop the entry at `index` from a playlist and rewrite it in place.
/// The index counts every entry (files and remote rows) exactly as
/// `playlist_tracks` lists them.
#[tauri::command]
fn playlist_remove_track(state: State<AppState>, path: String, index: u32) -> Result<(), String> {
    let file = playlist_path_checked(&state, &path)?;
    m3u_editable(&file)?;
    let content = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let mut entries = noctbeat_core::playlists::parse(&file, &content);
    let i = index as usize;
    if i >= entries.len() {
        return Err("track index out of range".into());
    }
    entries.remove(i);
    rewrite_playlist(&file, &entries)
}

/// Append local files to a playlist and rewrite it. Returns how many
/// entries were added — paths that aren't real files are skipped (a
/// stale queue item or a `remote:` pseudo-path must not land in the
/// file, where it would import back as a broken row).
#[tauri::command]
fn playlist_add_tracks(
    state: State<AppState>,
    path: String,
    paths: Vec<String>,
) -> Result<u32, String> {
    let file = playlist_path_checked(&state, &path)?;
    m3u_editable(&file)?;
    let content = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let mut entries = noctbeat_core::playlists::parse(&file, &content);
    let mut added = 0u32;
    for p in paths {
        // Same anchoring as export: relative queue paths resolve against
        // the launch cwd so the row imports back correctly later.
        let abs = match std::fs::canonicalize(&p) {
            Ok(c) => c,
            Err(_) => {
                let rel = std::path::Path::new(&p);
                if rel.is_absolute() {
                    rel.to_path_buf()
                } else {
                    match std::env::current_dir() {
                        Ok(cwd) => cwd.join(rel),
                        Err(_) => continue,
                    }
                }
            }
        };
        if !abs.is_file() {
            continue;
        }
        let track = noctbeat_core::library::tag_track(&abs);
        entries.push(noctbeat_core::playlists::PlaylistEntry::File {
            path: abs,
            title: (!track.title.is_empty()).then_some(track.title),
            artist: (!track.artist.is_empty()).then_some(track.artist),
            duration_ms: (track.duration_ms > 0).then_some(track.duration_ms),
        });
        added += 1;
    }
    if added == 0 {
        return Err("no local files to add".into());
    }
    rewrite_playlist(&file, &entries)?;
    Ok(added)
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

/// Switch the live sound-FX mode (off/reverb/8d/echo) and persist it.
#[tauri::command]
fn set_fx(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    if let Some(rodio) = &state.rodio {
        rodio.fx().set(&mode);
    }
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    s.sound_fx = noctbeat_core::fx::mode_name(noctbeat_core::fx::mode_from_name(&mode)).into();
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

/// Write the current theme (preset + manual accents + dynamic flag) as a
/// shareable .nbtheme JSON — the seed of the theme marketplace.
#[tauri::command]
fn export_theme(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let s = state.settings.lock().map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&s.theme).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Parse + validate a theme file. Accents must be hex colors or null; a
/// bad file is rejected instead of silently mangling the look.
#[tauri::command]
fn import_theme(path: String) -> Result<noctbeat_core::settings::ThemeSettings, String> {
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let t: noctbeat_core::settings::ThemeSettings =
        serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let hex = |c: &Option<String>| {
        c.as_ref()
            .map(|v| {
                v.starts_with('#')
                    && matches!(v.len(), 4 | 7 | 9)
                    && v[1..].chars().all(|c| c.is_ascii_hexdigit())
            })
            .unwrap_or(true)
    };
    if !hex(&t.accent) || !hex(&t.accent2) || t.name.is_empty() || t.name.len() > 40 {
        return Err("invalid theme file".into());
    }
    Ok(t)
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
    sync_hud_window(&app, &incoming);
    sync_desk_lyrics_window(&app, &incoming);
    state
        .player
        .lock()
        .map_err(|e| e.to_string())?
        .set_crossfade_ms(incoming.crossfade_ms);
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

/// Begin an OS-native drag of the main player window (mousedown on empty
/// glass areas — the window is borderless so there's no titlebar).
#[tauri::command]
fn player_start_drag(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("player") {
        win.start_dragging().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Bring the full player window forward (HUD expand button / tray Open).
/// The player and the HUD never coexist: showing the player turns the
/// HUD off (the settings flag is updated so nothing resurrects it).
#[tauri::command]
fn show_player(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut s = state.settings.lock().map_err(|e| e.to_string())?;
        if s.hud_enabled {
            s.hud_enabled = false;
            s.save(&state.settings_path).map_err(|e| e.to_string())?;
            let _ = app.emit("settings", s.clone());
        }
        sync_hud_window(&app, &s);
    }
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
    let _ = app.emit("fullscreen", on);
    Ok(on)
}

/// Whether the player window is currently fullscreen — the UI keeps its
/// route in sync with the real OS state (Esc / green button included).
#[tauri::command]
fn window_is_fullscreen(app: tauri::AppHandle) -> Result<bool, String> {
    let win = app.get_webview_window("player").ok_or("no player window")?;
    win.is_fullscreen().map_err(|e| e.to_string())
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
    open_in_system(&url)
}

/// Opens only the bundled bridge folder, ready for "Load unpacked".
#[tauri::command]
fn open_extension_folder(app: tauri::AppHandle) -> Result<(), String> {
    // Resources declared as "../extension" bundle under "_up_/extension" in
    // packaged apps; dev and side-by-side layouts keep plain "extension".
    let folder = ["extension", "_up_/extension"]
        .iter()
        .filter_map(|dir| {
            app.path()
                .resolve(dir, tauri::path::BaseDirectory::Resource)
                .ok()
        })
        .find(|folder| folder.join("manifest.json").is_file())
        .ok_or("The bundled browser extension could not be found.".to_string())?;
    open_in_system(folder.to_str().ok_or("Invalid extension folder path")?)
}

fn open_in_system(url: &str) -> Result<(), String> {
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

/// Floating HUD pill: borderless, transparent, draggable anywhere, optionally
/// pinned above other windows. Position persists via the Moved event.
fn sync_hud_window(app: &tauri::AppHandle, settings: &Settings) {
    // HUD and player are exclusive surfaces: while the HUD lives, the
    // player window stays hidden (its transport keeps working — this is
    // the same playback, just a smaller remote for it).
    if let Some(win) = app.get_webview_window("hud") {
        if settings.hud_enabled {
            let _ = win.set_always_on_top(settings.hud_always_on_top);
            let _ = win.show();
            if let Some(player) = app.get_webview_window("player") {
                let _ = player.hide();
            }
        } else {
            let _ = win.close();
            if let Some(player) = app.get_webview_window("player") {
                let _ = player.show();
            }
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
    .effects(
        tauri::window::EffectsBuilder::new()
            .effects(vec![
                tauri::window::Effect::HudWindow,
                tauri::window::Effect::Acrylic,
            ])
            .state(tauri::window::EffectState::Active)
            .radius(18.0)
            .build(),
    )
    .always_on_top(settings.hud_always_on_top)
    .skip_taskbar(true)
    .resizable(true)
    .min_inner_size(260.0, 140.0)
    .inner_size(340.0, 470.0);
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
        // The HUD owns the screen now — tuck the player window away.
        if let Some(player) = app.get_webview_window("player") {
            let _ = player.hide();
        }
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
    .effects(
        tauri::window::EffectsBuilder::new()
            .effects(vec![
                tauri::window::Effect::HudWindow,
                tauri::window::Effect::Acrylic,
            ])
            .state(tauri::window::EffectState::Active)
            .radius(18.0)
            .build(),
    )
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

// ---- Listen Along --------------------------------------------------------

/// A hosting session on either transport: LAN (`Host`) or WAN relay
/// (`RelayHost`). The status and publish paths are identical.
enum AnyHost {
    Lan(listen::Host),
    Wan(listen::RelayHost),
}

impl AnyHost {
    fn publish(&self, np: &NowPlaying) {
        match self {
            Self::Lan(h) => h.publish(np),
            Self::Wan(h) => h.publish(np),
        }
    }
    fn share_url(&self) -> Option<String> {
        match self {
            Self::Lan(h) => h.share_url(),
            Self::Wan(h) => h.share_url(),
        }
    }
    fn name(&self) -> String {
        match self {
            Self::Lan(h) => h.name(),
            Self::Wan(h) => h.name(),
        }
    }
    fn peers(&self) -> usize {
        match self {
            Self::Lan(h) => h.peers(),
            Self::Wan(h) => h.peers(),
        }
    }
    fn last_error(&self) -> Option<String> {
        match self {
            Self::Lan(_) => None,
            Self::Wan(h) => h.last_error(),
        }
    }
}

fn listen_status_of(state: &AppState) -> listen::ListenStatus {
    let mut st = listen::ListenStatus::default();
    if let Ok(h) = state.listen_host.lock() {
        if let Some(h) = h.as_ref() {
            st.hosting = true;
            st.host_addr = h.share_url();
            st.host_name = Some(h.name());
            st.peers = h.peers();
            st.last_error = h.last_error();
        }
    }
    if let Ok(f) = state.listen_follower.lock() {
        if let Some(f) = f.as_ref() {
            st.following = Some(if f.addr.contains("://") {
                f.addr.clone()
            } else {
                format!("http://{}", f.addr)
            });
            st.host_name = f.host_name().or(st.host_name);
            st.last_error = f.last_error();
        }
    }
    if let Ok(m) = state.listen_missing.lock() {
        st.missing_track = m.clone().map(|k| k.replace('|', " — "));
    }
    st
}

#[tauri::command]
fn listen_status(state: State<AppState>) -> listen::ListenStatus {
    listen_status_of(&state)
}

/// Start hosting: friends on the same network join the share address.
/// Hosting and following are mutually exclusive — a host plays, it doesn't
/// mirror someone else's.
#[tauri::command]
fn listen_host_start(
    state: State<AppState>,
    name: Option<String>,
    web: Option<bool>,
) -> Result<listen::ListenStatus, String> {
    let name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_else(|| "Noctbeat".into());
    let host = if web.unwrap_or(false) {
        let relay = std::env::var("NOCTBEAT_RELAY")
            .ok()
            .filter(|r| !r.trim().is_empty())
            .unwrap_or_else(|| listen::DEFAULT_RELAY.to_string());
        AnyHost::Wan(
            listen::RelayHost::start(&relay, name)
                .ok_or_else(|| "could not start the web session (bad relay URL)".to_string())?,
        )
    } else {
        AnyHost::Lan(
            listen::Host::start(name, listen::LISTEN_PORT)
                .ok_or_else(|| "could not start the session (port busy?)".to_string())?,
        )
    };
    *state.listen_host.lock().map_err(|e| e.to_string())? = Some(host);
    *state.listen_follower.lock().map_err(|e| e.to_string())? = None;
    *state.listen_missing.lock().map_err(|e| e.to_string())? = None;
    Ok(listen_status_of(&state))
}

#[tauri::command]
fn listen_host_stop(state: State<AppState>) -> listen::ListenStatus {
    if let Ok(mut h) = state.listen_host.lock() {
        *h = None;
    }
    listen_status_of(&state)
}

/// Join a host session by address (`ip`, `ip:port` or the `http://…/<key>`
/// share URL). Fails fast when the host is unreachable or the key is wrong.
/// Async so the connect probe never blocks the IPC thread.
#[tauri::command]
async fn listen_join(
    state: State<'_, AppState>,
    addr: String,
) -> Result<listen::ListenStatus, String> {
    let f = listen::Follower::join(&addr)?;
    *state.listen_follower.lock().map_err(|e| e.to_string())? = Some(f);
    *state.listen_host.lock().map_err(|e| e.to_string())? = None;
    *state.listen_missing.lock().map_err(|e| e.to_string())? = None;
    Ok(listen_status_of(&state))
}

#[tauri::command]
fn listen_leave(state: State<AppState>) -> listen::ListenStatus {
    if let Ok(mut f) = state.listen_follower.lock() {
        *f = None;
    }
    if let Ok(mut m) = state.listen_missing.lock() {
        *m = None;
    }
    listen_status_of(&state)
}

/// Follower convergence, run at ~1Hz from the poller: locate the host's
/// track in the local queue (then the library), seek on drift, mirror
/// play/pause.
fn apply_listen_sync(app: &tauri::AppHandle, state: &State<AppState>, local: &NowPlaying) {
    let Some(bcast) = state
        .listen_follower
        .lock()
        .ok()
        .and_then(|f| f.as_ref().and_then(|f| f.latest()))
    else {
        return;
    };
    match listen::sync_decision(&bcast, Some(local), listen::DRIFT_MS) {
        SyncAction::Nothing => {}
        SyncAction::Seek(pos) => {
            if let Ok(mut p) = state.player.lock() {
                // Stopped (queue ended on this track): reload it, then land
                // on the host position — a seek alone can't restart audio.
                if p.status() == PlaybackStatus::Stopped {
                    let i = p.current_index().unwrap_or(0);
                    let _ = p.play_index(i);
                }
                let _ = p.seek(pos);
            }
        }
        SyncAction::Pause => {
            if let Ok(mut p) = state.player.lock() {
                if p.status() == PlaybackStatus::Playing {
                    let _ = p.control(Control::PlayPause);
                }
            }
        }
        SyncAction::Resume => {
            if let Ok(mut p) = state.player.lock() {
                match p.status() {
                    PlaybackStatus::Paused => {
                        let _ = p.control(Control::PlayPause);
                    }
                    PlaybackStatus::Stopped => {
                        let i = p.current_index().unwrap_or(0);
                        let _ = p.play_index(i);
                    }
                    _ => {}
                }
            }
        }
        SyncAction::FindTrack {
            title,
            artist,
            position_ms,
            playing,
        } => {
            let key = format!("{}|{}", title, artist);
            // The queue is cheap; a full library scan only runs once per
            // unmatched track (listens_missing caches the failure).
            let mut player = match state.player.lock() {
                Ok(p) => p,
                Err(_) => return,
            };
            let want = (listen::norm(&title), listen::norm(&artist));
            let idx = player.queue().iter().position(|it| {
                listen::norm(&it.track.title) == want.0 && listen::norm(&it.track.artist) == want.1
            });
            let idx = match idx {
                Some(i) => Some(i),
                None => {
                    let already = state
                        .listen_missing
                        .lock()
                        .map(|m| m.as_deref() == Some(key.as_str()))
                        .unwrap_or(false);
                    if already {
                        None
                    } else {
                        // One scan per unmatched track: the match is then
                        // enqueued so the follower's queue stays intact.
                        let item = resolve_music_dir(state, None)
                            .ok()
                            .map(|d| noctbeat_core::library::scan(std::path::Path::new(&d)))
                            .unwrap_or_default()
                            .into_iter()
                            .find(|it| {
                                listen::norm(&it.track.title) == want.0
                                    && listen::norm(&it.track.artist) == want.1
                            });
                        match item {
                            Some(it) => {
                                player.add(it);
                                Some(player.queue().len() - 1)
                            }
                            None => {
                                if let Ok(mut m) = state.listen_missing.lock() {
                                    *m = Some(key.clone());
                                }
                                let _ = app.emit("listen", &listen_status_of(state));
                                None
                            }
                        }
                    }
                }
            };
            if let Some(i) = idx {
                if player
                    .queue()
                    .get(i)
                    .map(|it| {
                        it.track.id
                            != local
                                .track
                                .as_ref()
                                .map(|t| t.id.clone())
                                .unwrap_or_default()
                    })
                    .unwrap_or(false)
                {
                    let _ = player.play_index(i);
                }
                let _ = player.seek(position_ms);
                if !playing && player.status() == PlaybackStatus::Playing {
                    let _ = player.control(Control::PlayPause);
                }
                if let Ok(mut m) = state.listen_missing.lock() {
                    if m.as_deref() == Some(key.as_str()) {
                        *m = None;
                    }
                }
            }
        }
    }
}

fn spawn_poller(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut ticks = 0u64;
        let mut last_tick = std::time::Instant::now();
        let mut last_fs = false;
        let mut last_qidx: Option<usize> = None;
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
            // Discord Rich Presence mirrors the same snapshot (no-op unless
            // a client id is configured and the toggle is on).
            {
                let rpc_on = state
                    .settings
                    .lock()
                    .map(|s| s.discord_rpc)
                    .unwrap_or(false);
                if let Ok(mut rpc) = state.discord.lock() {
                    rpc.update(&np, rpc_on);
                }
            }
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
            // Listen Along: hosts publish the snapshot; followers converge
            // on the host's track/position ~once a second.
            {
                if let Ok(h) = state.listen_host.lock() {
                    if let Some(h) = h.as_ref() {
                        h.publish(&np);
                    }
                }
                if ticks.is_multiple_of(5) {
                    apply_listen_sync(&app, &state, &np);
                }
                if ticks.is_multiple_of(10) {
                    let st = listen_status_of(&state);
                    let fp = serde_json::to_string(&st).unwrap_or_default();
                    let mut e = state.listen_emitted.lock().unwrap();
                    if *e != fp {
                        *e = fp;
                        let _ = app.emit("listen", &st);
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
            // Next/Prev and natural advance move the queue cursor without a
            // queue mutation: re-emit so panels keep the highlight current.
            let qidx = state.player.lock().ok().and_then(|p| p.current_index());
            let fs_now = app
                .get_webview_window("player")
                .and_then(|w| w.is_fullscreen().ok())
                .unwrap_or(false);
            if fs_now != last_fs {
                last_fs = fs_now;
                let _ = app.emit("fullscreen", fs_now);
            }
            if qidx != last_qidx {
                last_qidx = qidx;
                emit_queue(&app, &state);
            }
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
    let mut local_player = LocalPlayer::new(audio_out);
    local_player.set_crossfade_ms(settings.crossfade_ms);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    use tauri_plugin_global_shortcut::Code;
                    let cmd = match shortcut.key {
                        Code::MediaPlayPause => Control::PlayPause,
                        Code::MediaTrackNext | Code::MediaFastForward => Control::Next,
                        Code::MediaTrackPrevious | Code::MediaRewind => Control::Previous,
                        _ => return,
                    };
                    // Keep the hotkey thread free while the next file opens.
                    let app = app.clone();
                    std::thread::spawn(move || {
                        let state = app.state::<AppState>();
                        // While another app owns playback (Spotify, a
                        // browser) the OS already routes the media key
                        // to its session — forwarding it again through
                        // the source would toggle it twice, cancelling
                        // out. Hotkeys only drive our own player.
                        if local_active(&state) {
                            let _ = media_control_inner(&state, cmd);
                        }
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
            listen_host: Mutex::new(None),
            listen_follower: Mutex::new(None),
            listen_missing: Mutex::new(None),
            listen_emitted: Mutex::new(String::new()),
            hud_pos_pending: Mutex::new(None),
            desk_lyrics_pos_pending: Mutex::new(None),
            rodio,
            discord: Mutex::new(discord::DiscordRpc::new(
                &noctbeat_core::branding::branding().discord_client_id,
            )),
            tray: Mutex::new(None),
            tray_default: Mutex::new(None),
            tray_dyn: std::sync::Arc::new(Mutex::new(TrayDyn::default())),
            #[cfg(target_os = "linux")]
            mpris: std::sync::OnceLock::new(),
            demo,
        })
        .invoke_handler(tauri::generate_handler![
            get_now_playing,
            get_ext_status,
            system_accent,
            ext_play,
            ext_video,
            catalog_search,
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
            open_extension_folder,
            set_hud_pinned,
            hud_start_drag,
            desk_lyrics_start_drag,
            player_start_drag,
            show_player,
            toggle_fullscreen,
            window_is_fullscreen,
            seek,
            set_speed,
            set_volume,
            get_queue,
            play_queue_index,
            clear_queue,
            queue_remove,
            queue_move,
            enqueue_files,
            set_shuffle,
            get_shuffle,
            set_repeat,
            get_repeat,
            get_volume,
            scan_library,
            library_tracks,
            play_items,
            list_outputs,
            set_output_device,
            set_eq,
            set_fx,
            save_profile,
            apply_profile,
            export_theme,
            import_theme,
            delete_profile,
            set_sleep_timer,
            import_playlist,
            export_playlist,
            list_playlists,
            rename_playlist,
            delete_playlist,
            playlist_tracks,
            playlist_remove_track,
            playlist_add_tracks,
            get_stats,
            get_artist_stats,
            get_wrapped,
            clear_history,
            listen_status,
            listen_host_start,
            listen_host_stop,
            listen_join,
            listen_leave,
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
            // First-run zero-config: no music dir configured, ~/Music exists
            // and the queue is empty → seed it from ~/Music in the background
            // so music is on screen before Settings is ever opened.
            {
                let need_seed = state
                    .settings
                    .lock()
                    .map(|s| s.music_dir.is_none())
                    .unwrap_or(false)
                    && default_music_dir().is_some()
                    && state
                        .player
                        .lock()
                        .map(|p| p.queue().is_empty())
                        .unwrap_or(false);
                if need_seed {
                    let app = app.handle().clone();
                    std::thread::spawn(move || {
                        let state = app.state::<AppState>();
                        if let Ok(dir) = resolve_music_dir(&state, None) {
                            let items = noctbeat_core::library::scan(std::path::Path::new(&dir));
                            if !items.is_empty() {
                                if let Ok(mut p) = state.player.lock() {
                                    if p.queue().is_empty() {
                                        // No pre-selected track: the queue
                                        // shows clean until the user plays;
                                        // Play still starts track 0 through
                                        // the stopped-queue transport rule.
                                        p.set_queue(items);
                                    }
                                }
                                emit_queue(&app, &state);
                            }
                        }
                    });
                }
            }
            if let Some(rodio) = &state.rodio {
                if let Ok(s) = state.settings.lock() {
                    rodio.eq().set(&s.eq_bands);
                    rodio.fx().set(&s.sound_fx);
                }
            }
            let s = state.settings.lock().map_err(|e| e.to_string())?.clone();
            sync_hud_window(app.handle(), &s);
            sync_desk_lyrics_window(app.handle(), &s);
            // The player is the only recoverable window: closing it must
            // hide (HUD/tray can reopen), never destroy — a destroyed
            // player takes the whole app down and leaves no way back.
            if let Some(player) = app.get_webview_window("player") {
                let p2 = player.clone();
                player.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = p2.hide();
                    }
                });
            }
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

/// Tray menu events run on the main thread; bounce next/prev to a worker
/// thread — same reason `media_control` is an async command.
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
    let mut registered = 0usize;
    for code in [
        Code::MediaPlayPause,
        Code::MediaTrackNext,
        Code::MediaTrackPrevious,
        // Some keyboards emit Fast/Rewind for track skips instead of
        // Next/Previous — bind both so those keys work too.
        Code::MediaFastForward,
        Code::MediaRewind,
    ] {
        // Another app may already hold a key (Spotify, a browser):
        // skip that binding instead of failing startup.
        if app
            .global_shortcut()
            .register(Shortcut::new(None, code))
            .is_ok()
        {
            registered += 1;
        }
    }
    // On macOS every registration fails without Accessibility access —
    // say so once instead of leaving dead shortcuts unexplained.
    #[cfg(target_os = "macos")]
    if registered == 0 {
        eprintln!(
            "media keys unavailable: grant Noctbeat Accessibility access in \
             System Settings → Privacy & Security → Accessibility"
        );
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
                // show_player clears hud_enabled first — otherwise the next
                // settings save re-hides the player under the HUD.
                let _ = show_player(app.clone());
            }
            "playpause" => tray_media_control(app, Control::PlayPause),
            "next" => tray_media_control(app, Control::Next),
            "prev" => tray_media_control(app, Control::Previous),
            "settings" => {
                let _ = show_player(app.clone());
                if let Some(w) = app.get_webview_window("player") {
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
