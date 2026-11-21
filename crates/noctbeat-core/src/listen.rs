//! Listen Along: LAN host/follower sync. A host publishes its Now Playing
//! snapshot on `GET /state`; followers poll it and mirror transport state
//! (track, position, play/pause) against their own local library.
//!
//! v1 is LAN-only: no accounts, no relay — the host serves on
//! `0.0.0.0:LISTEN_PORT` and friends on the same network join by address.
//! Remote listeners need port forwarding or a tailnet today; a real relay
//! is the roadmap item.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::media::{now_ms, NowPlaying, PlaybackStatus};

pub const LISTEN_PORT: u16 = 17894;
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
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(&mut b).is_ok() {
            return b.iter().map(|x| format!("{x:02x}")).collect();
        }
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

impl Follower {
    /// Join `addr` (`ip`, `ip:port` or a `http://ip:port/<key>` share URL).
    /// Validates by fetching state once; Err means unreachable or bad key.
    pub fn join(addr: &str) -> Result<Self, String> {
        let (addr, key) = normalize_addr(addr);
        // One probe up front so join() can fail fast on a bad address.
        let b = fetch_broadcast(&addr, key.as_deref()).map_err(|e| format!("{addr}: {e}"))?;
        let shared = Arc::new(Mutex::new(FollowShared {
            latest: b.clone().map(|b| (Instant::now(), b)),
            host_name: b.map(|x| x.host),
            last_error: None,
        }));
        let alive = Arc::new(AtomicBool::new(true));
        let s = Arc::clone(&shared);
        let a = Arc::clone(&alive);
        let worker_addr = addr.clone();
        std::thread::spawn(move || {
            while a.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(800));
                match fetch_broadcast(&worker_addr, key.as_deref()) {
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
            addr,
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
}
