//! Now-playing detection. One trait, several platform sources, a mock for
//! tests and demo mode, and a null fallback when nothing is available.
//!
//! Platform implementations live in sibling modules:
//! - `mpris`      — Linux, MPRIS over D-Bus (real)
//! - `osascript`  — macOS, AppleScript bridges for Music.app and Spotify (real)
//! - `smtc`       — Windows, GlobalSystemMediaTransportControls (real)
//! - `demo`       — scripted source used by E2E and demo mode

use thiserror::Error;

#[derive(Debug, Error)]
pub enum MediaError {
    #[error("no supported now-playing source on this platform")]
    Unsupported,
    #[error("media source error: {0}")]
    Source(String),
    #[error("media control failed: {0}")]
    Control(String),
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    /// Stable identity for change detection: "artist — title" is fine.
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// `mpris:artUrl` or equivalent; may be a file:// or http(s) URL. May be empty.
    pub artwork_url: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackStatus {
    Playing,
    Paused,
    Stopped,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub track: Option<Track>,
    pub status: PlaybackStatus,
    pub position_ms: u64,
    /// Which source produced this snapshot ("local", "mpris", "demo", ...).
    pub source: String,
    /// Unix milliseconds when this snapshot was taken.
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Control {
    PlayPause,
    Next,
    Previous,
}

/// A source of now-playing information plus transport control.
pub trait NowPlayingSource: Send {
    /// Human name for diagnostics, e.g. "mpris", "smtc", "demo".
    fn name(&self) -> &'static str;
    /// Snapshot of what is playing right now.
    fn poll(&mut self) -> Result<NowPlaying, MediaError>;
    /// Transport control. Sources that cannot control return Err(Control(..)).
    fn control(&mut self, cmd: Control) -> Result<(), MediaError>;
}

/// Source used when nothing real is available: reports Stopped.
pub struct NullSource;

impl NowPlayingSource for NullSource {
    fn name(&self) -> &'static str {
        "null"
    }
    fn poll(&mut self) -> Result<NowPlaying, MediaError> {
        Ok(NowPlaying {
            track: None,
            status: PlaybackStatus::Stopped,
            position_ms: 0,
            source: "null".into(),
            updated_at_ms: now_ms(),
        })
    }
    fn control(&mut self, _cmd: Control) -> Result<(), MediaError> {
        Err(MediaError::Control("null source".into()))
    }
}

/// Platform dispatch: MPRIS on Linux, osascript on macOS, SMTC on Windows.
/// Falls back to `NullSource` where no implementation exists yet.
pub fn platform_source() -> Box<dyn NowPlayingSource> {
    #[cfg(target_os = "linux")]
    {
        match crate::media::mpris::MprisSource::new() {
            Ok(s) => return Box::new(s),
            Err(_) => return Box::new(NullSource),
        }
    }
    #[cfg(target_os = "macos")]
    {
        return Box::new(crate::media::osascript::OsascriptSource::new());
    }
    #[cfg(target_os = "windows")]
    {
        match crate::media::smtc::SmtcSource::new() {
            Ok(s) => return Box::new(s),
            Err(_) => return Box::new(NullSource),
        }
    }
    #[allow(unreachable_code)]
    Box::new(NullSource)
}

/// Demo source for E2E and `--mock` runs: cycles a fixed playlist and
/// advances position at real wall-clock speed while "playing".
/// Implementation: `demo.rs`.
pub use demo::DemoSource;

pub mod demo;
// Platform modules (implemented in crates/noctbeat-core/src/media/):
#[cfg(target_os = "linux")]
pub mod mpris;
#[cfg(target_os = "macos")]
pub mod osascript;
#[cfg(target_os = "windows")]
pub mod smtc;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
