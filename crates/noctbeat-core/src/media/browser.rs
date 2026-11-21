//! Browser-extension now-playing source (the iBaila model): a tiny HTTP
//! listener on 127.0.0.1 receives state POSTed by the Noctbeat browser
//! extension (Chrome/Edge/Firefox) and hands queued transport commands back
//! in the same response, so one round trip carries state in and controls
//! out. When the extension has not reported recently, calls fall through to
//! the wrapped platform source.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::{now_ms, Control, MediaError, NowPlaying, NowPlayingSource, PlaybackStatus, Track};

pub const PORT: u16 = 17893;
/// A snapshot older than this counts as "extension went quiet" and we fall
/// back to the platform source (MPRIS/SMTC/osascript).
const STALE: Duration = Duration::from_millis(4_000);
const MAX_BODY: usize = 64 * 1024;

struct Shared {
    np: NowPlaying,
    received_at: Option<Instant>,
    commands: Vec<Control>,
}

pub struct BrowserSource {
    shared: Arc<Mutex<Shared>>,
    fallback: Box<dyn NowPlayingSource>,
}

impl BrowserSource {
    /// Wrap another source; the extension wins while its reports are fresh.
    pub fn new(fallback: Box<dyn NowPlayingSource>) -> Self {
        Self::with_port(fallback, PORT)
    }

    pub fn with_port(fallback: Box<dyn NowPlayingSource>, port: u16) -> Self {
        let shared = Arc::new(Mutex::new(Shared {
            np: NowPlaying {
                track: None,
                status: PlaybackStatus::Stopped,
                position_ms: 0,
                source: "browser".into(),
                updated_at_ms: 0,
            },
            received_at: None,
            commands: Vec::new(),
        }));
        spawn_server(Arc::clone(&shared), port);
        Self { shared, fallback }
    }

    fn fresh(&self) -> bool {
        self.shared
            .lock()
            .unwrap()
            .received_at
            .map(|t| t.elapsed() < STALE)
            .unwrap_or(false)
    }
}

impl NowPlayingSource for BrowserSource {
    fn name(&self) -> &'static str {
        "browser"
    }

    fn poll(&mut self) -> Result<NowPlaying, MediaError> {
        if !self.fresh() {
            return self.fallback.poll();
        }
        let mut s = self.shared.lock().unwrap();
        let mut np = s.np.clone();
        // Extrapolate position between extension reports.
        if np.status == PlaybackStatus::Playing {
            if let Some(t) = s.received_at {
                np.position_ms += t.elapsed().as_millis() as u64;
            }
        }
        if let Some(tr) = &np.track {
            if tr.duration_ms > 0 {
                np.position_ms = np.position_ms.min(tr.duration_ms);
            }
        }
        np.updated_at_ms = now_ms();
        s.received_at = Some(Instant::now());
        Ok(np)
    }

    fn control(&mut self, cmd: Control) -> Result<(), MediaError> {
        if self.fresh() {
            self.shared.lock().unwrap().commands.push(cmd);
            Ok(())
        } else {
            self.fallback.control(cmd)
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Update {
    provider: Option<String>,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    artwork_url: Option<String>,
    duration_ms: Option<u64>,
    position_ms: Option<u64>,
    playing: Option<bool>,
}

fn apply_update(s: &mut Shared, u: Update) {
    let provider = u.provider.unwrap_or_else(|| "browser".into());
    let title = u.title.unwrap_or_default();
    let artist = u.artist.unwrap_or_default();
    if title.is_empty() {
        s.np.track = None;
        s.np.status = PlaybackStatus::Stopped;
    } else {
        s.np.track = Some(Track {
            id: format!("{provider}:{artist}:{title}"),
            title,
            artist,
            album: u.album.unwrap_or_default(),
            artwork_url: u.artwork_url.unwrap_or_default(),
            duration_ms: u.duration_ms.unwrap_or(0),
        });
        s.np.status = if u.playing.unwrap_or(true) {
            PlaybackStatus::Playing
        } else {
            PlaybackStatus::Paused
        };
    }
    s.np.position_ms = u.position_ms.unwrap_or(0);
    s.np.source = provider;
    s.np.updated_at_ms = now_ms();
    s.received_at = Some(Instant::now());
}

fn spawn_server(shared: Arc<Mutex<Shared>>, port: u16) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => l,
            Err(_) => return, // another instance already serving
        };
        for stream in listener.incoming().flatten() {
            handle(stream, &shared);
        }
    });
}

