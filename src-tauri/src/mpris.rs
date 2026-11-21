//! Linux MPRIS server: publish Noctbeat's own playback as
//! `org.mpris.MediaPlayer2.noctbeat` so the desktop's media keys, taskbar
//! controls and widgets can see and drive it — the same surface the MPRIS
//! *source* watches in other players.
#![cfg(target_os = "linux")]

use std::collections::HashMap;
use std::sync::Mutex;

use noctbeat_core::media::{Control, NowPlaying, NowPlayingSource, PlaybackStatus, Track};
use noctbeat_core::player::RepeatMode;
use tauri::{AppHandle, Manager};
use zbus::blocking::connection::Builder as ConnBuilder;
use zbus::zvariant::{Dict, ObjectPath, Value};
use zbus::{fdo, interface};

use crate::AppState;

const OBJ: &str = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";
pub const BUS_NAME: &str = "org.mpris.MediaPlayer2.noctbeat";

fn status_str(s: PlaybackStatus) -> &'static str {
    match s {
        PlaybackStatus::Playing => "Playing",
        PlaybackStatus::Paused => "Paused",
        PlaybackStatus::Stopped => "Stopped",
    }
}

fn trackid(t: Option<&Track>) -> ObjectPath<'static> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    t.map(|t| &t.id).hash(&mut h);
    ObjectPath::try_from(format!("/org/noctbeat/track/{:x}", h.finish()))
        .unwrap_or_else(|_| ObjectPath::try_from("/org/noctbeat/track/0").unwrap())
}

fn metadata(t: Option<&Track>) -> HashMap<String, Value<'static>> {
    let mut m = HashMap::<String, Value>::new();
    m.insert("mpris:trackid".into(), trackid(t).into());
    if let Some(t) = t {
        m.insert("xesam:title".into(), t.title.clone().into());
        m.insert("xesam:artist".into(), vec![t.artist.clone()].into());
        if !t.album.is_empty() {
            m.insert("xesam:album".into(), t.album.clone().into());
        }
        m.insert(
            "mpris:length".into(),
            ((t.duration_ms * 1000) as i64).into(),
        );
        if !t.artwork_url.is_empty() {
            m.insert("mpris:artUrl".into(), art_url(&t.artwork_url).into());
        }
    }
    m
}

/// `mpris:artUrl` must be a URI. Local artwork is stored as a plain
/// absolute path (the webview reads it via the asset protocol); wrap it
/// in file:// with percent-encoding for bus clients.
fn art_url(raw: &str) -> String {
    if raw.contains("://") {
        return raw.to_string();
    }
    let mut s = String::from("file://");
    for &b in raw.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                s.push(b as char)
            }
            _ => {
                use std::fmt::Write;
                let _ = write!(s, "%{b:02X}");
            }
        }
    }
    s
}

fn loop_str(m: RepeatMode) -> &'static str {
    match m {
        RepeatMode::Off => "None",
        RepeatMode::All => "Playlist",
        RepeatMode::One => "Track",
    }
}

/// Root interface: window management and identity.
struct RootIface {
    app: AppHandle,
}

