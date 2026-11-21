//! Linux now-playing via MPRIS over D-Bus (Spotify, players, browsers).
//! Uses the zbus blocking API; metadata parsing is a pure, tested function.

use super::{Control, MediaError, NowPlaying, NowPlayingSource, PlaybackStatus, Track};
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{Dict, OwnedValue, Value};

const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";
const PLAYER_PATH: &str = "/org/mpris/MediaPlayer2";

pub struct MprisSource {
    conn: Connection,
    player: String,
}

impl MprisSource {
    /// Connect to the session bus and pick the first MPRIS player.
    /// Prefers a player that is currently Playing when several exist.
    pub fn new() -> Result<Self, MediaError> {
        let conn = Connection::session().map_err(|e| MediaError::Source(e.to_string()))?;
        let dbus = Proxy::new(
            &conn,
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
        )
        .map_err(|e| MediaError::Source(e.to_string()))?;
        let reply = dbus
            .call_method("ListNames", &())
            .map_err(|e| MediaError::Source(e.to_string()))?;
        let names: Vec<String> = reply
            .body()
            .deserialize()
            .map_err(|e| MediaError::Source(e.to_string()))?;
        let mut players: Vec<String> = names
            .into_iter()
            .filter(|n| {
                n.starts_with("org.mpris.MediaPlayer2.")
                    // Never watch our own published player interface.
                    && n != "org.mpris.MediaPlayer2.noctbeat"
            })
            .collect();
        players.sort();
        players
            .iter()
            .find(|p| {
                Self::player_proxy(&conn, p)
                    .and_then(|px| {
                        px.get_property::<String>("PlaybackStatus")
                            .map_err(|e| MediaError::Source(e.to_string()))
                    })
                    .map(|s| s == "Playing")
                    .unwrap_or(false)
            })
            .or_else(|| players.first())
            .map(|p| Self {
                conn,
                player: p.clone(),
            })
            .ok_or(MediaError::Unsupported)
    }

    fn player_proxy<'a>(conn: &'a Connection, player: &'a str) -> Result<Proxy<'a>, MediaError> {
        Proxy::new(conn, player, PLAYER_PATH, PLAYER_IFACE)
            .map_err(|e| MediaError::Source(e.to_string()))
    }
}

/// Pure: MPRIS `Metadata` dict -> Track. Tested without D-Bus.
pub fn track_from_metadata(metadata: &Dict<'_, '_>) -> Option<Track> {
    // `a{sv}` values arrive as `Value::Value(inner)` — unwrap fully.
    fn unv<'v>(v: &'v Value<'v>) -> &'v Value<'v> {
        match v {
            Value::Value(inner) => unv(inner),
            other => other,
        }
    }
    let get = |key: &str| -> Option<&Value<'_>> {
        metadata.iter().find_map(|(k, v)| match k {
            Value::Str(s) if s.as_str() == key => Some(unv(v)),
            _ => None,
        })
    };
    let str_of = |v: Option<&Value>| -> String {
        match v {
            Some(Value::Str(s)) => s.to_string(),
            _ => String::new(),
        }
    };
    let title = str_of(get("xesam:title"));
    if title.is_empty() {
        return None;
    }
    let artist = match get("xesam:artist") {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|v| match unv(v) {
                Value::Str(s) => Some(s.to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(", "),
        other => str_of(other),
    };
    let duration_ms = match get("mpris:length") {
        Some(Value::I64(us)) => ((*us).max(0) / 1000) as u64,
        Some(Value::U64(us)) => us / 1000,
        _ => 0,
    };
    Some(Track {
        id: format!("{artist} — {title}"),
        title,
        artist,
        album: str_of(get("xesam:album")),
        artwork_url: str_of(get("mpris:artUrl")),
        duration_ms,
    })
}

impl NowPlayingSource for MprisSource {
    fn name(&self) -> &'static str {
        "mpris"
    }

    fn poll(&mut self) -> Result<NowPlaying, MediaError> {
        // If the player vanished, re-scan once.
        if Self::player_proxy(&self.conn, &self.player)
            .and_then(|p| {
                p.get_property::<String>("PlaybackStatus")
                    .map_err(|e| MediaError::Source(e.to_string()))
            })
            .is_err()
        {
            *self = Self::new()?;
        }
        let proxy = Self::player_proxy(&self.conn, &self.player)?;
        let status = proxy
            .get_property::<String>("PlaybackStatus")
            .map_err(|e| MediaError::Source(e.to_string()))?;
        let metadata_v: OwnedValue = proxy
            .get_property("Metadata")
            .map_err(|e| MediaError::Source(e.to_string()))?;
        let position_us: i64 = proxy.get_property("Position").unwrap_or(0);
        let track = match Value::from(metadata_v) {
            Value::Dict(d) => track_from_metadata(&d),
            _ => None,
        };
        Ok(NowPlaying {
            track,
            status: match status.as_str() {
                "Playing" => PlaybackStatus::Playing,
                "Paused" => PlaybackStatus::Paused,
                _ => PlaybackStatus::Stopped,
            },
            position_ms: (position_us.max(0) / 1000) as u64,
            source: "mpris".into(),
            updated_at_ms: super::now_ms(),
        })
    }

    fn control(&mut self, cmd: Control) -> Result<(), MediaError> {
        let method = match cmd {
            Control::PlayPause => "PlayPause",
            Control::Next => "Next",
            Control::Previous => "Previous",
        };
        Self::player_proxy(&self.conn, &self.player)?
            .call_method(method, &())
            .map_err(|e| MediaError::Control(e.to_string()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use zbus::zvariant::Str;

    fn dict(entries: Vec<(&str, Value<'static>)>) -> Dict<'static, 'static> {
        let map: HashMap<String, Value> = entries
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        map.into()
    }

    #[test]
    fn parses_full_metadata() {
        let d = dict(vec![
            ("xesam:title", Value::new("Song")),
            ("xesam:album", Value::new("Album")),
            (
                "xesam:artist",
                Value::new(zbus::zvariant::Array::from(vec![
                    Value::new("A"),
                    Value::new("B"),
                ])),
            ),
            ("mpris:length", Value::new(200_000_000i64)),
            ("mpris:artUrl", Value::new("file:///tmp/a.png")),
        ]);
        let t = track_from_metadata(&d).unwrap();
        assert_eq!(t.title, "Song");
        assert_eq!(t.artist, "A, B");
        assert_eq!(t.album, "Album");
        assert_eq!(t.duration_ms, 200_000);
        assert_eq!(t.artwork_url, "file:///tmp/a.png");
        assert_eq!(t.id, "A, B — Song");
    }

    #[test]
    fn sparse_metadata() {
        let d = dict(vec![("xesam:title", Value::new(Str::from("OnlyTitle")))]);
        let t = track_from_metadata(&d).unwrap();
        assert_eq!(t.artist, "");
        assert_eq!(t.duration_ms, 0);
        assert!(track_from_metadata(&dict(vec![])).is_none());
    }
}
