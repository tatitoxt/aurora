//! Noctbeat Tauri shell: thin adapter over noctbeat-core.
//! Commands/event names are the contract in docs/CONTRACT.md.

use noctbeat_core::energy::{BeatDetector, EnergyUpdate};
use noctbeat_core::licensing::{Http, LicenseClient, LicenseState, UreqHttp};
use noctbeat_core::lyrics::{active_line, LrcLine, LrclibClient, LyricsCache};
use noctbeat_core::media::{now_ms, Control, DemoSource, NowPlaying, NowPlayingSource};
use noctbeat_core::palette::{extract_palette_bytes, Palette};
use noctbeat_core::settings::Settings;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

struct AppState {
    source: Mutex<Box<dyn NowPlayingSource>>,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    beat: Mutex<BeatDetector>,
    last_energy: Mutex<EnergyUpdate>,
    lyrics: Mutex<Option<(String, Vec<LrcLine>)>>,
    lyrics_cache: LyricsCache,
    license_path: PathBuf,
    demo: bool,
}

fn config_dir() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(&noctbeat_core::branding::branding().short_name)
}

#[tauri::command]
fn get_now_playing(state: State<AppState>) -> Result<NowPlaying, String> {
    state
        .source
        .lock()
        .map_err(|e| e.to_string())?
        .poll()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn media_control(state: State<AppState>, cmd: Control) -> Result<(), String> {
    state
        .source
        .lock()
        .map_err(|e| e.to_string())?
        .control(cmd)
        .map_err(|e| e.to_string())
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
    settings
        .save(&state.settings_path)
        .map_err(|e| e.to_string())?;
    *state.settings.lock().map_err(|e| e.to_string())? = settings.clone();
    sync_edge_windows(&app, &settings);
    sync_hud_window(&app, &settings);
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
    let mut builder = tauri::WebviewWindowBuilder::new(
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
    if let Some((x, y)) = settings.hud_position {
        builder = builder.position(x as f64, y as f64);
    }
    if let Ok(win) = builder.build() {
        let app2 = app.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::Moved(pos) = event {
                let state = app2.state::<AppState>();
                if let Ok(mut s) = state.settings.lock() {
                    if s.hud_position != Some((pos.x, pos.y)) {
                        s.hud_position = Some((pos.x, pos.y));
                        let _ = s.save(&state.settings_path);
                    }
                };
            }
        });
    }
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
                let mut src = match state.source.lock() {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                if !state.demo && src.name() == "null" && ticks.is_multiple_of(25) {
                    *src = noctbeat_core::media::platform_source();
                }
                src.poll().unwrap_or(NowPlaying {
                    track: None,
                    status: noctbeat_core::media::PlaybackStatus::Stopped,
                    position_ms: 0,
                    updated_at_ms: now_ms(),
                })
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

    tauri::Builder::default()
        .manage(AppState {
            source: Mutex::new(source),
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
            show_player,
        ])
        .setup(move |app| {
            spawn_poller(app.handle());
            let state = app.state::<AppState>();
            let s = state.settings.lock().map_err(|e| e.to_string())?.clone();
            sync_edge_windows(app.handle(), &s);
            sync_hud_window(app.handle(), &s);
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
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &settings, &hud, &quit])?;
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
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}