fn handle(mut stream: std::net::TcpStream, shared: &Arc<Mutex<Shared>>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = find(&buf, b"\r\n\r\n") {
                    break pos + 4;
                }
                if buf.len() > MAX_BODY {
                    return;
                }
            }
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]);
    if head.starts_with("OPTIONS") {
        write_response(&mut stream, 204, "{}");
        return;
    }
    let content_len = head
        .lines()
        .find_map(|l| {
            l.to_ascii_lowercase()
                .strip_prefix("content-length:")?
                .trim()
                .parse::<usize>()
                .ok()
        })
        .unwrap_or(0)
        .min(MAX_BODY);
    let mut body = buf[header_end..].to_vec();
    while body.len() < content_len {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }
    let resp = match serde_json::from_slice::<Update>(&body) {
        Ok(u) => {
            let mut s = shared.lock().unwrap();
            apply_update(&mut s, u);
            let cmds: Vec<&'static str> = s
                .commands
                .drain(..)
                .map(|c| match c {
                    Control::PlayPause => "play-pause",
                    Control::Next => "next",
                    Control::Previous => "previous",
                })
                .collect();
            format!(
                "{{\"commands\":{}}}",
                serde_json::to_string(&cmds).unwrap_or_else(|_| "[]".into())
            )
        }
        Err(_) => "{\"commands\":[]}".into(),
    };
    write_response(&mut stream, 200, &resp);
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn write_response(stream: &mut std::net::TcpStream, code: u16, body: &str) {
    let reason = if code == 200 { "OK" } else { "No Content" };
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_produces_track() {
        let mut s = Shared {
            np: NowPlaying {
                track: None,
                status: PlaybackStatus::Stopped,
                position_ms: 0,
                source: "browser".into(),
                updated_at_ms: 0,
            },
            received_at: None,
            commands: Vec::new(),
        };
        apply_update(
            &mut s,
            Update {
                provider: Some("open.spotify.com".into()),
                title: Some("Song".into()),
                artist: Some("Artist".into()),
                album: Some("Album".into()),
                artwork_url: Some("https://i/art.jpg".into()),
                duration_ms: Some(200_000),
                position_ms: Some(1_000),
                playing: Some(true),
            },
        );
        assert_eq!(s.np.source, "open.spotify.com");
        let t = s.np.track.unwrap();
        assert_eq!(t.id, "open.spotify.com:Artist:Song");
        assert_eq!(s.np.status, PlaybackStatus::Playing);
    }

    #[test]
    fn http_roundtrip_reports_and_returns_commands() {
        let shared = Arc::new(Mutex::new(Shared {
            np: NowPlaying {
                track: None,
                status: PlaybackStatus::Stopped,
                position_ms: 0,
                source: "browser".into(),
                updated_at_ms: 0,
            },
            received_at: None,
            commands: vec![Control::Next],
        }));
        let mut s = shared.lock().unwrap();
        apply_update(
            &mut s,
            serde_json::from_str::<Update>(
                r#"{"provider":"soundcloud.com","title":"T","artist":"A","playing":true,"durationMs":1000,"positionMs":5}"#,
            )
            .unwrap(),
        );
        assert!(s.np.track.is_some());
        let cmds: Vec<Control> = std::mem::take(&mut s.commands);
        assert_eq!(cmds, vec![Control::Next]);
    }
}
