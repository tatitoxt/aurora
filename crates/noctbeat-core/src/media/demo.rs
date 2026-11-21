//! Scripted now-playing source for demo mode (`NOCTBEAT_DEMO=1`) and E2E.
//! Deterministic playlist, wall-clock position, real transport controls.

use super::{Control, MediaError, NowPlaying, NowPlayingSource, PlaybackStatus, Track};

const PLAYLIST: &[(&str, &str, &str, u64)] = &[
    ("Neon Reversal", "Violet Sector", "Parallax Bloom", 214_000),
    ("Slow Meridian", "Violet Sector", "Parallax Bloom", 187_000),
    ("Glass Tide", "Ultramar", "Field Lines", 243_000),
    ("Lucid Dreams", "Juice WRLD", "Goodbye & Good Riddance", 239_000),
    ("Midnight Relay", "Chromewave", "Night Grid", 201_000),
    ("Velvet Static", "Ultramar", "Field Lines", 176_000),
    ("Afterglow Avenue", "Neon Fields", "Daybreak", 224_000),
    ("Low Orbit", "Lunar Plain", "Earthrise", 198_000),
    ("Paper Satellites", "Violet Sector", "Parallax Bloom", 232_000),
];

pub struct DemoSource {
    index: usize,
    status: PlaybackStatus,
    /// Position in ms as of `anchor_ms`.
    position_ms: u64,
    anchor_ms: u64,
}

impl Default for DemoSource {
    fn default() -> Self {
        Self::new()
    }
}

impl DemoSource {
    pub fn new() -> Self {
        Self {
            index: 0,
            status: PlaybackStatus::Playing,
            position_ms: 0,
            anchor_ms: super::now_ms(),
        }
    }

    fn current_position(&self) -> u64 {
        if self.status != PlaybackStatus::Playing {
            return self.position_ms;
        }
        let elapsed = super::now_ms().saturating_sub(self.anchor_ms);
        self.position_ms.saturating_add(elapsed)
    }

    fn track(&self) -> Track {
        let (title, artist, album, duration_ms) = PLAYLIST[self.index];
        Track {
            id: format!("{artist} — {title}"),
            title: title.into(),
            artist: artist.into(),
            album: album.into(),
            artwork_url: String::new(),
            duration_ms,
        }
    }

    fn skip(&mut self, dir: i64) {
        let n = PLAYLIST.len() as i64;
        self.index = ((self.index as i64 + dir).rem_euclid(n)) as usize;
        self.position_ms = 0;
        self.anchor_ms = super::now_ms();
    }
}

impl NowPlayingSource for DemoSource {
    fn name(&self) -> &'static str {
        "demo"
    }

    fn poll(&mut self) -> Result<NowPlaying, MediaError> {
        let mut position = self.current_position();
        let track = self.track();
        if position >= track.duration_ms {
            self.skip(1);
            position = self.current_position();
            return Ok(NowPlaying {
                track: Some(self.track()),
                status: self.status,
                position_ms: position,
                source: "demo".into(),
                updated_at_ms: super::now_ms(),
            });
        }
        Ok(NowPlaying {
            track: Some(track),
            status: self.status,
            position_ms: position,
            source: "demo".into(),
            updated_at_ms: super::now_ms(),
        })
    }

    fn control(&mut self, cmd: Control) -> Result<(), MediaError> {
        match cmd {
            Control::PlayPause => {
                let pos = self.current_position();
                self.position_ms = pos;
                self.anchor_ms = super::now_ms();
                self.status = match self.status {
                    PlaybackStatus::Playing => PlaybackStatus::Paused,
                    _ => PlaybackStatus::Playing,
                };
            }
            Control::Next => self.skip(1),
            Control::Previous => self.skip(-1),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plays_first_track() {
        let mut s = DemoSource::new();
        let np = s.poll().unwrap();
        assert_eq!(np.track.unwrap().title, "Neon Reversal");
        assert_eq!(np.status, PlaybackStatus::Playing);
    }

    #[test]
    fn controls_work() {
        let mut s = DemoSource::new();
        s.control(Control::PlayPause).unwrap();
        let np = s.poll().unwrap();
        assert_eq!(np.status, PlaybackStatus::Paused);
        let p1 = np.position_ms;
        std::thread::sleep(std::time::Duration::from_millis(20));
        let np2 = s.poll().unwrap();
        assert_eq!(np2.position_ms, p1, "paused position must not advance");

        s.control(Control::Next).unwrap();
        assert_eq!(s.poll().unwrap().track.unwrap().title, "Slow Meridian");
        s.control(Control::Previous).unwrap();
        assert_eq!(s.poll().unwrap().track.unwrap().title, "Neon Reversal");
    }
}
