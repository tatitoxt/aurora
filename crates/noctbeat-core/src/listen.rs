//! Listen Along: host/follower sync. A host publishes its Now Playing
//! snapshot; followers poll it and mirror transport state (track,
//! position, play/pause) against their own local library.
//!
//! Two transports share the same Broadcast payload:
//! - LAN: `Host` serves `GET /<key>` on `0.0.0.0:LISTEN_PORT`; followers
//!   join `ip:port/<key>` (raw TCP, no DNS/TLS needed).
//! - WAN: `RelayHost` POSTs to `<relay>/<key>` on a `relay::Relay` room
//!   store; followers join the `https://relay/<key>` URL via ureq.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::media::{now_ms, NowPlaying, PlaybackStatus};

pub const LISTEN_PORT: u16 = 17894;
/// Default public relay for "Host web" — override with `NOCTBEAT_RELAY`.
pub const DEFAULT_RELAY: &str = "https://noctbeat-relay.onrender.com";
const MAX_BODY: usize = 256 * 1024;
/// A peer that fetched /state within this window counts as listening.
const PEER_FRESH: Duration = Duration::from_secs(15);
/// Position error above which the follower hard-seeks to the host.
pub const DRIFT_MS: u64 = 1_500;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Broadcast {
    /// Host display name shown to followers.
    pub host: String,
    pub np: NowPlaying,
    /// Host wall clock when the snapshot was taken.
    pub sent_at_ms: u64,
    /// Monotonic per host session; followers ignore replays if needed.
    pub seq: u64,
    /// When the follower received it — set client-side, not serialized.
    #[serde(skip)]
    pub received_at: Option<std::time::Instant>,
}

impl Broadcast {
    /// Host position extrapolated to "now" on the follower.
    pub fn position_ms(&self) -> u64 {
        let mut pos = self.np.position_ms;
        if self.np.status == PlaybackStatus::Playing {
            if let Some(t) = self.received_at {
                pos += t.elapsed().as_millis() as u64;
            }
        }
        if let Some(tr) = &self.np.track {
            if tr.duration_ms > 0 {
                pos = pos.min(tr.duration_ms);
            }
        }
        pos
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenStatus {
    pub hosting: bool,
    /// Address followers should join, e.g. `http://192.168.1.20:17894`.
    pub host_addr: Option<String>,
    pub host_name: Option<String>,
    /// Peers seen fetching state recently (host side).
    pub peers: usize,
    /// Address this client follows (follower side).
    pub following: Option<String>,
    /// Last host snapshot couldn't be matched in the local library.
    pub missing_track: Option<String>,
    pub last_error: Option<String>,
}

struct HostShared {
    np: Option<NowPlaying>,
    host_name: String,
    /// Session token the share URL carries; /state rejects requests that
    /// don't present it.
    key: String,
    seq: u64,
    peers: HashMap<String, Instant>,
}

/// 16-hex-char session token — keeps casual LAN readers/forgers out of the
/// state endpoint (an active on-path MITM still needs TLS: roadmap).
fn session_key() -> String {
    let mut b = [0u8; 8];
    // CSPRNG on every desktop platform — guessing a web session link must
    // not reduce to timestamp+pid arithmetic.
    if getrandom::getrandom(&mut b).is_ok()
        || std::fs::File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut b))
            .is_ok()
    {
        return b.iter().map(|x| format!("{x:02x}")).collect();
    }
    format!("{:016x}", now_ms() ^ ((std::process::id() as u64) << 32))
}

pub struct Host {
    shared: Arc<Mutex<HostShared>>,
    alive: Arc<AtomicBool>,
    /// Our LAN address as `ip:port`; None when no non-loopback interface
    /// was discovered (isolated setups share it by hand).
    pub addr: Option<String>,
    /// Session token — followers joining without it get 403.
    pub key: String,
}

