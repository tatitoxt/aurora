//! macOS now-playing via AppleScript bridges for Music.app and Spotify.
//! Plain `osascript` subprocess calls — no private frameworks, no FFI.
//! Only compiled on macOS (see media/mod.rs); the parser is a pure function.

use super::{Control, MediaError, NowPlaying, NowPlayingSource, PlaybackStatus, Track};
use std::process::Command;

const QUERY_SCRIPT: &str = r#"
set out to ""
if application "Spotify" is running then
    tell application "Spotify"
        if player state is playing or player state is paused then
            set out to "spotify|" & (player state as text) & "|" & name of current track & "|" & artist of current track & "|" & album of current track & "|" & ((duration of current track) as text) & "|" & ((player position) as text) & "|" & (artwork url of current track)
        end if
    end tell
end if
if out is "" and application "Music" is running then
    tell application "Music"
        if player state is playing or player state is paused then
            set out to "music|" & (player state as text) & "|" & name of current track & "|" & artist of current track & "|" & album of current track & "|" & (((duration of current track) * 1000) as text) & "|" & ((player position) as text) & "|"
        end if
    end tell
end if
return out
"#;

pub struct OsascriptSource {
    /// App that answered the last successful query ("spotify" | "music").
    active_app: Option<String>,
}

impl Default for OsascriptSource {
    fn default() -> Self {
        Self::new()
    }
}

impl OsascriptSource {
    pub fn new() -> Self {
        Self { active_app: None }
    }

    fn run(script: &str) -> Result<String, MediaError> {
        let out = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| MediaError::Source(format!("osascript: {e}")))?;
        if !out.status.success() {
            return Err(MediaError::Source(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
}

/// Pure: parse `app|state|title|artist|album|duration_ms|position_s|artUrl`.
/// Spotify durations arrive in ms, Music.app in s*1000 (already converted in
/// the script). Positions arrive in seconds.
pub fn parse_player_line(line: &str) -> Option<(String, NowPlaying)> {
    let f: Vec<&str> = line.split('|').collect();
    if f.len() < 7 || f[2].is_empty() {
        return None;
    }
    let status = match f[1] {
        "playing" => PlaybackStatus::Playing,
        "paused" => PlaybackStatus::Paused,
        _ => PlaybackStatus::Stopped,
    };
    let duration_ms = f[5].parse::<f64>().unwrap_or(0.0).max(0.0) as u64;
    let position_ms = (f[6].parse::<f64>().unwrap_or(0.0).max(0.0) * 1000.0) as u64;
    let artist = f[3].to_string();
    let title = f[2].to_string();
    Some((
        f[0].to_string(),
        NowPlaying {
            track: Some(Track {
                id: format!("{artist} — {title}"),
                title,
                artist,
                album: f[4].to_string(),
                artwork_url: f.get(7).copied().unwrap_or("").to_string(),
                duration_ms,
            }),
            status,
            position_ms,
            source: "osascript".into(),
            updated_at_ms: super::now_ms(),
        },
    ))
}

impl NowPlayingSource for OsascriptSource {
    fn name(&self) -> &'static str {
        "osascript"
    }

    fn poll(&mut self) -> Result<NowPlaying, MediaError> {
        let out = Self::run(QUERY_SCRIPT)?;
        match parse_player_line(&out) {
            Some((app, np)) => {
                self.active_app = Some(app);
                Ok(np)
            }
            None => Ok(NowPlaying {
                track: None,
                status: PlaybackStatus::Stopped,
                position_ms: 0,
                source: "osascript".into(),
                updated_at_ms: super::now_ms(),
            }),
        }
    }

    fn control(&mut self, cmd: Control) -> Result<(), MediaError> {
        let Some(app) = &self.active_app else {
            return Err(MediaError::Control("no active player".into()));
        };
        let verb = match cmd {
            Control::PlayPause => "playpause",
            Control::Next => "next track",
            Control::Previous => "previous track",
        };
        Self::run(&format!("tell application \"{app}\" to {verb}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_spotify_line() {
        let (app, np) =
            parse_player_line("spotify|playing|Song|Artist|Album|200000|12.5|https://i/a.png")
                .unwrap();
        assert_eq!(app, "spotify");
        let t = np.track.unwrap();
        assert_eq!(t.title, "Song");
        assert_eq!(t.duration_ms, 200_000);
        assert_eq!(np.position_ms, 12_500);
        assert_eq!(t.artwork_url, "https://i/a.png");
        assert_eq!(np.status, PlaybackStatus::Playing);
    }

    #[test]
    fn parses_music_line_no_art() {
        let (app, np) = parse_player_line("music|paused|Track|B|C|180000|60|").unwrap();
        assert_eq!(app, "music");
        assert_eq!(np.status, PlaybackStatus::Paused);
        assert_eq!(np.track.unwrap().artwork_url, "");
    }

    #[test]
    fn garbage_is_none() {
        assert!(parse_player_line("").is_none());
        assert!(parse_player_line("spotify|playing|").is_none());
    }
}
