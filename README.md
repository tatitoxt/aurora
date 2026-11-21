# Noctbeat

A thin ribbon of light along your screen edges that breathes with your music — plus a glass mini player with synced lyrics and per-display control. Open core: the engine (`crates/noctbeat-core`) is MIT-licensed; signed, licensed builds are the commercial product.

**Stack:** Tauri 2 · Rust core · React 18 + TypeScript + Vite · static landing in `site/`.

## Features

- **Edge-light overlay** — transparent, click-through, always-on-top window per display; glow follows the beat and tints from album art.
- **Now Playing** — MPRIS (Linux), `osascript` Spotify/Music (macOS), SMTC (Windows).
- **Palette extraction** — deterministic k-means over artwork, in Rust.
- **Beat energy** — onset detection in `noctbeat-core`; demo mode synthesizes a 120 BPM grid.
- **Glass mini player** — artwork, transport, progress, and LRCLIB-synced lyrics with a local cache.
- **Fullscreen stage** — nine selectable looks (albums, arc, pearl, studio, spotlight, vision, dial, tile, showcase) with a giant clock, editable queue, cover carousel and a glass transport pill (shuffle, repeat, volume, sleep, settings).
- **Karaoke mode** — full-screen synced lyrics over the sharp music video, plus a floating desk-lyrics overlay window.
- **Library views** — artist pages (hero + popular + albums), an albums grid and detail pages, and a persistent Liked list driven by the heart on every surface.
- **Queue + playlists** — shuffle, repeat (off/all/one), reorder and remove mid-play, save as .m3u8, import .m3u/.pls/.xspf (files or URLs), rename and delete, drag & drop of files and folders.
- **Remote tracks** — YouTube/SoundCloud results enqueue as lazy `remote:` items that download only when they play; playback stays a one-click experience without wiping the queue.
- **Desktop integration** — global media keys (Windows/macOS), MPRIS2 server (Linux), tray transport controls with a live cover icon, now-playing notifications, resume-on-launch.
- **Settings** — thickness, glow, brightness, artwork/custom color, per-display toggles, battery-saver, hide-in-fullscreen. Persisted to the OS config dir.
- **Licensing** — Lemon Squeezy activate/deactivate with `instance_id`, a 72 h offline grace; no keys in the repo.
- **Themes + EQ** — Noct/Ember/Glacier/Mono presets plus custom accent colors, applied live; a 5-band biquad EQ with presets and an output-device picker.
- **Library + local playback** — scans a music folder (mp3/flac/ogg/m4a/aac/wav), queues and plays through an in-app rodio engine with seek and volume.
- **Listening stats** — play history, top tracks/artists, a daily activity strip and a monthly Wrapped page; stored locally.
- **Streaming search** — YouTube and SoundCloud track search via an optional `yt-dlp` binary; results join the queue lazily via `remote:` paths.

## Run

```bash
pnpm install
NOCTBEAT_DEMO=1 pnpm tauri dev      # demo source, no real player needed
```

Without `NOCTBEAT_DEMO` it talks to the OS media APIs (see above).

## Test

```bash
cargo test --workspace             # 100+ unit tests, headless
pnpm test                          # vitest (bridge + lyrics + pulse logic)
pnpm test:site                     # Playwright landing tests (EN/ES)
xvfb-run node e2e/app.test.mjs     # tauri-driver smoke in demo mode
```

## Honest status

Verified locally: all core unit tests, frontend build/tests, landing Playwright tests, `cargo check` of the Tauri shell on Linux. macOS (`osascript`) and Windows (SMTC) sources compile-gate on their OSes in CI — real-device validation pending. The visualizer spectrum comes from a PCM tap on the local playback path (a documented synthetic grid in demo mode); external-source capture is not wired yet. Selling builds requires signing + a Lemon Squeezy store; see `RELEASING.md`.

## Rename

Everything user-facing flows from `branding.json` → `pnpm branding`. See `RENAMING.md`.