impl Host {
    /// Start serving `GET /<key>` on `0.0.0.0:port`. None if the bind fails.
    pub fn start(host_name: impl Into<String>, port: u16) -> Option<Self> {
        let listener = TcpListener::bind(("0.0.0.0", port)).ok()?;
        listener.set_nonblocking(true).ok()?;
        let shared = Arc::new(Mutex::new(HostShared {
            np: None,
            host_name: host_name.into(),
            key: session_key(),
            seq: 0,
            peers: HashMap::new(),
        }));
        let alive = Arc::new(AtomicBool::new(true));
        let s = Arc::clone(&shared);
        let a = Arc::clone(&alive);
        std::thread::spawn(move || {
            while a.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, peer)) => {
                        record_peer(&s, peer.ip().to_string());
                        // Per-connection thread: an idle client that never
                        // finishes its request must not stall other peers.
                        let s2 = Arc::clone(&s);
                        std::thread::spawn(move || serve_state(stream, &s2));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(80));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(80)),
                }
            }
        });
        let addr = lan_ip().map(|ip| format!("{ip}:{port}"));
        let key = shared.lock().unwrap().key.clone();
        Some(Self {
            shared,
            alive,
            addr,
            key,
        })
    }

    /// `http://ip:port/<key>` — the string friends paste to join.
    pub fn share_url(&self) -> Option<String> {
        self.addr
            .as_ref()
            .map(|a| format!("http://{a}/{}", self.key))
    }

    /// Publish the latest now-playing snapshot for followers. Local file
    /// paths (track ids, cache artwork) are stripped before broadcast.
    pub fn publish(&self, np: &NowPlaying) {
        let mut np = np.clone();
        if let Some(t) = np.track.as_mut() {
            t.id = format!("{}:{}:{}", np.source, t.artist, t.title);
            if !t.artwork_url.starts_with("http") {
                t.artwork_url.clear();
            }
        }
        let mut s = self.shared.lock().unwrap();
        s.np = Some(np);
        s.seq += 1;
    }

    /// How many distinct peers fetched state recently.
    pub fn peers(&self) -> usize {
        let s = self.shared.lock().unwrap();
        s.peers
            .values()
            .filter(|t| t.elapsed() < PEER_FRESH)
            .count()
    }

    /// Display name followers see.
    pub fn name(&self) -> String {
        self.shared.lock().unwrap().host_name.clone()
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Relaxed);
    }
}

fn record_peer(shared: &Arc<Mutex<HostShared>>, ip: String) {
    let mut s = shared.lock().unwrap();
    s.peers
        .retain(|_, t| t.elapsed() < Duration::from_secs(120));
    s.peers.insert(ip, Instant::now());
}

fn serve_state(mut stream: TcpStream, shared: &Arc<Mutex<HostShared>>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    // Consume the request head; only `GET /<key>` is served.
    let mut buf = [0u8; 2048];
    let n = stream.read(&mut buf).unwrap_or(0);
    if n == 0 {
        return;
    }
    let head = String::from_utf8_lossy(&buf[..n]);
    let path = head.split_whitespace().nth(1).unwrap_or("");
    let key = shared.lock().unwrap().key.clone();
    if path != format!("/{key}") {
        let _ = stream
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    let body = {
        let s = shared.lock().unwrap();
        match &s.np {
            Some(np) => serde_json::to_string(&Broadcast {
                host: s.host_name.clone(),
                np: np.clone(),
                sent_at_ms: now_ms(),
                seq: s.seq,
                received_at: None,
            })
            .unwrap_or_else(|_| "null".into()),
            None => "null".into(),
        }
    };
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    );
}

/// The local LAN address, best-effort: a UDP "connect" picks the outbound
/// interface without sending traffic. The broadcast/multicast fallbacks
/// cover interfaces on isolated LANs with no default route.
pub fn lan_ip() -> Option<String> {
    for target in ["192.0.2.1:80", "255.255.255.255:80", "224.0.0.1:80"] {
        let Ok(sock) = std::net::UdpSocket::bind(("0.0.0.0", 0)) else {
            continue;
        };
        if sock.connect(target).is_err() {
            continue;
        }
        if let Ok(a) = sock.local_addr() {
            if !a.ip().is_loopback() && !a.ip().is_unspecified() {
                return Some(a.ip().to_string());
            }
        }
    }
    None
}

/// A broadcast older than this no longer drives sync — the session is
/// gone, so the last snapshot must not keep controlling playback.
const FOLLOW_STALE: Duration = Duration::from_secs(4);