#[interface(name = "org.mpris.MediaPlayer2")]
impl RootIface {
    fn raise(&self) {
        if let Some(w) = self.app.get_webview_window("player") {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }

    fn quit(&self) {
        self.app.exit(0);
    }

    #[zbus(property)]
    fn can_quit(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_raise(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn has_track_list(&self) -> bool {
        false
    }

    #[zbus(property)]
    fn identity(&self) -> String {
        noctbeat_core::branding::branding().product_name.clone()
    }

    #[zbus(property)]
    fn desktop_entry(&self) -> String {
        "noctbeat".into()
    }

    #[zbus(property)]
    fn supported_uri_schemes(&self) -> Vec<String> {
        vec!["file".into()]
    }

    #[zbus(property)]
    fn supported_mime_types(&self) -> Vec<String> {
        [
            "audio/mpeg",
            "audio/flac",
            "audio/ogg",
            "audio/wav",
            "audio/mp4",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }
}

/// Transport + state interface driven by the local player.
struct PlayerIface {
    app: AppHandle,
}

impl PlayerIface {
    fn ctrl(&self, c: Control) -> fdo::Result<()> {
        let state = self.app.state::<AppState>();
        let r = state
            .player
            .lock()
            .map_err(|_| fdo::Error::Failed("player lock poisoned".into()))
            .and_then(|mut p| p.control(c).map_err(|e| fdo::Error::Failed(e.to_string())));
        r
    }

    fn with_player<R>(
        &self,
        default: R,
        f: impl FnOnce(&noctbeat_core::player::LocalPlayer) -> R,
    ) -> R {
        let state = self.app.state::<AppState>();
        let r = match state.player.lock() {
            Ok(p) => f(&p),
            Err(_) => default,
        };
        r
    }
}

#[interface(name = "org.mpris.MediaPlayer2.Player")]
impl PlayerIface {
    fn next(&self) -> fdo::Result<()> {
        self.ctrl(Control::Next)
    }

    fn previous(&self) -> fdo::Result<()> {
        self.ctrl(Control::Previous)
    }

    fn pause(&self) -> fdo::Result<()> {
        if self.with_player(PlaybackStatus::Stopped, |p| p.status()) == PlaybackStatus::Playing {
            self.ctrl(Control::PlayPause)?;
        }
        Ok(())
    }

    fn play_pause(&self) -> fdo::Result<()> {
        self.ctrl(Control::PlayPause)
    }

    /// MPRIS Stop: pause, rewind, and report Stopped so local_active
    /// releases the transport (desktop clients can then follow others).
    fn stop(&self) -> fdo::Result<()> {
        let state = self.app.state::<AppState>();
        let r = state
            .player
            .lock()
            .map(|mut p| p.stop())
            .map_err(|_| fdo::Error::Failed("player lock poisoned".into()));
        r
    }

    fn play(&self) -> fdo::Result<()> {
        if self.with_player(PlaybackStatus::Stopped, |p| p.status()) != PlaybackStatus::Playing {
            self.ctrl(Control::PlayPause)?;
        }
        Ok(())
    }

    /// Microseconds offset relative to the current position.
    fn seek(&self, offset_us: i64) -> fdo::Result<()> {
        let state = self.app.state::<AppState>();
        let p = state
            .player
            .lock()
            .map_err(|_| fdo::Error::Failed("player lock poisoned".into()))?;
        let target = p.position_ms() as i64 + offset_us / 1000;
        p.seek(target.max(0) as u64).map_err(fdo::Error::Failed)
    }

    /// Absolute position for the given track id (id is advisory here).
    fn set_position(&self, _track: ObjectPath<'_>, pos_us: i64) -> fdo::Result<()> {
        self.with_player((), |p| {
            let _ = p.seek(pos_us.max(0) as u64 / 1000);
        });
        Ok(())
    }

    fn open_uri(&self, _uri: String) -> fdo::Result<()> {
        Err(fdo::Error::NotSupported("open_uri is not supported".into()))
    }

    #[zbus(property)]
    fn playback_status(&self) -> String {
        self.with_player("Stopped".to_string(), |p| {
            status_str(p.status()).to_string()
        })
    }

    #[zbus(property)]
    fn loop_status(&self) -> String {
        self.with_player("None".to_string(), |p| loop_str(p.repeat()).to_string())
    }

    #[zbus(property)]
    fn set_loop_status(&self, v: String) {
        let mode = match v.as_str() {
            "Playlist" => RepeatMode::All,
            "Track" => RepeatMode::One,
            _ => RepeatMode::Off,
        };
        let state = self.app.state::<AppState>();
        let _ = state.player.lock().map(|mut p| p.set_repeat(mode));
    }

    #[zbus(property)]
    fn shuffle(&self) -> bool {
        self.with_player(false, |p| p.shuffle())
    }

    #[zbus(property)]
    fn set_shuffle(&self, v: bool) {
        let state = self.app.state::<AppState>();
        let _ = state.player.lock().map(|mut p| p.set_shuffle(v));
    }

    #[zbus(property)]
    fn rate(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn set_rate(&self, _v: f64) {}

    #[zbus(property)]
    fn minimum_rate(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn maximum_rate(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn volume(&self) -> f64 {
        self.with_player(1.0, |p| p.volume() as f64)
    }

    #[zbus(property)]
    fn set_volume(&self, v: f64) {
        let state = self.app.state::<AppState>();
        let _ = state.player.lock().map(|mut p| p.set_volume(v as f32));
    }

    /// Position in microseconds; clients extrapolate with `rate`.
    #[zbus(property)]
    fn position(&self) -> i64 {
        self.with_player(0, |p| p.position_ms() as i64 * 1000)
    }

    #[zbus(property)]
    fn metadata(&self) -> HashMap<String, Value<'static>> {
        self.with_player(HashMap::new(), |p| {
            metadata(
                p.current_index()
                    .and_then(|i| p.queue().get(i))
                    .map(|q| &q.track),
            )
        })
    }

    #[zbus(property)]
    fn can_control(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_play(&self) -> bool {
        self.with_player(false, |p| !p.queue().is_empty())
    }

    #[zbus(property)]
    fn can_pause(&self) -> bool {
        self.with_player(false, |p| p.status() != PlaybackStatus::Stopped)
    }

    #[zbus(property)]
    fn can_go_next(&self) -> bool {
        self.with_player(false, |p| !p.queue().is_empty())
    }

    #[zbus(property)]
    fn can_go_previous(&self) -> bool {
        self.with_player(false, |p| !p.queue().is_empty())
    }

    #[zbus(property)]
    fn can_seek(&self) -> bool {
        true
    }
}

/// Live handle kept in `AppState`; `update` is called every poll tick.
pub struct MprisHandle {
    app: AppHandle,
    conn: zbus::blocking::Connection,
    seen: Mutex<Seen>,
}

#[derive(Default)]
struct Seen {
    track_id: Option<String>,
    status: Option<PlaybackStatus>,
    position_ms: u64,
    can_play: Option<bool>,
    can_pause: Option<bool>,
    volume_bits: Option<u32>,
    shuffle: Option<bool>,
    loop_status: Option<RepeatMode>,
}

/// Start serving on the session bus. Returns None when there is no bus
/// (headless/CI) — the app works without MPRIS then.
pub fn start(app: &AppHandle) -> Option<MprisHandle> {
    let conn = ConnBuilder::session()
        .ok()?
        .name(BUS_NAME)
        .ok()?
        .serve_at(OBJ, RootIface { app: app.clone() })
        .ok()?
        .serve_at(OBJ, PlayerIface { app: app.clone() })
        .ok()?
        .build()
        .ok()?;
    Some(MprisHandle {
        app: app.clone(),
        conn,
        seen: Mutex::new(Seen::default()),
    })
}

impl MprisHandle {
    /// Mirror the local player's state to the bus. `np` must be the local
    /// player's snapshot when `local_active`, otherwise we publish Stopped
    /// and keep the last metadata (standard player behavior after Stop).
    pub fn update(&self, np: &NowPlaying, local_active: bool) {
        let mut seen = match self.seen.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        let status = if local_active {
            np.status
        } else {
            PlaybackStatus::Stopped
        };
        let position_ms = if local_active { np.position_ms } else { 0 };
        let track_id = if local_active {
            np.track.as_ref().map(|t| t.id.clone())
        } else {
            seen.track_id.clone()
        };

        let mut changed: HashMap<String, Value> = HashMap::new();
        let mut transitioned = false;
        if track_id != seen.track_id {
            changed.insert(
                "Metadata".into(),
                Value::Dict(Dict::from(metadata(np.track.as_ref()))),
            );
            seen.track_id = track_id;
            transitioned = true;
        }
        if Some(status) != seen.status {
            changed.insert("PlaybackStatus".into(), status_str(status).into());
            seen.status = Some(status);
            transitioned = true;
        }
        // Clients cache Can*/Volume/Shuffle/LoopStatus; they only update on
        // PropertiesChanged, so publish every property that can drift.
        if let Ok(p) = self.app.state::<AppState>().player.lock() {
            let caps = !p.queue().is_empty();
            if seen.can_play != Some(caps) {
                for k in ["CanPlay", "CanGoNext", "CanGoPrevious"] {
                    changed.insert(k.into(), caps.into());
                }
                seen.can_play = Some(caps);
            }
            let can_pause = p.status() != PlaybackStatus::Stopped;
            if seen.can_pause != Some(can_pause) {
                changed.insert("CanPause".into(), can_pause.into());
                seen.can_pause = Some(can_pause);
            }
            let vol = p.volume().to_bits();
            if seen.volume_bits != Some(vol) {
                changed.insert("Volume".into(), (p.volume() as f64).into());
                seen.volume_bits = Some(vol);
            }
            if seen.shuffle != Some(p.shuffle()) {
                changed.insert("Shuffle".into(), p.shuffle().into());
                seen.shuffle = Some(p.shuffle());
            }
            if seen.loop_status != Some(p.repeat()) {
                changed.insert("LoopStatus".into(), loop_str(p.repeat()).into());
                seen.loop_status = Some(p.repeat());
            }
        }
        // A jump > 1.5 s from where clients think we are means a seek. Not
        // on transitions — position legitimately resets when a track starts.
        let drift = position_ms as i64 - (seen.position_ms as i64 + 300);
        if !transitioned && status != PlaybackStatus::Stopped && drift.abs() > 1500 {
            let _ = self.conn.emit_signal(
                None::<&str>,
                OBJ,
                PLAYER_IFACE,
                "Seeked",
                &(position_ms as i64 * 1000),
            );
        }
        seen.position_ms = position_ms;
        if !changed.is_empty() {
            let body: (String, HashMap<String, Value>, Vec<String>) =
                (PLAYER_IFACE.to_string(), changed, vec![]);
            let _ = self.conn.emit_signal(
                None::<&str>,
                OBJ,
                "org.freedesktop.DBus.Properties",
                "PropertiesChanged",
                &body,
            );
        }
    }
}
