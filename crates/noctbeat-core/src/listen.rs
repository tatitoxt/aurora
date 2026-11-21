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
    seq: u64,
    peers: HashMap<String, Instant>,
}

pub struct Host {
    shared: Arc<Mutex<HostShared>>,
    alive: Arc<AtomicBool>,
    /// Our LAN address as `ip:port` for the share URL.
    pub addr: String,
}

impl Host {
    /// Start serving `GET /state` on `0.0.0.0:port`. None if the bind fails.
    pub fn start(host_name: impl Into<String>, port: u16) -> Option<Self> {
        let listener = TcpListener::bind(("0.0.0.0", port)).ok()?;
        listener.set_nonblocking(true).ok()?;
        let shared = Arc::new(Mutex::new(HostShared {
            np: None,
            host_name: host_name.into(),
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
                        serve_state(stream, &s);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(80));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(80)),
                }
            }
        });
        let addr = format!(
            "{}:{}",
            lan_ip().unwrap_or_else(|| "127.0.0.1".into()),
            port
        );
        Some(Self {
            shared,
            alive,
            addr,
        })
    }

    /// Publish the latest now-playing snapshot for followers.
    pub fn publish(&self, np: &NowPlaying) {
        let mut s = self.shared.lock().unwrap();
        s.np = Some(np.clone());
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
    // Consume the request head; only GET /state is served.
    let mut buf = [0u8; 2048];
    if stream.read(&mut buf).unwrap_or(0) == 0 {
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
/// interface without sending traffic.
pub fn lan_ip() -> Option<String> {
    let sock = std::net::UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    sock.connect("192.0.2.1:80").ok()?; // TEST-NET-1: routing only, no packets
    Some(sock.local_addr().ok()?.ip().to_string())
}

struct FollowShared {
    latest: Option<Broadcast>,
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
    /// Join `addr` (`ip:port` or `http://ip:port`). Validates by fetching
    /// state once; Err means the host is unreachable.
    pub fn join(addr: &str) -> Result<Self, String> {
        let addr = normalize_addr(addr);
        // One probe up front so join() can fail fast on a bad address.
        let b = fetch_broadcast(&addr).map_err(|e| format!("{addr}: {e}"))?;
        let shared = Arc::new(Mutex::new(FollowShared {
            latest: b.clone(),
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
                match fetch_broadcast(&worker_addr) {
                    Ok(mut b) => {
                        let mut g = s.lock().unwrap();
                        g.last_error = None;
                        if let Some(b) = b.take() {
                            g.host_name = Some(b.host.clone());
                            g.latest = Some(b);
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

    /// Latest host snapshot, if one was ever received.
    pub fn latest(&self) -> Option<Broadcast> {
        self.shared.lock().unwrap().latest.clone()
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

fn normalize_addr(addr: &str) -> String {
    let a = addr.trim().trim_end_matches('/');
    let a = a.strip_prefix("http://").unwrap_or(a);
    let a = a.strip_prefix('/').unwrap_or(a); // tolerate trailing /state etc
    let a = a.strip_suffix("/state").unwrap_or(a);
    if a.contains(':') {
        a.to_string()
    } else {
        format!("{a}:{LISTEN_PORT}")
    }
}

/// `GET /state` against `ip:port` — minimal blocking client, 1.5s timeout.
fn fetch_broadcast(addr: &str) -> Result<Option<Broadcast>, String> {
    let sock: std::net::SocketAddr = addr
        .parse()
        .map_err(|_| "bad address (expected ip:port)".to_string())?;
    let mut stream = TcpStream::connect_timeout(&sock, Duration::from_millis(1_500))
        .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(1_500)))
        .ok();
    stream
        .write_all(b"GET /state HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(8192);
    let mut chunk = [0u8; 8192];
    loop {
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
            _ => SyncAction::Nothing,
        };
    }
    let drift = local.position_ms.abs_diff(host_pos);
    if drift > drift_ms {
        return SyncAction::Seek(host_pos);
    }
    match local.status {
        PlaybackStatus::Playing => SyncAction::Nothing,
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
        assert_eq!(normalize_addr("192.168.1.5"), "192.168.1.5:17894");
        assert_eq!(
            normalize_addr("http://192.168.1.5:9999"),
            "192.168.1.5:9999"
        );
        assert_eq!(normalize_addr("10.0.0.2:17894/"), "10.0.0.2:17894");
        assert_eq!(normalize_addr("10.0.0.2:1/state"), "10.0.0.2:1");
    }

    #[test]
    fn host_serves_state() {
        let host = Host::start("test host", 19_994).unwrap();
        host.publish(&np("Song", "Artist", 1_234, PlaybackStatus::Playing));
        let got = fetch_broadcast("127.0.0.1:19994").unwrap().unwrap();
        assert_eq!(got.host, "test host");
        assert_eq!(got.np.track.unwrap().title, "Song");
    }
}
