//! WAN relay for Listen Along: a dumb room store. The host POSTs its
//! latest Broadcast to `/<key>`; followers GET the same path. No accounts,
//! no persistence — rooms expire when the host stops pushing.
//!
//! Deployed behind a TLS-terminating edge this turns the LAN-only
//! host/follower pair into one that works across the internet: the share
//! URL is `https://<relay>/<key>` and `Follower::join` fetches it directly.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Rooms idle longer than this are dropped — the host pushes ~1Hz, so a
/// minute and a half of silence means the session ended.
const ROOM_TTL: Duration = Duration::from_secs(90);
const MAX_BODY: usize = 256 * 1024;
/// A follower that fetched within this window counts as listening.
const PEER_FRESH: Duration = Duration::from_secs(15);

struct Room {
    body: Vec<u8>,
    touched: Instant,
    /// Follower IPs that fetched recently — reported back to the host.
    peers: HashMap<String, Instant>,
}

pub struct Relay {
    rooms: Arc<Mutex<HashMap<String, Room>>>,
    alive: Arc<AtomicBool>,
    /// Bound address as `ip:port` — port 0 binds report the real port.
    pub addr: String,
}

impl Relay {
    /// Listen on `0.0.0.0:port`. None if the bind fails.
    pub fn start(port: u16) -> Option<Self> {
        let listener = TcpListener::bind(("0.0.0.0", port)).ok()?;
        Self::on(listener)
    }

    /// Serve on an already-bound listener (tests use port 0).
    pub fn on(listener: TcpListener) -> Option<Self> {
        listener.set_nonblocking(true).ok()?;
        let addr = listener.local_addr().ok()?.to_string();
        let rooms: Arc<Mutex<HashMap<String, Room>>> = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let r = Arc::clone(&rooms);
        let a = Arc::clone(&alive);
        std::thread::spawn(move || {
            while a.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, peer)) => {
                        let r2 = Arc::clone(&r);
                        std::thread::spawn(move || serve(stream, peer.ip().to_string(), &r2));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(40)),
                }
            }
        });
        Some(Self { rooms, alive, addr })
    }

    /// Live room count (diagnostics/tests).
    pub fn rooms(&self) -> usize {
        self.rooms.lock().unwrap().len()
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Relaxed);
    }
}

fn serve(mut stream: TcpStream, ip: String, rooms: &Arc<Mutex<HashMap<String, Room>>>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let mut buf = Vec::with_capacity(16 * 1024);
    let mut chunk = [0u8; 8192];
    // Read until the head is complete plus the declared body.
    let (head_end, content_len) = loop {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > MAX_BODY + 8192 {
                    return;
                }
                if let Some(end) = find(&buf, b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..end]);
                    let len = head
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if buf.len() >= end + 4 + len {
                        break (end, len);
                    }
                    if len == 0 {
                        break (end, 0);
                    }
                }
            }
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut parts = head.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("").trim_matches('/');
    let body = buf[head_end + 4..head_end + 4 + content_len].to_vec();

    let mut g = rooms.lock().unwrap();
    g.retain(|_, r| r.touched.elapsed() < ROOM_TTL);
    match method {
        "PUT" | "POST" => {
            if body.is_empty() || body.len() > MAX_BODY {
                let _ = reply(&mut stream, 400, b"{}");
                return;
            }
            let room = g.entry(path.to_string()).or_insert_with(|| Room {
                body: Vec::new(),
                touched: Instant::now(),
                peers: HashMap::new(),
            });
            room.body = body;
            room.touched = Instant::now();
            room.peers.retain(|_, t| t.elapsed() < PEER_FRESH);
            let out = format!("{{\"peers\":{}}}", room.peers.len());
            let _ = reply(&mut stream, 200, out.as_bytes());
        }
        "GET" => {
            let Some(room) = g.get_mut(path) else {
                let _ = reply(&mut stream, 404, b"null");
                return;
            };
            room.peers.retain(|_, t| t.elapsed() < PEER_FRESH);
            room.peers.insert(ip, Instant::now());
            let body = room.body.clone();
            drop(g);
            let _ = reply(&mut stream, 200, &body);
        }
        _ => {
            let _ = reply(&mut stream, 405, b"{}");
        }
    }
}

fn reply(stream: &mut TcpStream, code: u16, body: &[u8]) -> std::io::Result<()> {
    let status = match code {
        200 => "200 OK",
        400 => "400 Bad Request",
        404 => "404 Not Found",
        405 => "405 Method Not Allowed",
        _ => "500",
    };
    stream.write_all(
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .as_bytes(),
    )?;
    stream.write_all(body)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}
