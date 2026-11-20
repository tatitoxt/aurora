//! Windows now-playing via GlobalSystemMediaTransportControls (SMTC).
//! Only compiled on Windows (see media/mod.rs). Verified by the Windows CI job.

use super::{Control, MediaError, NowPlaying, NowPlayingSource, PlaybackStatus, Track};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};

pub struct SmtcSource {
    manager: GlobalSystemMediaTransportControlsSessionManager,
}

fn ms(ts: windows::Foundation::TimeSpan) -> u64 {
    // TimeSpan is in 100ns units.
    (ts.Duration.max(0) / 10_000) as u64
}

impl SmtcSource {
    pub fn new() -> Result<Self, MediaError> {
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .and_then(|op| op.get())
            .map_err(|e| MediaError::Source(e.to_string()))?;
        Ok(Self { manager })
    }

    fn session(
        &self,
    ) -> Result<windows::Media::Control::GlobalSystemMediaTransportControlsSession, MediaError>
    {
        self.manager
            .GetCurrentSession()
            .map_err(|e| MediaError::Source(e.to_string()))
    }
}

impl NowPlayingSource for SmtcSource {
    fn name(&self) -> &'static str {
        "smtc"
    }

    fn poll(&mut self) -> Result<NowPlaying, MediaError> {
        let session = self.session()?;
        let props = session
            .TryGetMediaPropertiesAsync()
            .and_then(|op| op.get())
            .map_err(|e| MediaError::Source(e.to_string()))?;
        let title = props
            .Title()
            .map(|h| h.to_string_lossy())
            .unwrap_or_default();
        let artist = props
            .Artist()
            .map(|h| h.to_string_lossy())
            .unwrap_or_default();
        let album = props
            .AlbumTitle()
            .map(|h| h.to_string_lossy())
            .unwrap_or_default();
        let timeline = session.GetTimelineProperties().ok();
        let info = session.GetPlaybackInfo().ok();
        let status = info
            .and_then(|i| i.PlaybackStatus().ok())
            .map(|s| match s {
                GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing => {
                    PlaybackStatus::Playing
                }
                GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused => {
                    PlaybackStatus::Paused
                }
                _ => PlaybackStatus::Stopped,
            })
            .unwrap_or(PlaybackStatus::Stopped);
        let track = if title.is_empty() {
            None
        } else {
            Some(Track {
                id: format!("{artist} — {title}"),
                title,
                artist,
                album,
                // SMTC thumbnails are streams, not URLs; decoded artwork is a
                // later milestone. Empty for now.
                artwork_url: String::new(),
                duration_ms: timeline
                    .and_then(|t| t.EndTime().ok().map(ms))
                    .unwrap_or(0),
            })
        };
        Ok(NowPlaying {
            track,
            status,
            position_ms: timeline
                .and_then(|t| t.Position().ok().map(ms))
                .unwrap_or(0),
            updated_at_ms: super::now_ms(),
        })
    }

    fn control(&mut self, cmd: Control) -> Result<(), MediaError> {
        let session = self.session()?;
        match cmd {
            Control::PlayPause => session.TryPlayPauseAsync(),
            Control::Next => session.TrySkipNextAsync(),
            Control::Previous => session.TrySkipPreviousAsync(),
        }
        .and_then(|op| op.get())
        .map_err(|e| MediaError::Control(e.to_string()))?;
        Ok(())
    }
}
