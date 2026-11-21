//! Discord Rich Presence over the local IPC socket.
//!
//! Disabled cleanly when branding.json has no `discordClientId` — there is
//! no Discord application to register against, so the feature stays hidden.
//! Connects lazily on the first update and backs off after failures instead
//! of hammering a Discord client that isn't running.

use discord_rich_presence::{
    activity::{Activity, ActivityType, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use noctbeat_core::media::{NowPlaying, PlaybackStatus};

const RETRY_SECS: u64 = 15;

pub struct DiscordRpc {
    client_id: String,
    client: Option<DiscordIpcClient>,
    /// Signature of the activity last pushed — reconnects and no-op ticks
    /// skip the socket write.
    last_sig: Option<String>,
    backoff_until: std::time::Instant,
}

impl DiscordRpc {
    pub fn new(client_id: &str) -> Self {
        Self {
            client_id: client_id.to_string(),
            client: None,
            last_sig: None,
            backoff_until: std::time::Instant::now(),
        }
    }

    /// Reflect `np` on Discord. `enabled` is the user's setting; the client
    /// is torn down when it flips off so toggling is immediate.
    pub fn update(&mut self, np: &NowPlaying, enabled: bool) {
        if !enabled || self.client_id.is_empty() {
            self.disconnect();
            return;
        }
        let Some((sig, activity)) = build_activity(np) else {
            // Nothing playing: clear whatever we published.
            if self.client.is_some() && self.last_sig.is_some() {
                if let Some(c) = self.client.as_mut() {
                    if c.clear_activity().is_err() {
                        self.disconnect();
                        return;
                    }
                }
                self.last_sig = None;
            }
            return;
        };
        if self.last_sig.as_deref() == Some(sig.as_str()) {
            return;
        }
        if self.client.is_none() && !self.connect() {
            return;
        }
        if let Some(c) = self.client.as_mut() {
            if c.set_activity(activity).is_ok() {
                self.last_sig = Some(sig);
            } else {
                // Discord went away (quit, socket rotated): retry next cycle.
                self.disconnect();
            }
        }
    }

    fn connect(&mut self) -> bool {
        if std::time::Instant::now() < self.backoff_until {
            return false;
        }
        match DiscordIpcClient::new(&self.client_id) {
            Ok(mut c) => match c.connect() {
                Ok(()) => {
                    self.client = Some(c);
                    true
                }
                Err(_) => {
                    self.backoff();
                    false
                }
            },
            Err(_) => {
                self.backoff();
                false
            }
        }
    }

    fn disconnect(&mut self) {
        if let Some(mut c) = self.client.take() {
            let _ = c.close();
        }
        self.last_sig = None;
    }

    fn backoff(&mut self) {
        self.backoff_until = std::time::Instant::now() + std::time::Duration::from_secs(RETRY_SECS);
    }
}

/// Map a now-playing snapshot to (signature, activity). None when there is
/// no track to show. The activity borrows `np`'s strings, so it cannot
/// outlive the snapshot — fine, it is written to the socket immediately.
fn build_activity<'a>(np: &'a NowPlaying) -> Option<(String, Activity<'a>)> {
    let t = np.track.as_ref()?;
    let playing = np.status == PlaybackStatus::Playing;
    let state: &str = if t.artist.is_empty() {
        "Unknown artist"
    } else {
        &t.artist
    };
    // Signature: identity + playback intent. Position is folded into the
    // timestamp rather than the signature so each tick isn't a new write.
    let sig = format!("{}|{}|{}", t.title, state, playing);
    let mut a = Activity::new()
        .activity_type(ActivityType::Listening)
        .details(&t.title)
        .state(state);
    if playing {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let start = (now - np.position_ms as i64).max(0);
        a = a.timestamps(Timestamps::new().start(start));
    }
    Some((sig, a))
}

#[cfg(test)]
mod tests {
    use super::*;
    use noctbeat_core::media::Track;

    fn np(status: PlaybackStatus, pos_ms: u64) -> NowPlaying {
        NowPlaying {
            track: Some(Track {
                id: "t1".into(),
                title: "Song".into(),
                artist: "Artist".into(),
                album: "Album".into(),
                duration_ms: 200_000,
                artwork_url: String::new(),
            }),
            status,
            position_ms: pos_ms,
            source: "test".into(),
            updated_at_ms: 0,
        }
    }

    #[test]
    fn no_track_yields_no_activity() {
        let mut idle = np(PlaybackStatus::Stopped, 0);
        idle.track = None;
        assert!(build_activity(&idle).is_none());
    }

    #[test]
    fn paused_has_no_timestamps_signature_differs() {
        let playing = np(PlaybackStatus::Playing, 10_000);
        let paused = np(PlaybackStatus::Paused, 10_000);
        let (sig_p, _) = build_activity(&playing).unwrap();
        let (sig_s, _) = build_activity(&paused).unwrap();
        assert_ne!(sig_p, sig_s);
    }

    #[test]
    fn empty_artist_falls_back() {
        let mut p = np(PlaybackStatus::Playing, 0);
        p.track.as_mut().unwrap().artist = String::new();
        let (sig, _) = build_activity(&p).unwrap();
        assert!(sig.contains("Unknown artist"));
    }
}
