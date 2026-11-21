//! Noctbeat Tauri shell: thin adapter over noctbeat-core.
//! Commands/event names are the contract in docs/CONTRACT.md.

use noctbeat_core::energy::{BeatDetector, EnergyUpdate};
use noctbeat_core::licensing::{Http, LicenseClient, LicenseState, UreqHttp};
use noctbeat_core::lyrics::{active_line, LrcLine, LrclibClient, LyricsCache};
use noctbeat_core::media::{
    now_ms, Control, DemoSource, NowPlaying, NowPlayingSource, PlaybackStatus, Track,
};
use noctbeat_core::palette::{extract_palette_bytes, Palette};
use noctbeat_core::player::{LocalPlayer, QueueItem};
use noctbeat_core::providers::{RemoteTrack, YtDlp};

mod audio;
use noctbeat_core::settings::Settings;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

struct AppState {
    source: Mutex<Box<dyn NowPlayingSource>>,
    /// In-app player for local files; wins over `source` while active.
    player: Mutex<LocalPlayer>,
    settings: Mutex<Settings>,
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
    demo: bool,
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
    state
        .player
        .lock()
        .map(|p| p.status() != PlaybackStatus::Stopped)
        .unwrap_or(false)
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

#[tauri::command]
fn media_control(state: State<AppState>, cmd: Control) -> Result<(), String> {
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

#[derive(Serialize)]
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

#[tauri::command]
fn play_queue_index(state: State<AppState>, index: usize) -> Result<(), String> {
    state
        .player
        .lock()
        .map_err(|e| e.to_string())?
        .play_index(index)
}

#[tauri::command]
fn clear_queue(state: State<AppState>) -> Result<(), String> {
    state.player.lock().map_err(|e| e.to_string())?.clear();
    Ok(())
}

/// Scan `dir` (or the configured music dir) and replace the play queue.
#[tauri::command]
fn scan_library(state: State<AppState>, dir: Option<String>) -> Result<Vec<QueueItem>, String> {
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
fn import_playlist(state: State<AppState>, path: String) -> Result<ImportResult, String> {
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
    Ok(res)
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
    {
        let mut guard = state.settings.lock().map_err(|e| e.to_string())?;
        settings
            .save(&state.settings_path)
            .map_err(|e| e.to_string())?;
        *guard = settings.clone();
    }
    sync_edge_windows(&app, &settings);
    sync_hud_window(&app, &settings);
    sync_desk_lyrics_window(&app, &settings);
    let _ = app.emit("settings", settings);
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

/// Synthetic energy for demo/fallback: tempo-synced pulses while playing.
/// Real loopback capture plugs into the same `last_energy` sink later.
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
            EnergyUpdate {
                level,
                beat,
                bpm: Some(120.0),
            }
        }
        _ => EnergyUpdate {
            level: prev.level * 0.9,
            beat: false,
            bpm: prev.bpm,
        },
    }
}

fn spawn_poller(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut ticks = 0u64;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            ticks += 1;
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
            let energy = {
                let prev = *state.last_energy.lock().unwrap_or_else(|e| e.into_inner());
                let next = if state.demo {
                    synthetic_energy(&np, &prev)
                } else {
                    let mut det = match state.beat.lock() {
                        Ok(d) => d,
                        Err(_) => continue,
                    };
                    // No capture source yet (see README: platform capture roadmap);
                    // keep the detector fed with silence so the UI rests honestly.
                    det.push(&[0.0f32; 1024])
                };
                *state.last_energy.lock().unwrap_or_else(|e| e.into_inner()) = next;
                next
            };
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

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            source: Mutex::new(source),
            player: Mutex::new(LocalPlayer::new(audio_out)),
            settings: Mutex::new(settings.clone()),
            settings_path: settings_path.clone(),
            beat: Mutex::new(BeatDetector::new(48_000)),
            last_energy: Mutex::new(EnergyUpdate {
                level: 0.0,
                beat: false,
                bpm: None,
            }),
            lyrics: Mutex::new(None),
            lyrics_cache: LyricsCache::new(
                dir.join("lyrics"),
                std::time::Duration::from_secs(7 * 24 * 3600),
            ),
            license_path: dir.join("license.json"),
            hud_pos_pending: Mutex::new(None),
            desk_lyrics_pos_pending: Mutex::new(None),
            rodio,
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
            seek,
            set_volume,
            get_queue,
            play_queue_index,
            clear_queue,
            scan_library,
            provider_status,
            provider_search,
            provider_play,
            resolve_video,
            list_outputs,
            set_output_device,
            set_eq,
            import_playlist,
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
        .run(tauri::generate_context!())
        .expect("error while running Noctbeat");
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
