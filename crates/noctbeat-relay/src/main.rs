//! Noctbeat listen-along relay: a dumb room store for WAN sessions.
//! Hosts POST their Now Playing broadcast to `/<key>`; followers GET it.
//! Rooms expire ~90 s after the host stops pushing.
//!
//! `PORT` env selects the port (default 8787). Runs behind a
//! TLS-terminating edge in production.

fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787);
    let relay = noctbeat_core::relay::Relay::start(port)
        .unwrap_or_else(|| panic!("could not bind port {port}"));
    eprintln!("noctbeat-relay listening on {}", relay.addr);
    // Keep the process alive; the accept loop runs on its own thread.
    loop {
        std::thread::park();
    }
}