struct FollowShared {
    /// (When it arrived, what arrived). Expires via FOLLOW_STALE.
    latest: Option<(Instant, Broadcast)>,
    host_name: Option<String>,
    last_error: Option<String>,
}

/// Polls a host's `/state` on a worker thread; the poller reads `latest()`.
pub struct Follower {
    shared: Arc<Mutex<FollowShared>>,
    alive: Arc<AtomicBool>,
    pub addr: String,
}

/// Where a follower fetches broadcasts. Full `http(s)` URLs — relay room
/// links and LAN share links alike — go through ureq (DNS, TLS); bare
/// `ip:port` keeps the raw-TCP path so URL-free joins still work offline.
enum Endpoint {
    Tcp { addr: String, key: Option<String> },
    Url(String),
}

impl Endpoint {
    fn parse(addr: &str) -> Self {
        let raw = addr.trim().trim_end_matches('/');
        if raw.starts_with("http://") || raw.starts_with("https://") {
            Self::Url(raw.to_string())
        } else {
            let (a, k) = normalize_addr(raw);
            Self::Tcp { addr: a, key: k }
        }
    }
    fn fetch(&self) -> Result<Option<Broadcast>, String> {
        match self {
            Self::Tcp { addr, key } => fetch_broadcast(addr, key.as_deref()),
            Self::Url(u) => fetch_broadcast_url(u),
        }
    }
    fn display(&self) -> String {
        match self {
            Self::Tcp { addr, .. } => addr.clone(),
            Self::Url(u) => u.clone(),
        }
    }
}

impl Follower {
    /// Join `addr` (`ip`, `ip:port`, a `http://ip:port/<key>` LAN share
    /// URL, or a `https://relay/<key>` room URL).
    /// Validates by fetching state once; Err means unreachable or bad key.
    pub fn join(addr: &str) -> Result<Self, String> {
        let ep = Endpoint::parse(addr);
        let shown = ep.display();
        // One probe up front so join() can fail fast on a bad address.
        let b = ep.fetch().map_err(|e| format!("{shown}: {e}"))?;
        let shared = Arc::new(Mutex::new(FollowShared {
            latest: b.clone().map(|b| (Instant::now(), b)),
            host_name: b.map(|x| x.host),
            last_error: None,
        }));
        let alive = Arc::new(AtomicBool::new(true));
        let s = Arc::clone(&shared);
        let a = Arc::clone(&alive);
        std::thread::spawn(move || {
            while a.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(800));
                match ep.fetch() {
                    Ok(mut b) => {
                        let mut g = s.lock().unwrap();
                        g.last_error = None;
                        if let Some(b) = b.take() {
                            g.host_name = Some(b.host.clone());
                            g.latest = Some((Instant::now(), b));
                        }
                    }
                    Err(e) => s.lock().unwrap().last_error = Some(e),
                }
            }
        });
        Ok(Self {
            shared,
            alive,
            addr: shown,
        })
    }

    /// Latest host snapshot — None once it goes stale (session ended or
    /// host unreachable), so a dead session can't keep driving playback.
    pub fn latest(&self) -> Option<Broadcast> {
        self.shared
            .lock()
            .unwrap()
            .latest
            .as_ref()
            .filter(|(t, _)| t.elapsed() < FOLLOW_STALE)
            .map(|(_, b)| b.clone())
    }

    pub fn host_name(&self) -> Option<String> {
        self.shared.lock().unwrap().host_name.clone()
    }

    pub fn last_error(&self) -> Option<String> {
        self.shared.lock().unwrap().last_error.clone()
    }
}

impl Drop for Follower {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Relaxed);
    }
}

