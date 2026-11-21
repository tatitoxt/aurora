# Aurora / Noctbeat — internal contract

This file is the single source of truth for module boundaries. Every feature
branch implements against these signatures so the parts merge without
renaming. If you must change the contract, change this file AND every caller.

## Layout

```
branding.json                 product name/ids/domains (rename = this file + `pnpm branding`)
scripts/sync-branding.mjs     regenerates tauri.conf.json, src/branding.ts, site/branding.js
crates/noctbeat-core/         pure Rust logic, no UI deps — must test clean headless
src-tauri/                    Tauri 2 shell: commands, windows, tray
src/                          React + TS + Vite frontend (player window UI)
site/                         static landing page (vanilla, EN/ES toggle)
e2e/                          WebdriverIO + tauri-driver specs
docs/                         this file + design notes
bench/                        resource profiling script
```

## Rust: `noctbeat-core`

`src/media/mod.rs` (already on main — do not change signatures):

- `Track { id, title, artist, album, artwork_url, duration_ms }`
- `PlaybackStatus { Playing, Paused, Stopped }`
- `NowPlaying { track: Option<Track>, status, position_ms, updated_at_ms }`
- `Control { PlayPause, Next, Previous }`
- `trait NowPlayingSource { name(), poll(), control() }`
- `NullSource`, `DemoSource` (`media/demo.rs`), `platform_source()`

### media implementations (branch `devin/core-media`, files `src/media/{mpris,osascript,smtc}.rs`)

- `MprisSource::new() -> Result<Self, MediaError>` (Linux; zbus blocking,
  `org.mpris.MediaPlayer2.*` — pick first available player; control via
  `PlayPause`/`Next`/`Previous` on `org.mpris.MediaPlayer2.Player`).
- `OsascriptSource::new() -> Self` (macOS; shell out to `osascript` for
  Music.app then Spotify; parse its output in a pure, unit-tested function).
- `SmtcSource::new() -> Result<Self, MediaError>` (Windows; `windows` crate,
  `GlobalSystemMediaTransportControlsSessionManager`).

### palette (branch `devin/core-analysis`, `src/palette.rs`)

```rust
pub struct Rgb(pub u8, pub u8, pub u8);
pub struct Palette { pub dominant: Rgb, pub accents: Vec<Rgb> } // accents: up to 4, vibrancy-sorted
pub fn extract_palette(pixels: &[u8], width: u32, height: u32) -> Palette // RGB8, k-means k<=6, deterministic seeding
pub fn to_hex(c: Rgb) -> String // "#rrggbb"
```

### lyrics (branch `devin/core-analysis`, `src/lyrics.rs`)

```rust
pub struct LrcLine { pub at_ms: u64, pub text: String, pub words: Option<Vec<LrcWord>> }
// words: enhanced-LRC (A2) `<mm:ss.xx>` inline word timings, when present
pub fn parse_lrc(input: &str) -> Vec<LrcLine>        // multiple timestamps per line supported
pub fn active_line(lines: &[LrcLine], pos_ms: u64) -> Option<usize>
pub struct LrclibClient { /* base_url injectable */ }
impl LrclibClient {
    pub fn new() -> Self;
    pub fn fetch(&self, track: &crate::media::Track) -> Result<Option<Vec<LrcLine>>, LyricsError>;
}
pub struct LyricsCache { /* dir-based, keyed by track.id hash, ttl_ms */ }
```

### energy (branch `devin/core-analysis`, `src/energy.rs`)

```rust
pub struct BeatDetector { /* windowed RMS + onset flux, adaptive threshold */ }
impl BeatDetector {
    pub fn new(sample_rate: u32) -> Self;
    pub fn push(&mut self, samples: &[f32]) -> EnergyUpdate; // mono f32 in [-1,1]
}
pub struct EnergyUpdate { pub level: f32 /* 0..1 smoothed */, pub beat: bool, pub bpm: Option<f32> }
```

### settings (branch `devin/core-config`, `src/settings.rs`)

