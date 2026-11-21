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
    /// (position_ms, publish instant) of the last pushed activity, for
    /// detecting seeks/repeats whose signature stays identical.
    last_pub: Option<(u64, std::time::Instant)>,
    backoff_until: std::time::Instant,
}

impl DiscordRpc {
    pub fn new(client_id: &str) -> Self {
        Self {
            client_id: client_id.to_string(),
            client: None,
            last_sig: None,
            last_pub: None,
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
                self.last_pub = None;
            }
            return;
        };
        if self.last_sig.as_deref() == Some(sig.as_str()) && !self.position_jumped(np) {
            return;
        }
        if self.client.is_none() && !self.connect() {
            return;
        }
        if let Some(c) = self.client.as_mut() {
            if c.set_activity(activity).is_ok() {
                self.last_sig = Some(sig);
                self.last_pub = Some((np.position_ms, std::time::Instant::now()));
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
        self.last_pub = None;
    }

    /// Position drifted more than 4 s from where a playing track should be:
    /// a seek or a loop jump — republish so Discord's elapsed timer resets.
    fn position_jumped(&self, np: &NowPlaying) -> bool {
        if np.status != PlaybackStatus::Playing {
            return false;
        }
        let Some((pos, at)) = self.last_pub else {
            return false;
        };
        let expected = pos + at.elapsed().as_millis() as u64;
        np.position_ms.abs_diff(expected) > 4_000
    }

    fn backoff(&mut self) {
        self.backoff_until = std::time::Instant::now() + std::time::Duration::from_secs(RETRY_SECS);
    }
}

/// Map a now-playing snapshot to (signature, activity). None when there is
/// no track to show. The activity borrows `np`'s strings, so it cannot
/// outlive the snapshot — fine, it is written to the socket immediately.
fn build_activity<'a>(np: &'a NowPlaying) -> Option<(String, Activity<'a>)> {
    // Stopped keeps last-track metadata in the player — only Playing/Paused
    // are a presence worth publishing.
    if np.status == PlaybackStatus::Stopped {
        return None;
    }
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
        // Timestamps::start is epoch SECONDS; milliseconds render a broken
        // elapsed timer in Discord.
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let start = (now_secs - (np.position_ms / 1000) as i64).max(0);
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
    fn stopped_with_retained_track_yields_no_activity() {
        // The player keeps the last track after stop — presence must clear.
        let stopped = np(PlaybackStatus::Stopped, 42_000);
        assert!(build_activity(&stopped).is_none());
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