/// `GET <url>` through ureq — DNS, TLS and plain HTTP all handled. Used
/// for relay room URLs and for `http://…` share links alike.
fn fetch_broadcast_url(url: &str) -> Result<Option<Broadcast>, String> {
    let resp = ureq::get(url)
        .timeout(Duration::from_secs(4))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(403, _) => "bad session link".to_string(),
            ureq::Error::Status(404, _) => "room not found".to_string(),
            other => other.to_string(),
        })?;
    // Relays report how long ago the host last pushed; past the freshness
    // window the cached body is a dead session's leftover — treat it as no
    // broadcast so followers release instead of rewinding into stale data.
    if resp
        .header("x-room-age-ms")
        .and_then(|v| v.parse::<u64>().ok())
        .map(|age| age > ROOM_PUSH_STALE_MS)
        .unwrap_or(false)
    {
        return Ok(None);
    }
    let text = resp
        .into_string()
        .map_err(|_| "bad state payload".to_string())?;
    let mut b: Option<Broadcast> =
        serde_json::from_str(&text).map_err(|_| "bad state payload".to_string())?;
    if let Some(b) = b.as_mut() {
        b.received_at = Some(Instant::now());
    }
    Ok(b)
}

/// A relay room untouched for longer than this is a dead host's cache —
/// live hosts push every ~700ms (heartbeat at least every few seconds).
const ROOM_PUSH_STALE_MS: u64 = 8_000;

/// WAN host: pushes each Now Playing snapshot to `<relay>/<key>` on a
/// `relay::Relay` room store (~1 Hz when dirty). Followers join the
/// share URL — the same path — so internet listeners work without port
/// forwarding.
pub struct RelayHost {
    shared: Arc<Mutex<HostShared>>,
    alive: Arc<AtomicBool>,
    peers: Arc<Mutex<usize>>,
    last_error: Arc<Mutex<Option<String>>>,
    /// `http(s)://relay/<key>` — what friends paste to join.
    pub url: String,
    pub key: String,
}

impl RelayHost {
    /// `relay_base` like `http://localhost:8787` or `https://relay.example`.
    /// None when the base URL is unusable.
    pub fn start(relay_base: &str, host_name: impl Into<String>) -> Option<Self> {
        let base = relay_base.trim().trim_end_matches('/');
        if !(base.starts_with("http://") || base.starts_with("https://")) {
            return None;
        }
        let key = session_key();
        // Second token, never in the share URL — the relay binds it to the
        // room on first POST so link-holders can't overwrite broadcasts.
        let host_secret = session_key();
        let url = format!("{base}/{key}");
        let shared = Arc::new(Mutex::new(HostShared {
            np: None,
            host_name: host_name.into(),
            key: key.clone(),
            seq: 0,
            peers: HashMap::new(),
        }));
        let alive = Arc::new(AtomicBool::new(true));
        let peers = Arc::new(Mutex::new(0usize));
        let last_error = Arc::new(Mutex::new(None::<String>));
        {
            let s = Arc::clone(&shared);
            let a = Arc::clone(&alive);
            let p = Arc::clone(&peers);
            let e = Arc::clone(&last_error);
            let post = url.clone();
            std::thread::spawn(move || {
                let mut posted_seq = 0u64;
                let mut last_push = Instant::now() - Duration::from_secs(60);
                while a.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(700));
                    let (seq, body) = {
                        let s = s.lock().unwrap();
                        let body = match &s.np {
                            Some(np) => serde_json::to_string(&Broadcast {
                                host: s.host_name.clone(),
                                np: np.clone(),
                                sent_at_ms: now_ms(),
                                seq: s.seq,
                                received_at: None,
                            })
                            .unwrap_or_else(|_| "null".into()),
                            None => "null".into(),
                        };
                        (s.seq, body)
                    };
                    // Heartbeat: a paused host's seq never changes, but the
                    // room must stay warm or followers drop after the TTL.
                    if seq == posted_seq && last_push.elapsed() < Duration::from_secs(3) {
                        continue;
                    }
                    match ureq::post(&post)
                        .timeout(Duration::from_secs(4))
                        .set("Content-Type", "application/json")
                        .set("X-Host-Secret", &host_secret)
                        .send_string(&body)
                    {
                        Ok(resp) => {
                            posted_seq = seq;
                            last_push = Instant::now();
                            *e.lock().unwrap() = None;
                            if let Ok(Ok(v)) = resp
                                .into_string()
                                .map(|s| serde_json::from_str::<serde_json::Value>(&s))
                            {
                                if let Some(n) = v.get("peers").and_then(|n| n.as_u64()) {
                                    *p.lock().unwrap() = n as usize;
                                }
                            }
                        }
                        Err(err) => {
                            *e.lock().unwrap() = Some(format!("relay unreachable: {err}"));
                        }
                    }
                }
            });
        }
        Some(Self {
            shared,
            alive,
            peers,
            last_error,
            url,
            key,
        })
    }

    pub fn share_url(&self) -> Option<String> {
        Some(self.url.clone())
    }

    /// Same local-path stripping as `Host::publish`.
    pub fn publish(&self, np: &NowPlaying) {
        let mut np = np.clone();
        if let Some(t) = np.track.as_mut() {
            t.id = format!("{}:{}:{}", np.source, t.artist, t.title);
            if !t.artwork_url.starts_with("http") {
                t.artwork_url.clear();
            }
        }
        let mut s = self.shared.lock().unwrap();
        s.np = Some(np);
        s.seq += 1;
    }

    /// Follower count reported by the relay on the last push.
    pub fn peers(&self) -> usize {
        *self.peers.lock().unwrap()
    }

    pub fn name(&self) -> String {
        self.shared.lock().unwrap().host_name.clone()
    }

    /// Why the last push failed — surfaced so a dead relay doesn't look
    /// like an active session in the UI.
    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().unwrap().clone()
    }
}