```rust
pub struct DisplayRule { pub display_id: String, pub enabled: bool }
pub enum ColorMode { Artwork, Custom } // serde tag="mode", snake_case
pub struct Settings {
    pub version: u32,              // 1
    pub edge_thickness_px: u32,    // default 24
    pub glow_strength: f32,        // 0..1, default 0.7
    pub brightness: f32,           // 0..1, default 0.8
    pub color_mode: ColorMode,
    pub custom_color: String,      // "#rrggbb"
    pub battery_saver: bool,
    pub hide_in_fullscreen: bool,  // default true
    pub displays: Vec<DisplayRule>,
    pub license_key: Option<String>,
    pub hud_enabled: bool,         // floating HUD window, default true
    pub hud_always_on_top: bool,   // pin HUD above other windows, default true
    pub hud_position: Option<(i32, i32)>,  // persisted drag position
    pub music_dir: Option<String>,
    pub ytdlp_path: Option<String>,
    pub theme: ThemeSettings,              // preset name + accent overrides
    pub lyrics_mode: String,               // "lines" (default) | "karaoke"
    pub video_backdrop: bool,              // karaoke plays the music video, default true
    pub desk_lyrics_enabled: bool,         // floating lyrics overlay, default false
    pub desk_lyrics_position: Option<(i32, i32)>,  // persisted drag position
    pub audio_output: Option<String>,      // sink device name, None = OS default
    pub eq_preset: String,                 // "flat"|"bass"|"vocal"|"treble"|"custom"
    pub eq_bands: Vec<f32>,                // dB per band (60/250/1k/4k/12k), empty = flat
}
impl Settings { pub fn load(path: &Path) -> Self; pub fn save(&self, path: &Path) -> io::Result<()>; }
// load(): missing file -> defaults; older version -> migrate; corrupt -> defaults (never panic)
```

### player + library (`src/player.rs`, `src/library.rs`)

