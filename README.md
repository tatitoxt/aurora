# Noctbeat

A thin ribbon of light along your screen edges that breathes with your music — plus a glass mini player with synced lyrics and per-display control. Open core: the engine (`crates/noctbeat-core`) is MIT-licensed; signed, licensed builds are the commercial product.

**Stack:** Tauri 2 · Rust core · React 18 + TypeScript + Vite · static landing in `site/`.

## Features

- **Edge-light overlay** — transparent, click-through, always-on-top window per display; glow follows the beat and tints from album art.
- **Now Playing** — MPRIS (Linux), `osascript` Spotify/Music (macOS), SMTC (Windows).
- **Palette extraction** — deterministic k-means over artwork, in Rust.
- **Beat energy** — onset detection in `noctbeat-core`; demo mode synthesizes a 120 BPM grid.
- **Glass mini player** — artwork, transport, progress, and LRCLIB-synced lyrics with a local cache.
- **Settings** — thickness, glow, brightness, artwork/custom color, per-display toggles, battery-saver, hide-in-fullscreen. Persisted to the OS config dir.
- **Licensing** — Lemon Squeezy validation with a 72 h offline grace; no keys in the repo.

## Run

```bash
pnpm install
NOCTBEAT_DEMO=1 pnpm tauri dev      # demo source, no real player needed
```

Without `NOCTBEAT_DEMO` it talks to the OS media APIs (see above).

## Test

```bash
cargo test --workspace             # 30 core unit tests, headless
pnpm test                          # vitest (bridge + lyrics + pulse logic)
pnpm test:site                     # Playwright landing tests (EN/ES)
xvfb-run node e2e/app.test.mjs     # tauri-driver smoke in demo mode
```

## Honest status

Verified locally: all core unit tests, frontend build/tests, landing Playwright tests, `cargo check` of the Tauri shell on Linux. macOS (`osascript`) and Windows (SMTC) sources compile-gate on their OSes in CI — real-device validation pending. Loopback audio capture is not wired yet: in demo mode energy is a documented synthetic grid, and on real playback the level uses playback state only until capture lands — the code is explicit about this rather than faking a spectrum. Selling builds requires signing + a Lemon Squeezy store; see `RELEASING.md`.

## Rename

Everything user-facing flows from `branding.json` → `pnpm branding`. See `RENAMING.md`.