impl Drop for RelayHost {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Relaxed);
    }
}

/// Split `addr` into (`ip:port`, optional session key from the URL path).
fn normalize_addr(addr: &str) -> (String, Option<String>) {
    let a = addr.trim().trim_end_matches('/');
    let a = a
        .strip_prefix("http://")
        .or_else(|| a.strip_prefix("https://"))
        .unwrap_or(a);
    let (host, key) = match a.split_once('/') {
        // `/state` from older URLs isn't a key; anything else is.
        Some((h, p)) => {
            let p = p.trim_matches('/');
            (h, (!p.is_empty() && p != "state").then(|| p.to_string()))
        }
        None => (a, None),
    };
    let host = if host.contains(':') {
        host.to_string()
    } else {
        format!("{host}:{LISTEN_PORT}")
    };
    (host, key)
}

/// `GET /<key>` against `ip:port` — minimal blocking client, bounded to
/// ~3s total so a hostile endpoint can't stall the caller.
fn fetch_broadcast(addr: &str, key: Option<&str>) -> Result<Option<Broadcast>, String> {
    let sock: std::net::SocketAddr = addr
        .parse()
        .map_err(|_| "bad address (expected ip:port)".to_string())?;
    let mut stream = TcpStream::connect_timeout(&sock, Duration::from_millis(1_500))
        .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(1_500)))
        .ok();
    let req = format!(
        "GET /{} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
        key.unwrap_or("")
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| e.to_string())?;
    let started = Instant::now();
    let mut buf = Vec::with_capacity(8192);
    let mut chunk = [0u8; 8192];
    loop {
        if started.elapsed() > Duration::from_secs(3) {
            return Err("response timed out".into());
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > MAX_BODY {
                    return Err("response too large".into());
                }
            }
            Err(_) => break,
        }
    }
    let head = String::from_utf8_lossy(&buf);
    if head.starts_with("HTTP/1.1 403") || head.starts_with("HTTP/1.0 403") {
        return Err("bad session link".into());
    }
    let head_end = find(&buf, b"\r\n\r\n").ok_or("not an HTTP response")? + 4;
    let mut b: Option<Broadcast> =
        serde_json::from_slice(&buf[head_end..]).map_err(|_| "bad state payload".to_string())?;
    if let Some(b) = b.as_mut() {
        b.received_at = Some(Instant::now());
    }
    Ok(b)
}

/// What the follower should do to converge on the host's state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncAction {
    Nothing,
    /// Host plays a track the follower doesn't have loaded: the caller
    /// must locate it in the local library (by title/artist), then seek.
    FindTrack {
        title: String,
        artist: String,
        position_ms: u64,
        playing: bool,
    },
    /// Same track, position drifted: hard seek.
    Seek(u64),
    Pause,
    Resume,
}

