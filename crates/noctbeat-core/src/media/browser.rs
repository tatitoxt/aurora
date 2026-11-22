//! Browser-extension now-playing source (the iBaila model): a tiny HTTP
//! listener on 127.0.0.1 receives state POSTed by the Noctbeat browser
//! extension (Chrome/Edge/Firefox) and hands queued transport commands back
//! in the same response, so one round trip carries state in and controls
//! out. When the extension has not reported recently, calls fall through to
//! the wrapped platform source.
//!
//! Several music tabs may report at once: each carries a `tabId`, and the
//! tab currently *playing* wins (most recent wins ties and idle tabs).
//! Queued commands are only handed to the active tab's response.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::{now_ms, Control, MediaError, NowPlaying, NowPlayingSource, PlaybackStatus, Track};

pub const PORT: u16 = 17893;
/// A snapshot older than this counts as "tab went quiet".
const STALE: Duration = Duration::from_millis(4_000);
const MAX_BODY: usize = 64 * 1024;

struct TabState {
    np: NowPlaying,
    received_at: Instant,
}

#[derive(Default)]
struct Shared {
    tabs: HashMap<String, TabState>,
    /// When poll() last ran; drives position extrapolation between reports.
    last_poll: Option<Instant>,
    commands: Vec<Control>,
    /// Pending "search and play" for a provider's tab: (provider, query, queued at).
    play: Option<(String, String, Instant)>,
}

/// A pending tab play expires if no matching tab picks it up in time.
const PLAY_TTL: Duration = Duration::from_secs(15);

/// Picker id for an extension-reported provider host.
pub fn provider_id(host: &str) -> &'static str {
    let h = host.to_ascii_lowercase();
    if h.contains("spotify") {
        "spotify"
    } else if h.contains("youtube") {
        "youtube"
    } else if h.contains("soundcloud") {
        "soundcloud"
    } else if h.contains("apple") {
        "apple"
    } else if h.contains("tidal") {
        "tidal"
    } else if h.contains("amazon") {
        "amazon"
    } else {
        "browser"
    }
}