```rust
pub struct QueueItem { pub track: Track, pub path: String }
pub trait AudioOut: Send + Sync {          // audio device behind a trait
    fn open(&self, path: &str) -> Result<Option<u64>, String>; // -> duration ms
    fn play(&self); fn pause(&self);
    fn position_ms(&self) -> u64;
    fn seek(&self, position_ms: u64) -> Result<(), String>;
    fn set_volume(&self, v: f32);
    fn is_finished(&self) -> bool;
}
pub struct NullAudio;                       // silent impl for tests/headless
pub struct LocalPlayer;                     // implements NowPlayingSource
impl LocalPlayer {
    pub fn new(audio: Arc<dyn AudioOut>) -> Self;
    pub fn queue(&self) -> &[QueueItem];
    pub fn current_index(&self) -> Option<usize>;
    pub fn status(&self) -> PlaybackStatus;
    pub fn set_queue(&mut self, items: Vec<QueueItem>);
    pub fn add(&mut self, item: QueueItem);
    pub fn clear(&mut self);
    pub fn play_index(&mut self, i: usize) -> Result<(), String>;
    pub fn seek(&self, ms: u64) -> Result<(), String>;
    pub fn set_volume(&self, v: f32);
    pub fn tick(&mut self) -> NowPlaying;  // auto-advances on track end
}
// library.rs: scan(dir) -> Vec<QueueItem>  (walkdir + lofty tags/artwork)
// The local player wins now-playing + transport while status != Stopped.

### licensing (branch `devin/core-config`, `src/licensing.rs`)

Vendor: Lemon Squeezy `POST {base}/v1/licenses/validate` with `license_key`,
`instance_name`. HTTP behind a `trait Http { fn post_json(&self, url, body) -> Result<String, String> }`
so tests mock it. `validate(key, hwid) -> LicenseState { Valid{..}, Invalid, Offline{grace_until_ms} }`.
Offline grace: 72h from last successful validation (persisted next to settings as
`license.json`). Entire module also compiles with real `ureq` impl `UreqHttp`.

## Tauri commands (branch `devin/tauri-shell` implements; frontend calls exactly these)

All via `invoke`, camelCase names:

| command                | args                                   | returns                       |
|------------------------|----------------------------------------|-------------------------------|
| `getNowPlaying`        | —                                      | `NowPlaying`                  |
| `mediaControl`         | `{ cmd: "play-pause"\|"next"\|"previous" }` | `null`                    |
| `getPalette`           | `{ artworkUrl: string }`               | `Palette`-shaped hex strings  |
| `getLyrics`            | —                                      | `LrcLine[] \| null`           |
| `getSettings`          | —                                      | `Settings`                    |
| `updateSettings`       | `{ settings: Settings }`               | `null`                        |
| `getLicenseState`      | —                                      | `LicenseState`                |
| `activateLicense`      | `{ key: string }`                      | `LicenseState`                |
| `getEnergy`            | —                                      | `EnergyUpdate`                |
| `listDisplays`         | —                                      | `{ id, name, primary }[]`     |
| `setHudPinned`         | `{ pinned: boolean }`                  | `null`                        |
| `hudStartDrag`         | —                                      | `null`                        |
| `deskLyricsStartDrag`  | —                                      | `null`                        |
| `showPlayer`           | —                                      | `null`                        |
| `seek`                 | `{ positionMs: number }`               | `null` (local only)           |
| `setVolume`            | `{ volume: number }`                   | `null`                        |
| `getQueue`             | —                                      | `{ items, currentIndex }`     |
| `playQueueIndex`       | `{ index: number }`                    | `null`                        |
| `clearQueue`           | —                                      | `null`                        |
| `scanLibrary`          | `{ dir?: string }`                     | `QueueItem[]`                 |
| `providerStatus`       | —                                      | `boolean` (yt-dlp detected)   |
| `providerSearch`       | `{ source, query }`                    | `RemoteTrack[]`               |
| `providerPlay`         | `{ track: RemoteTrack }`               | `QueueItem`                   |
| `listOutputs`          | —                                      | `string[]` (sink names)       |
| `setOutputDevice`      | `{ name: string \| null }`              | `null` (swaps sink live)      |
| `setEq`                | `{ preset, bands: number[] }`          | `null` (retunes live)         |

Events emitted to frontend: `now-playing` (NowPlaying), `energy` (EnergyUpdate).

Demo mode: env `NOCTBEAT_DEMO=1` forces `DemoSource`. Overlay windows are
`edge-<displayId>` labels, transparent, click-through, always-on-top,
decorations off, sized to the monitor; the frontend route `/edge` renders the
glow; `/` is the mini player. The `hud` window is a 460x76 borderless
transparent pill serving `/hud`; it is dragged via `hudStartDrag`, pinned via
`setHudPinned`, and its position is persisted on the OS Moved event. Toggling
`hudEnabled` in settings opens/closes it (tray: "Floating HUD"). The
`desklyrics` window is a 720x170 borderless transparent overlay serving
`/desklyrics` — the karaoke line always on top — dragged via
`deskLyricsStartDrag` with its position persisted the same way; toggled by
`deskLyricsEnabled` (tray: "Desktop lyrics").

## Frontend (branch `devin/frontend`, everything under `src/`)

- `src/bridge.ts`: calls `invoke` when `window.__TAURI_INTERNALS__` exists,
  otherwise a browser mock identical to `DemoSource` (same playlist/titles)
  so `pnpm dev` works with no Rust.
- Routes: `/` mini player, `/edge` glow overlay, `/settings` panel,
  `/hud` floating pill, `/desklyrics` karaoke overlay, `/library` local queue.
- Design: dark, frosted glass (backdrop-filter), thin wordmark, no emoji.
- Tests: Vitest + Testing Library; test the mock bridge and pure helpers.
- `src/branding.ts` is generated — import from it, never hard-code the name.

## Site (branch `devin/site`, everything under `site/`)

Static `index.html` + `styles.css` + `app.js`, reads `site/branding.js`.
EN default with ES toggle (`?lang=es`, persisted in localStorage).
Sections: hero, features (edge light / player / lyrics / low footprint),
pricing (one-time license, `checkoutUrl`), download (macOS/Windows/Linux).
Playwright spec in `e2e/site.spec.ts` asserts wordmark, lang toggle, links.

## Commands

```
node scripts/sync-branding.mjs   # regenerate branding outputs (predev/prebuild)
cargo test -p noctbeat-core      # core unit tests — must pass headless
pnpm install && pnpm test        # frontend unit tests
pnpm build                       # vite build
pnpm exec playwright test        # site e2e (serves site/ statically)
cargo tauri build                # desktop bundle (needs webkit2gtk on Linux)
```

## providers module (noctbeat-core)

`providers` wraps an external `yt-dlp` binary: `search` maps
`<source>search<N>:` result JSON to `RemoteTrack`, `download` fetches the
best decodable audio (m4a/AAC preferred — rodio has no opus codec) into the
app cache, and `provider_play` enqueues the file like a local track. The
binary is optional (`settings.ytdlp_path` or PATH); commands error cleanly
when it is absent.

`resolve_video(artist, title)` additionally maps a track to a direct video
stream URL (`ytsearch1:` + `-g`, progressive mp4 <=480p preferred) for the
karaoke backdrop; the player `<video>` renders it muted and blurred in sync
with the track position, and falls back to blurred artwork when yt-dlp is
missing or no video resolves.

Audio output devices are enumerated via cpal (`list_outputs`); `set_output_device`
swaps the rodio sink live and `LocalPlayer::reopen_current` re-opens the track
at its position so playback resumes — useful for routing to a Bluetooth speaker
paired in the OS. The choice persists as `settings.audio_output`.

`noctbeat-core::eq` is a 5-band peaking biquad EQ (60/250/1k/4k/12k Hz, RBJ
cookbook). `EqState` shares gains via atomics and a generation counter; each
decoded source is wrapped in `EqSource` (src-tauri) which retunes its `EqBank`
lock-free when the generation changes — sliders and presets apply live without
restarting the track. `set_eq` persists `eq_preset`/`eq_bands` and the startup
path re-applies them.

## Non-negotiables

- No placeholder/dead features; every UI element works or is absent.
- No real license keys, no secrets, no vendor lock-in strings outside branding.json.
- `cargo fmt`, `cargo clippy -D warnings`, `tsc --noEmit` all clean.