/// Pure sync rule: compare the host broadcast with the local now-playing.
/// `drift_ms` is the tolerance before seeking.
pub fn sync_decision(host: &Broadcast, local: Option<&NowPlaying>, drift_ms: u64) -> SyncAction {
    let Some(ht) = &host.np.track else {
        // Host stopped entirely — pause if we were following along.
        return match local.map(|l| l.status) {
            Some(PlaybackStatus::Playing) => SyncAction::Pause,
            _ => SyncAction::Nothing,
        };
    };
    let host_pos = host.position_ms();
    let host_playing = host.np.status == PlaybackStatus::Playing;

    let same = local
        .and_then(|l| l.track.as_ref())
        .map(|lt| {
            lt.id == ht.id
                || (norm(&lt.title) == norm(&ht.title) && norm(&lt.artist) == norm(&ht.artist))
        })
        .unwrap_or(false);
    if !same {
        return SyncAction::FindTrack {
            title: ht.title.clone(),
            artist: ht.artist.clone(),
            position_ms: host_pos,
            playing: host_playing,
        };
    }
    let local = local.unwrap();
    if !host_playing {
        return match local.status {
            PlaybackStatus::Playing => SyncAction::Pause,
            // Host scrubbed a paused track: converge position too.
            _ if local.position_ms.abs_diff(host_pos) > drift_ms => SyncAction::Seek(host_pos),
            _ => SyncAction::Nothing,
        };
    }
    let drift = local.position_ms.abs_diff(host_pos);
    if drift > drift_ms {
        return SyncAction::Seek(host_pos);
    }
    match local.status {
        PlaybackStatus::Playing => SyncAction::Nothing,
        // Stopped (queue ended) restarts via the same Resume path — the
        // apply layer reloads the selected item.
        _ => SyncAction::Resume,
    }
}