impl Shared {
    /// The freshest snapshot: a *playing* tab beats an idle one, most
    /// recent report wins. `now` is passed so tests can simulate staleness.
    fn active(&self) -> Option<(&String, &TabState)> {
        let fresh = |t: &&TabState| t.received_at.elapsed() < STALE;
        self.tabs
            .iter()
            .filter(|(_, t)| fresh(t))
            .max_by_key(|(_, t)| (t.np.status == PlaybackStatus::Playing, t.received_at))
    }
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
        let shared = Arc::new(Mutex::new(Shared::default()));
        spawn_server(Arc::clone(&shared), port);
        Self { shared, fallback }
    }

    fn fresh(&self) -> bool {
        self.shared.lock().unwrap().active().is_some()
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
        let mut np = s.active().map(|(_, t)| t.np.clone()).unwrap_or(NowPlaying {
            track: None,
            status: PlaybackStatus::Stopped,
            position_ms: 0,
            source: "browser".into(),
            updated_at_ms: 0,
        });
        // Extrapolate position between extension reports using the time
        // since the last poll — tab timestamps stay untouched so snapshots
        // still expire when a tab goes quiet.
        if np.status == PlaybackStatus::Playing {
            if let Some(t) = s.last_poll {
                np.position_ms += t.elapsed().as_millis() as u64;
            }
        }
        s.last_poll = Some(Instant::now());
        if let Some(tr) = &np.track {
            if tr.duration_ms > 0 {
                np.position_ms = np.position_ms.min(tr.duration_ms);
            }
        }
        np.updated_at_ms = now_ms();
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

    fn ext_status(&self) -> Option<(usize, Option<String>)> {
        let s = self.shared.lock().unwrap();
        let fresh = s
            .tabs
            .values()
            .filter(|t| t.received_at.elapsed() < STALE)
            .count();
        let provider = s.active().map(|(_, t)| t.np.source.clone());
        Some((fresh, provider))
    }

    fn ext_providers(&self) -> Vec<String> {
        let s = self.shared.lock().unwrap();
        let mut v: Vec<String> = s
            .tabs
            .values()
            .filter(|t| t.received_at.elapsed() < STALE)
            .map(|t| t.np.source.clone())
            .collect();
        v.sort();
        v.dedup();
        v
    }

    fn play_in_tab(&mut self, provider: &str, query: &str) -> bool {
        let mut s = self.shared.lock().unwrap();
        let has_tab = s
            .tabs
            .values()
            .any(|t| t.received_at.elapsed() < STALE && provider_id(&t.np.source) == provider);
        if has_tab {
            s.play = Some((provider.to_string(), query.to_string(), Instant::now()));
        }
        has_tab
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Update {
    tab_id: Option<String>,
    provider: Option<String>,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    artwork_url: Option<String>,
    duration_ms: Option<u64>,
    position_ms: Option<u64>,
    playing: Option<bool>,
    url: Option<String>,
}

/// Returns the tab id this update belongs to. Falls back to provider+url so
/// older extensions still get distinct slots per site/page.
fn tab_key(u: &Update) -> String {
    u.tab_id
        .clone()
        .or_else(|| u.url.clone())
        .unwrap_or_else(|| u.provider.clone().unwrap_or_else(|| "browser".into()))
}

fn apply_update(s: &mut Shared, u: Update) {
    let key = tab_key(&u);
    let provider = u.provider.clone().unwrap_or_else(|| "browser".into());
    let title = u.title.clone().unwrap_or_default();
    let artist = u.artist.clone().unwrap_or_default();
    let empty = title.is_empty();
    let np = NowPlaying {
        track: if empty {
            None
        } else {
            Some(Track {
                id: format!("{provider}:{artist}:{title}"),
                title,
                artist,
                album: u.album.unwrap_or_default(),
                artwork_url: u.artwork_url.unwrap_or_default(),
                duration_ms: u.duration_ms.unwrap_or(0),
            })
        },
        status: if empty {
            PlaybackStatus::Stopped
        } else if u.playing.unwrap_or(true) {
            PlaybackStatus::Playing
        } else {
            PlaybackStatus::Paused
        },
        position_ms: u.position_ms.unwrap_or(0),
        source: provider,
        updated_at_ms: now_ms(),
    };
    // Evict long-dead tabs so page reloads don't accumulate snapshots.
    s.tabs
        .retain(|_, t| t.received_at.elapsed() < Duration::from_secs(60));
    s.tabs.insert(
        key,
        TabState {
            np,
            received_at: Instant::now(),
        },
    );
}

fn spawn_server(shared: Arc<Mutex<Shared>>, port: u16) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => l,
            Err(_) => return, // another instance already serving
        };
        for stream in listener.incoming().flatten() {
            // One thread per connection: a slow or stalled tab must not
            // starve the others' reports and command polling.
            let shared = Arc::clone(&shared);
            std::thread::spawn(move || handle(stream, &shared));
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
    // Only browser-extension origins may post state or drain commands:
    // websites can reach 127.0.0.1 with text/plain POSTs, so we reject any
    // Origin that is not an extension scheme (no Origin = non-browser
    // client, allowed for curl/debugging).
    if let Some(origin) = head.lines().find_map(|l| {
        l.to_ascii_lowercase()
            .strip_prefix("origin:")
            .map(|v| v.trim().to_string())
    }) {
        let ok = origin.starts_with("chrome-extension://")
            || origin.starts_with("moz-extension://")
            || origin.starts_with("safari-web-extension://");
        if !ok {
            write_response(&mut stream, 403, "{\"commands\":[]}");
            return;
        }
    }
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
            let key = tab_key(&u);
            apply_update(&mut s, u);
            // Only the active tab may drain the command queue — an idle
            // tab's POST must not steal controls meant for the playing one.
            let is_active = s.active().map(|(k, _)| k == &key).unwrap_or(false);
            let cmds: Vec<&'static str> = if is_active {
                std::mem::take(&mut s.commands)
                    .into_iter()
                    .map(|c| match c {
                        Control::PlayPause => "play-pause",
                        Control::Next => "next",
                        Control::Previous => "previous",
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let source = s
                .tabs
                .get(&key)
                .map(|t| t.np.source.clone())
                .unwrap_or_default();
            let play = take_play(&mut s, &source);
            serde_json::json!({ "commands": cmds, "play": play.map(|q| serde_json::json!({ "query": q })) })
                .to_string()
        }
        Err(_) => "{\"commands\":[]}".into(),
    };
    write_response(&mut stream, 200, &resp);
}

/// Hand the pending tab play to a tab of the requested provider (any tab of
/// it, playing or idle) and drop it once expired.
fn take_play(s: &mut Shared, source: &str) -> Option<String> {
    let (provider, _, at) = s.play.as_ref()?;
    if at.elapsed() > PLAY_TTL {
        s.play = None;
        return None;
    }
    if provider_id(source) != provider {
        return None;
    }
    s.play.take().map(|(_, q, _)| q)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn write_response(stream: &mut std::net::TcpStream, code: u16, body: &str) {
    let reason = if code == 200 {
        "OK"
    } else if code == 403 {
        "Forbidden"
    } else {
        "No Content"
    };
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

    fn empty_shared() -> Shared {
        Shared::default()
    }

    fn update(provider: &str, title: &str, playing: bool) -> Update {
        Update {
            tab_id: Some(format!("tab-{provider}-{title}")),
            provider: Some(provider.into()),
            title: Some(title.into()),
            artist: Some("Artist".into()),
            album: Some("Album".into()),
            artwork_url: Some("https://i/art.jpg".into()),
            duration_ms: Some(200_000),
            position_ms: Some(1_000),
            playing: Some(playing),
            url: None,
        }
    }

    #[test]
    fn update_produces_track() {
        let mut s = empty_shared();
        apply_update(&mut s, update("open.spotify.com", "Song", true));
        let (_, t) = s.active().unwrap();
        assert_eq!(t.np.source, "open.spotify.com");
        assert_eq!(
            t.np.track.as_ref().unwrap().id,
            "open.spotify.com:Artist:Song"
        );
        assert_eq!(t.np.status, PlaybackStatus::Playing);
    }

    #[test]
    fn playing_tab_beats_idle_tab() {
        let mut s = empty_shared();
        apply_update(&mut s, update("open.spotify.com", "Loud", true));
        apply_update(&mut s, update("soundcloud.com", "Quiet", false));
        let (_, t) = s.active().unwrap();
        assert_eq!(t.np.source, "open.spotify.com");
    }

    #[test]
    fn stale_tab_loses_to_fresh_idle_tab() {
        let mut s = empty_shared();
        apply_update(&mut s, update("open.spotify.com", "Old", true));
        // age the playing tab beyond the staleness window
        s.tabs
            .get_mut("tab-open.spotify.com-Old")
            .unwrap()
            .received_at = Instant::now() - STALE - Duration::from_secs(1);
        apply_update(&mut s, update("soundcloud.com", "Fresh", false));
        let (_, t) = s.active().unwrap();
        assert_eq!(t.np.source, "soundcloud.com");
    }

    #[test]
    fn commands_drain() {
        let mut s = empty_shared();
        s.commands.push(Control::Next);
        let cmds: Vec<Control> = std::mem::take(&mut s.commands);
        assert_eq!(cmds, vec![Control::Next]);
    }

    #[test]
    fn tab_play_goes_only_to_matching_provider() {
        let mut s = Shared::default();
        s.play = Some(("spotify".into(), "juice wrld".into(), Instant::now()));
        assert_eq!(take_play(&mut s, "music.youtube.com"), None);
        assert_eq!(
            take_play(&mut s, "open.spotify.com").as_deref(),
            Some("juice wrld")
        );
        assert_eq!(take_play(&mut s, "open.spotify.com"), None);
        assert_eq!(provider_id("www.youtube.com"), "youtube");
    }
}