/// Case/space-insensitive compare for the fuzzy title+artist match.
pub fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::Track;

    fn np(title: &str, artist: &str, pos: u64, status: PlaybackStatus) -> NowPlaying {
        NowPlaying {
            track: Some(Track {
                id: format!("x:{artist}:{title}"),
                title: title.into(),
                artist: artist.into(),
                album: String::new(),
                artwork_url: String::new(),
                duration_ms: 200_000,
            }),
            status,
            position_ms: pos,
            source: "test".into(),
            updated_at_ms: 0,
        }
    }

    fn b(np: NowPlaying) -> Broadcast {
        Broadcast {
            host: "host".into(),
            np,
            sent_at_ms: now_ms(),
            seq: 1,
            received_at: Some(Instant::now()),
        }
    }

    #[test]
    fn different_track_requests_find() {
        let d = sync_decision(
            &b(np("A", "X", 5_000, PlaybackStatus::Playing)),
            Some(&np("B", "Y", 5_000, PlaybackStatus::Playing)),
            DRIFT_MS,
        );
        assert!(matches!(d, SyncAction::FindTrack { .. }));
    }

    #[test]
    fn fuzzy_match_avoids_find() {
        let d = sync_decision(
            &b(np("A Song", "X", 5_000, PlaybackStatus::Playing)),
            Some(&np("a  song", "x", 5_100, PlaybackStatus::Playing)),
            DRIFT_MS,
        );
        assert_eq!(d, SyncAction::Nothing);
    }

    #[test]
    fn drift_seeks() {
        let d = sync_decision(
            &b(np("A", "X", 20_000, PlaybackStatus::Playing)),
            Some(&np("A", "X", 5_000, PlaybackStatus::Playing)),
            DRIFT_MS,
        );
        assert_eq!(d, SyncAction::Seek(20_000));
    }

    #[test]
    fn host_pause_pauses() {
        let d = sync_decision(
            &b(np("A", "X", 5_000, PlaybackStatus::Paused)),
            Some(&np("A", "X", 5_000, PlaybackStatus::Playing)),
            DRIFT_MS,
        );
        assert_eq!(d, SyncAction::Pause);
    }

    #[test]
    fn paused_host_drift_seeks() {
        // Both paused at different positions: still converge.
        let d = sync_decision(
            &b(np("A", "X", 65_000, PlaybackStatus::Paused)),
            Some(&np("A", "X", 15_000, PlaybackStatus::Paused)),
            DRIFT_MS,
        );
        assert_eq!(d, SyncAction::Seek(65_000));
    }

    #[test]
    fn stopped_follower_resumes() {
        let d = sync_decision(
            &b(np("A", "X", 1_000, PlaybackStatus::Playing)),
            Some(&np("A", "X", 1_000, PlaybackStatus::Stopped)),
            DRIFT_MS,
        );
        assert_eq!(d, SyncAction::Resume);
    }

    #[test]
    fn host_play_resumes() {
        let d = sync_decision(
            &b(np("A", "X", 5_000, PlaybackStatus::Playing)),
            Some(&np("A", "X", 5_000, PlaybackStatus::Paused)),
            DRIFT_MS,
        );
        assert_eq!(d, SyncAction::Resume);
    }

    #[test]
    fn host_stopped_pauses_local() {
        let mut host = np("A", "X", 0, PlaybackStatus::Stopped);
        host.track = None;
        let d = sync_decision(
            &b(host),
            Some(&np("A", "X", 5_000, PlaybackStatus::Playing)),
            DRIFT_MS,
        );
        assert_eq!(d, SyncAction::Pause);
    }

    #[test]
    fn addr_normalization() {
        assert_eq!(
            normalize_addr("192.168.1.5"),
            ("192.168.1.5:17894".to_string(), None)
        );
        assert_eq!(
            normalize_addr("http://192.168.1.5:9999"),
            ("192.168.1.5:9999".to_string(), None)
        );
        assert_eq!(
            normalize_addr("10.0.0.2:17894/"),
            ("10.0.0.2:17894".to_string(), None)
        );
        assert_eq!(
            normalize_addr("10.0.0.2:1/state"),
            ("10.0.0.2:1".to_string(), None)
        );
        assert_eq!(
            normalize_addr("http://10.0.0.2:17894/abcdef0123456789"),
            (
                "10.0.0.2:17894".to_string(),
                Some("abcdef0123456789".to_string())
            )
        );
    }

    #[test]
    fn host_serves_state() {
        let host = Host::start("test host", 19_994).unwrap();
        host.publish(&np("Song", "Artist", 1_234, PlaybackStatus::Playing));
        // Wrong/no key → 403.
        assert!(fetch_broadcast("127.0.0.1:19994", None).is_err());
        let got = fetch_broadcast("127.0.0.1:19994", Some(&host.key))
            .unwrap()
            .unwrap();
        assert_eq!(got.host, "test host");
        assert_eq!(got.np.track.unwrap().title, "Song");
    }

    #[test]
    fn publish_strips_local_paths() {
        let host = Host::start("p", 19_995).unwrap();
        let mut n = np("Song", "Artist", 0, PlaybackStatus::Playing);
        n.track.as_mut().unwrap().id = "/home/fausto/Music/song.mp3".into();
        n.track.as_mut().unwrap().artwork_url = "/home/fausto/.cache/art.jpg".into();
        host.publish(&n);
        let got = fetch_broadcast("127.0.0.1:19995", Some(&host.key))
            .unwrap()
            .unwrap();
        let raw = serde_json::to_string(&got).unwrap();
        assert!(!raw.contains("/home/fausto"));
        assert!(!got.np.track.as_ref().unwrap().id.contains('/'));
    }

    #[test]
    fn relay_roundtrip() {
        // In-process WAN path: relay room + RelayHost push + Follower join.
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let relay = crate::relay::Relay::on(listener).unwrap();
        let base = format!("http://{}", relay.addr);

        let host = RelayHost::start(&base, "wan host").unwrap();
        host.publish(&np(
            "Relay Song",
            "Relay Artist",
            9_000,
            PlaybackStatus::Playing,
        ));
        // The room exists only after the host's first push lands.
        let mut follower = None;
        for _ in 0..20 {
            match Follower::join(&host.url) {
                Ok(f) => {
                    follower = Some(f);
                    break;
                }
                Err(_) => std::thread::sleep(Duration::from_millis(150)),
            }
        }
        let follower = follower.expect("follower should join the relay room");
        let b = follower.latest().expect("broadcast should arrive");
        assert_eq!(b.host, "wan host");
        assert_eq!(b.np.track.unwrap().title, "Relay Song");
    }

    #[test]
    fn relay_host_rejects_bad_base() {
        assert!(RelayHost::start("not-a-url", "x").is_none());
        assert!(RelayHost::start("", "x").is_none());
    }
}
