// Typed bridge over the Tauri commands (docs/CONTRACT.md). In a plain browser
// (pnpm dev, tests) it serves the same demo playlist as Rust DemoSource.

import { branding } from "./branding";

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string;
  durationMs: number;
}
export type PlaybackStatus = "playing" | "paused" | "stopped";
export interface NowPlaying {
  track: Track | null;
  status: PlaybackStatus;
  positionMs: number;
  /** Which source produced this snapshot ("local", "mpris", "demo", ...). */
  source: string;
  updatedAtMs: number;
}
export type Control = "play-pause" | "next" | "previous";
export interface LrcLine {
  atMs: number;
  text: string;
  /** Enhanced-LRC word timestamps when the source provides them. */
  words?: { atMs: number; text: string }[] | null;
}
export interface EnergyUpdate {
  level: number;
  beat: boolean;
  bpm?: number;
  bands: number[];
}
export interface Settings {
  version: number;
  /** Track artwork + beat/progress ring in the tray icon. */
  trayLiveIcon: boolean;
  licenseKey: string | null;
  hudEnabled: boolean;
  hudAlwaysOnTop: boolean;
  hudPosition: [number, number] | null;
  musicDir: string | null;
  theme: ThemeSettings;
  /** "lines" (scrolling list) or "karaoke" (word-by-word). */
  lyricsMode: string;
  /** Stage backdrop plays the official music video when the Bridge knows it. */
  videoBackdrop: boolean;
  /** Animated "liquid" gradient blobs behind player surfaces. */
  ambientBg: boolean;
  /** Stage draws no backdrop: the desktop wallpaper shows through. */
  transparentBg: boolean;
  /** Glass panel opacity 0-100: lower shows more of the desktop through. */
  glassOpacity: number;
  /** Audio output device name; null = OS default. */
  audioOutput: string | null;
  /** Active EQ preset name; "custom" after a slider moves. */
  eqPreset: string;
  /** Per-band gain in dB (5 bands: 60/250/1k/4k/12k Hz). Empty = flat. */
  eqBands: number[];
  /** Master sound effect: "off" | "reverb" | "8d" | "echo". */
  soundFx: string;
  /** UI language code: en, es, pt, fr, de, it, ja, zh, ko. */
  language: string;
  /** Karaoke lyric animation preset. */
  lyricAnim: string;
  /** Crossfade length in ms between tracks; 0 = hard cut. */
  crossfadeMs: number;
  /** Floating karaoke overlay window on the desktop. */
  deskLyricsEnabled: boolean;
  /** Restored overlay position, physical px. */
  deskLyricsPosition: [number, number] | null;
  /** Saved personalization profiles. */
  profiles: Profile[];
  /** Id of the last applied profile. */
  activeProfile: string | null;
  /** Epoch ms when the sleep timer fires; null = off. */
  sleepTimerEndsMs: number | null;
  /** Restore the last queue paused at its position on launch. */
  resumeOnLaunch: boolean;
  /** Desktop notification when the track changes. */
  notifyTrackChange: boolean;
  discordRpc: boolean;
}

/** EQ band center frequencies, Hz — mirrors noctbeat_core::eq::EQ_FREQS. */
export const EQ_FREQS = [60, 250, 1000, 4000, 12000];
/** Named EQ presets as dB arrays matching EQ_FREQS. */
export const EQ_PRESETS: Record<string, number[]> = {
  flat: [0, 0, 0, 0, 0],
  bass: [6, 4, 0, 0, 0],
  vocal: [-2, 0, 4, 3, 0],
  treble: [0, 0, 0, 3, 5],
};

export interface ThemeSettings {
  name: string;
  accent: string | null;
  accent2: string | null;
  /** Accents follow the playing track's artwork (manual picks win). */
  dynamic: boolean;
}
/** A saved personalization bundle (theme + EQ + lyrics prefs). */
export interface Profile {
  id: string;
  name: string;
  theme: ThemeSettings;
  eqPreset: string;
  eqBands: number[];
  lyricsMode: string;
  videoBackdrop: boolean;
}

/** Catalog search hit: metadata only, played via a provider. */
export interface CatalogSong {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  artworkUrl: string;
  /** 30s MP3 preview when the source provides one (iTunes does). */
  previewUrl?: string;
  /** Release ordering metadata when the catalog source provides it. */
  discNumber?: number;
  trackNumber?: number;
}
export interface QueueItem {
  track: Track;
  path: string;
}
export interface QueueState {
  items: QueueItem[];
  currentIndex: number | null;
}

export interface ImportResult {
  imported: number;
  remote: number;
  missing: number;
}
export interface ExportResult {
  path: string;
  exported: number;
  skippedRemote: number;
}
export interface PlaylistFile {
  name: string;
  path: string;
}
export interface PlaylistTrack {
  title: string;
  artist: string;
  durationMs: number;
  path: string;
  remote: boolean;
}
export interface PlayRecord {
  trackId: string;
  title: string;
  artist: string;
  /** "local", "mpris", "demo", ... — where playback came from. */
  source: string;
  durationMs: number;
  msListened: number;
  playedAtMs: number;
}
export interface TopEntry {
  name: string;
  /** Track artist; empty for artist entries. */
  sub: string;
  plays: number;
  ms: number;
}
export interface DayStat {
  /** "YYYY-MM-DD". */
  date: string;
  plays: number;
  ms: number;
}
export interface Stats {
  totalMs: number;
  plays: number;
  topTracks: TopEntry[];
  topArtists: TopEntry[];
  /** Daily activity, oldest first. */
  days: DayStat[];
}
export interface ArtistStats {
  artist: string;
  plays: number;
  totalMs: number;
  tracks: TopEntry[];
}

export interface Wrapped {
  /** Calendar month, "YYYY-MM". */
  month: string;
  totalMs: number;
  plays: number;
  uniqueTracks: number;
  uniqueArtists: number;
  streakDays: number;
  bestDay: DayStat | null;
  topTracks: TopEntry[];
  topArtists: TopEntry[];
}
export interface ListenStatus {
  hosting: boolean;
  hostAddr: string | null;
  hostName: string | null;
  peers: number;
  following: string | null;
  missingTrack: string | null;
  lastError: string | null;
}

export type LicenseState =
  | { state: "unlicensed" }
  | { state: "valid"; customer_email: string | null; last_validated_ms: number }
  | { state: "invalid"; reason: string }
  | { state: "offline"; grace_until_ms: number };

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  trayLiveIcon: true,
  licenseKey: null,
  hudEnabled: false,
  hudAlwaysOnTop: true,
  hudPosition: null,
  musicDir: null,
  theme: { name: "noct", accent: null, accent2: null, dynamic: true },
  lyricsMode: "lines",
  videoBackdrop: true,
  ambientBg: true,
  transparentBg: false,
  glassOpacity: 68,
  audioOutput: null,
  eqPreset: "flat",
  eqBands: [],
  soundFx: "off",
  language: "en",
  lyricAnim: "fade",
  crossfadeMs: 3000,
  deskLyricsEnabled: false,
  deskLyricsPosition: null,
  sleepTimerEndsMs: null,
  resumeOnLaunch: true,
  notifyTrackChange: true,
  discordRpc: true,
  profiles: [],
  activeProfile: null,
};

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Resolve an artwork reference (http(s), data:, file://, or a bare absolute
 * path from the local art cache) to a URL an <img> can load. */
export async function artSrc(url: string): Promise<string> {
  if (!url || !isTauri()) return url;
  if (/^(https?|data|blob):/.test(url)) return url;
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  const path = url.startsWith("file://") ? url.slice(7) : url;
  return convertFileSrc(path);
}

async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tauri = (window as any).__TAURI__?.core ?? (window as any).__TAURI_INTERNALS__;
  const { invoke } = await import("@tauri-apps/api/core");
  void tauri;
  return invoke<T>(cmd, args);
}

// ---- Browser mock (mirrors crates/noctbeat-core/src/media/demo.rs) ---------

/* Real tracks + their official YouTube videos: the browser preview has no
 * Bridge tab, so the videoclip backdrop plays the real embed (audio included)
 * instead of a stock sample. 6th field = YouTube video id. */
const DEMO_PLAYLIST: Array<[string, string, string, number, string, string]> = [
  ["Lucid Dreams", "Juice WRLD", "Goodbye & Good Riddance", 239_000, "https://i.ytimg.com/vi/mzB1VGEGcSU/mqdefault.jpg", "mzB1VGEGcSU"],
  ["Blinding Lights", "The Weeknd", "After Hours", 200_000, "https://i.ytimg.com/vi/4NRXx6U8ABQ/mqdefault.jpg", "4NRXx6U8ABQ"],
  ["Starboy", "The Weeknd, Daft Punk", "Starboy", 230_000, "https://i.ytimg.com/vi/34Na4j8AVgA/mqdefault.jpg", "34Na4j8AVgA"],
  ["Levitating", "Dua Lipa", "Future Nostalgia", 203_000, "https://i.ytimg.com/vi/TUVcZfQe-Kw/mqdefault.jpg", "TUVcZfQe-Kw"],
  ["bad guy", "Billie Eilish", "When We All Fall Asleep, Where Do We Go?", 194_000, "https://i.ytimg.com/vi/DyDfgMOUjCI/mqdefault.jpg", "DyDfgMOUjCI"],
  ["Sunflower", "Post Malone, Swae Lee", "Spider-Man: Into the Spider-Verse", 158_000, "https://i.ytimg.com/vi/ApXoWvfEYVU/mqdefault.jpg", "ApXoWvfEYVU"],
  ["Circles", "Post Malone", "Hollywood's Bleeding", 215_000, "https://i.ytimg.com/vi/wXhTHyIgQ_U/mqdefault.jpg", "wXhTHyIgQ_U"],
  ["As It Was", "Harry Styles", "Harry's House", 167_000, "https://i.ytimg.com/vi/H5v3kku4y6Q/mqdefault.jpg", "H5v3kku4y6Q"],
  ["Stay", "The Kid LAROI, Justin Bieber", "F*ck Love 3+", 141_000, "https://i.ytimg.com/vi/kTJczUoc26U/mqdefault.jpg", "kTJczUoc26U"],
];

const DEMO_LRC: LrcLine[] = [
  [0, "Lights out, the room goes quiet"],
  [4_000, "Synth lines running through the wires"],
  [8_000, "Every word begins to glow"],
  [12_000, "Colors only night can know"],
  [16_000, "Hold the beat, don't let it die"],
  [20_000, "We glow like embers in the sky"],
].map(([atMs, text]) => ({ atMs: atMs as number, text: text as string }));

class MockSource {
  index = 0;
  playlist: typeof DEMO_PLAYLIST = DEMO_PLAYLIST;
  status: PlaybackStatus = "playing";
  positionMs = 0;
  anchor = Date.now();

  private pos() {
    return this.status === "playing"
      ? this.positionMs + Date.now() - this.anchor
      : this.positionMs;
  }

  private track(): Track | null {
    const entry = this.playlist[this.index % this.playlist.length];
    if (!entry) return null;
    const [title, artist, album, durationMs, artworkUrl] = entry;
    return { id: `${artist} — ${title}`, title, artist, album, artworkUrl, durationMs };
  }

  poll(): NowPlaying {
    if (this.playlist.length === 0) {
      this.status = "stopped";
      return { track: null, status: "stopped", positionMs: 0, source: "demo", updatedAtMs: Date.now() };
    }
    let p = this.pos();
    const t = this.track();
    if (t && p >= t.durationMs) this.skip(1), (p = this.pos());
    return { track: this.track(), status: this.status, positionMs: p, source: "demo", updatedAtMs: Date.now() };
  }

  control(cmd: Control) {
    if (cmd === "play-pause") {
      this.positionMs = this.pos();
      this.anchor = Date.now();
      this.status = this.status === "playing" ? "paused" : "playing";
    } else this.skip(cmd === "next" ? 1 : -1);
  }

  private skip(dir: number) {
    if (this.playlist.length === 0) {
      this.index = 0;
      this.status = "stopped";
      this.positionMs = 0;
      return;
    }
    this.index = (this.index + dir + this.playlist.length) % this.playlist.length;
    this.positionMs = 0;
    this.anchor = Date.now();
  }

  seek(positionMs: number) {
    const dur = this.track()?.durationMs ?? Infinity;
    this.positionMs = Math.max(0, Math.min(positionMs, dur));
    this.anchor = Date.now();
  }
}

const mock = new MockSource();
const listeners = new Map<string, Set<(p: unknown) => void>>();

/* Browser preview playlist store: backs listPlaylists/playlistTracks/…
 * so imports (incl. simulated Spotify URLs) behave like the real app. */
interface MockPlaylistFile {
  file: PlaylistFile;
  tracks: PlaylistTrack[];
}
const demoTracks = (remote: boolean, base: string): PlaylistTrack[] =>
  DEMO_PLAYLIST.map(([title, artist, , durationMs], i) => ({
    title,
    artist,
    durationMs,
    path: `${base}/${i}.mp3`,
    remote,
  }));
const mockPlaylistStore: MockPlaylistFile[] = [
  { file: { name: "Favorites", path: "/demo/favorites.m3u8" }, tracks: demoTracks(false, "/demo") },
];
/* Session-scoped exact backups for Undo in the preview, mirroring
   the desktop command. */
const mockPlaylistBackups = new Map<string, { file: PlaylistFile; tracks: PlaylistTrack[] }>();
const findPl = (path: string) => mockPlaylistStore.find((m) => m.file.path === path);

/* Browser preview volume: the YouTube-embed backdrop listens here so the
 * stage slider actually reaches it (there is no native audio path). */
let previewVolume = 0.8;
const previewVolSubs = new Set<(v: number) => void>();
export function previewVolumeNow(): number {
  return previewVolume;
}
export function onPreviewVolume(cb: (v: number) => void): () => void {
  previewVolSubs.add(cb);
  return () => {
    previewVolSubs.delete(cb);
  };
}
let settingsStore: Settings = { ...DEFAULT_SETTINGS };

/** OS drag & drop of files/folders onto the window (Tauri webview
 * event). Paths are real filesystem paths. */
export function onFileDrop(cb: (paths: string[]) => void): () => void {
  if (isTauri()) {
    let off: (() => void) | undefined;
    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      getCurrentWebview()
        .onDragDropEvent((e) => {
          if (e.payload.type === "drop") cb(e.payload.paths);
        })
        .then((u) => (off = u));
    });
    return () => off?.();
  }
  return () => {};
}

export function subscribe<T>(event: "now-playing" | "energy" | "settings" | "queue" | "listen" | "fullscreen" | "license", cb: (p: T) => void): () => void {
  if (isTauri()) {
    let off: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<T>(event, (e) => cb(e.payload)).then((u) => (off = u));
    });
    return () => off?.();
  }
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  const fn = cb as (p: unknown) => void;
  set.add(fn);
  return () => set!.delete(fn);
}

function emitMock(event: string, payload: unknown) {
  listeners.get(event)?.forEach((cb) => cb(payload));
}

let mockListen: ListenStatus = {
  hosting: false,
  hostAddr: null,
  hostName: null,
  peers: 0,
  following: null,
  missingTrack: null,
  lastError: null,
};

let mockTimer: ReturnType<typeof setInterval> | null = null;
function ensureMockLoop() {
  if (isTauri() || mockTimer) return;
  mockTimer = setInterval(() => {
    const np = mock.poll();
    emitMock("now-playing", np);
    const playing = np.status === "playing";
    const beat = playing && np.positionMs % 500 < 200;
    const level = playing ? (beat ? 0.85 : 0.5) : 0;
    // Rotating hump mirroring the backend synthetic spectrum.
    const center = Math.floor(np.positionMs / 400) % 16;
    const bands = Array.from({ length: 16 }, (_, i) => {
      const d = Math.min(Math.abs(i - center), 16 - Math.abs(i - center));
      return Math.min(1, level * Math.max(0.08, 1 - d / 7));
    });
    emitMock("energy", {
      level,
      beat,
      bpm: playing ? 120 : undefined,
      bands,
    } satisfies EnergyUpdate);
  }, 200);
}
ensureMockLoop();

function mockQueueState(): QueueState {
  return {
    items: mock.playlist.map(([title, artist, album, durationMs, artworkUrl], i) => {
      /* Keep the demo path tied to the song, not its queue position —
         reordering the queue must not make drag-to-playlist save a
         different track under the same /demo/N path. */
      const demoIndex = DEMO_PLAYLIST.findIndex(([t, a]) => t === title && a === artist);
      return {
        track: {
          id: `${artist} — ${title}`,
          title,
          artist,
          album,
          artworkUrl,
          durationMs,
        },
        path: `/demo/${demoIndex >= 0 ? demoIndex : i}.mp3`,
      };
    }),
    currentIndex: mock.index,
  };
}

export const bridge = {
  artSrc,
  isTauri,
  productName: branding.productName,

  getNowPlaying: () => (isTauri() ? invokeCmd<NowPlaying>("get_now_playing") : Promise.resolve(mock.poll())),
  /** Browser-extension bridge: { tabs, provider host } — null without a bridge.
   * The web preview simulates a connected Spotify tab so the provider picker
   * and the live-dot state demo what the desktop app looks like bridged. */
  systemAccent: (): Promise<string | null> =>
    isTauri() ? invokeCmd<string | null>("system_accent") : Promise.resolve(null),
  getExtStatus: (): Promise<{
    tabs: number;
    provider: string | null;
    providers?: string[];
  } | null> =>
    isTauri()
      ? invokeCmd("get_ext_status")
      : Promise.resolve({
          tabs: 1,
          provider: "open.spotify.com",
          providers: ["open.spotify.com"],
        }),
  /** Search and play in the user's open provider tab via Noctbeat Bridge;
   * false when no tab of that provider is connected. */
  catalogSearch: (query: string): Promise<CatalogSong[]> =>
    isTauri()
      ? invokeCmd<CatalogSong[]>("catalog_search", { query })
      : fetch(
          `https://itunes.apple.com/search?media=music&entity=song&limit=30&term=${encodeURIComponent(query)}`,
        )
          .then((r) => r.json())
          .then((j: { results: Record<string, string & number>[] }) =>
            j.results.map((r) => ({
              title: r.trackName,
              artist: r.artistName,
              album: r.collectionName,
              durationMs: r.trackTimeMillis,
              artworkUrl: String(r.artworkUrl100).replace("100x100bb", "300x300bb"),
              previewUrl: r.previewUrl ? String(r.previewUrl) : undefined,
              discNumber: typeof r.discNumber === "number" ? r.discNumber : undefined,
              trackNumber: typeof r.trackNumber === "number" ? r.trackNumber : undefined,
            })),
          )
          .catch(() =>
            DEMO_PLAYLIST.map(([title, artist, album, durationMs, artworkUrl]) => ({
              title,
              artist,
              album,
              durationMs,
              artworkUrl,
            })),
          ),
  extPlay: (provider: string, query: string): Promise<boolean> =>
    isTauri()
      ? invokeCmd<boolean>("ext_play", { provider, query })
      : Promise.resolve(provider === "spotify"),
  mediaControl: (cmd: Control) => {
    if (isTauri()) return invokeCmd<null>("media_control", { cmd });
    mock.control(cmd);
    return Promise.resolve(null);
  },
  getPalette: (artworkUrl: string) =>
    isTauri()
      ? invokeCmd<{ dominant: string; accents: string[] }>("get_palette", { artworkUrl })
      : Promise.resolve({ dominant: "#8b5cf6", accents: ["#7dd3fc", "#fda4af", "#fcd34d"] }),
  getLyrics: () =>
    isTauri() ? invokeCmd<LrcLine[] | null>("get_lyrics") : Promise.resolve<LrcLine[] | null>(DEMO_LRC),
  getSettings: () =>
    isTauri() ? invokeCmd<Settings>("get_settings") : Promise.resolve({ ...settingsStore }),
  updateSettings: (settings: Settings) => {
    if (isTauri()) return invokeCmd<null>("update_settings", { settings });
    settingsStore = { ...settings };
    emitMock("settings", settingsStore);
    return Promise.resolve(null);
  },
  setHudPinned: (pinned: boolean) => {
    if (isTauri()) return invokeCmd<null>("set_hud_pinned", { pinned });
    settingsStore = { ...settingsStore, hudAlwaysOnTop: pinned };
    emitMock("settings", settingsStore);
    return Promise.resolve(null);
  },
  hudStartDrag: () =>
    isTauri() ? invokeCmd<null>("hud_start_drag") : Promise.resolve(null),
  deskLyricsStartDrag: () =>
    isTauri() ? invokeCmd<null>("desk_lyrics_start_drag") : Promise.resolve(null),
  playerStartDrag: () =>
    isTauri() ? invokeCmd<null>("player_start_drag") : Promise.resolve(null),
  showPlayer: () => {
    if (isTauri()) return invokeCmd<null>("show_player");
    window.location.hash = "#/";
    return Promise.resolve(null);
  },
  /** Fullscreen the player window (karaoke / visualizer wallpaper mode). */
  toggleFullscreen: (): Promise<boolean> => {
    if (isTauri()) return invokeCmd<boolean>("toggle_fullscreen");
    return Promise.resolve(false);
  },
  isFullscreen: (): Promise<boolean> => {
    if (isTauri()) return invokeCmd<boolean>("window_is_fullscreen");
    return Promise.resolve(false);
  },
  getLicenseState: (): Promise<LicenseState> =>
    isTauri()
      ? invokeCmd<LicenseState>("get_license_state")
      : Promise.resolve({ state: "unlicensed" }),
  activateLicense: (key: string): Promise<LicenseState> =>
    isTauri()
      ? invokeCmd<LicenseState>("activate_license", { key })
      : Promise.resolve({ state: "invalid", reason: "license validation requires the desktop app" }),
  deactivateLicense: (): Promise<LicenseState> =>
    isTauri()
      ? invokeCmd<LicenseState>("deactivate_license")
      : Promise.resolve({ state: "unlicensed" }),
  /** Open an external https:// URL in the system browser. */
  openUrl: (url: string): Promise<null> =>
    isTauri() ? invokeCmd<null>("open_url", { url }) : (window.open(url, "_blank"), Promise.resolve(null)),
  /** Open the bundled bridge extension folder (dev: extension/, packaged: _up_/extension). */
  openExtensionFolder: (): Promise<void> => invokeCmd<void>("open_extension_folder"),
  seek: (positionMs: number) => {
    window.dispatchEvent(new Event("noctbeat-manual-seek"));
    if (isTauri()) return invokeCmd<null>("seek", { positionMs });
    mock.seek(positionMs);
    return Promise.resolve(null);
  },
  setVolume: (volume: number) => {
    if (isTauri()) return invokeCmd<null>("set_volume", { volume });
    previewVolume = Math.max(0, Math.min(1, volume));
    previewVolSubs.forEach((cb) => cb(previewVolume));
    return Promise.resolve(null);
  },
  setSpeed: (speed: number) =>
    isTauri() ? invokeCmd<null>("set_speed", { speed }) : Promise.resolve(null),
  getQueue: (): Promise<QueueState> =>
    isTauri()
      ? invokeCmd<QueueState>("get_queue")
      : Promise.resolve(mockQueueState()),
  playQueueIndex: (index: number) => {
    if (isTauri()) return invokeCmd<null>("play_queue_index", { index });
    mock.index = index;
    mock.positionMs = 0;
    mock.anchor = Date.now();
    mock.status = "playing";
    emitMock("queue", mockQueueState());
    return Promise.resolve(null);
  },
  setShuffle: (on: boolean): Promise<boolean> =>
    isTauri() ? invokeCmd<boolean>("set_shuffle", { on }) : Promise.resolve(on),
  getShuffle: (): Promise<boolean> =>
    isTauri() ? invokeCmd<boolean>("get_shuffle") : Promise.resolve(false),
  setRepeat: (mode: "off" | "all" | "one"): Promise<string> =>
    isTauri() ? invokeCmd<string>("set_repeat", { mode }) : Promise.resolve(mode),
  getRepeat: (): Promise<"off" | "all" | "one"> =>
    isTauri() ? invokeCmd<"off" | "all" | "one">("get_repeat") : Promise.resolve("off"),
  getVolume: (): Promise<number> =>
    isTauri() ? invokeCmd<number>("get_volume") : Promise.resolve(previewVolume),
  clearQueue: () => {
    if (isTauri()) return invokeCmd<null>("clear_queue");
    mock.playlist = [];
    emitMock("queue", mockQueueState());
    return Promise.resolve(null);
  },
  queueRemove: (index: number): Promise<null> => {
    if (isTauri()) return invokeCmd<null>("queue_remove", { index });
    if (index !== mock.index) {
      mock.playlist.splice(index, 1);
      if (index < mock.index) mock.index -= 1;
      emitMock("queue", mockQueueState());
    }
    return Promise.resolve(null);
  },
  queueMove: (from: number, to: number): Promise<null> => {
    if (isTauri()) return invokeCmd<null>("queue_move", { from, to });
    const [item] = mock.playlist.splice(from, 1);
    if (item) {
      mock.playlist.splice(to, 0, item);
      if (mock.index === from) mock.index = to;
      else if (from < to && mock.index > from && mock.index <= to) mock.index -= 1;
      else if (to < from && mock.index >= to && mock.index < from) mock.index += 1;
      emitMock("queue", mockQueueState());
    }
    return Promise.resolve(null);
  },
  enqueueFiles: (paths: string[]): Promise<number> => {
    if (isTauri()) return invokeCmd<number>("enqueue_files", { paths });
    return Promise.resolve(paths.length);
  },
  scanLibrary: (dir?: string) =>
    isTauri()
      ? invokeCmd<QueueItem[]>("scan_library", { dir: dir ?? null })
      : bridge.getQueue().then((q) => q.items),
  /** Read-only library scan — does not replace the playing queue. */
  libraryTracks: (dir?: string): Promise<QueueItem[]> =>
    isTauri()
      ? invokeCmd<QueueItem[]>("library_tracks", { dir: dir ?? null })
      : bridge.getQueue().then((q) => q.items),
  /** Replace the queue with `items` and play `index` (context play). */
  playItems: (items: QueueItem[], index: number): Promise<null> => {
    if (isTauri()) return invokeCmd<null>("play_items", { items, index });
    mock.playlist = items.map(
      (i) =>
        [
          i.track.title,
          i.track.artist,
          i.track.album,
          i.track.durationMs,
          i.track.artworkUrl,
          DEMO_PLAYLIST.find(([t, a]) => t === i.track.title && a === i.track.artist)?.[5] ?? "",
        ] as [string, string, string, number, string, string],
    );
    mock.index = index;
    mock.positionMs = 0;
    mock.anchor = Date.now();
    mock.status = "playing";
    emitMock("queue", mockQueueState());
    return Promise.resolve(null);
  },
  resolveVideo: (artist: string, title: string): Promise<string | null> =>
    isTauri()
      ? invokeCmd<string | null>("ext_video", { artist, title }).catch(() => null)
      : /* demo preview only: the real official video as a YouTube embed so
         * the videoclip backdrop plays audio + video outside Tauri; the app
         * embeds the video playing in the user's YouTube tab, muted. */
        Promise.resolve(
          (() => {
            const hit = DEMO_PLAYLIST.find(([t, a]) => t === title && a === artist);
            return hit
              ? `https://www.youtube.com/embed/${hit[5]}?enablejsapi=1&rel=0&modestbranding=1&playsinline=1&controls=0&iv_load_policy=3`
              : null;
          })(),
        ),
  listOutputs: (): Promise<string[]> =>
    isTauri() ? invokeCmd<string[]>("list_outputs") : Promise.resolve([]),
  setOutputDevice: (name: string | null) => {
    if (isTauri()) return invokeCmd<null>("set_output_device", { name });
    settingsStore = { ...settingsStore, audioOutput: name };
    emitMock("settings", settingsStore);
    return Promise.resolve(null);
  },
  setEq: (preset: string, bands: number[]) => {
    if (isTauri()) return invokeCmd<null>("set_eq", { preset, bands });
    settingsStore = { ...settingsStore, eqPreset: preset, eqBands: bands };
    emitMock("settings", settingsStore);
    return Promise.resolve(null);
  },
  setFx: (mode: string) => {
    if (isTauri()) return invokeCmd<null>("set_fx", { mode });
    settingsStore = { ...settingsStore, soundFx: mode };
    emitMock("settings", settingsStore);
    return Promise.resolve(null);
  },
  saveProfile: (name: string): Promise<Profile> => {
    if (isTauri()) return invokeCmd<Profile>("save_profile", { name });
    const s = settingsStore;
    const existing = s.profiles.find(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );
    const p: Profile = {
      id: existing?.id ?? `p${Date.now()}`,
      name,
      theme: s.theme,
      eqPreset: s.eqPreset,
      eqBands: s.eqBands,
      lyricsMode: s.lyricsMode,
      videoBackdrop: s.videoBackdrop,
    };
    settingsStore = {
      ...s,
      profiles: existing
        ? s.profiles.map((q) => (q.id === p.id ? p : q))
        : [...s.profiles, p],
      activeProfile: p.id,
    };
    emitMock("settings", settingsStore);
    return Promise.resolve(p);
  },
  /** Arm (minutes) or clear (null) the sleep timer. */
  setSleepTimer: (minutes: number | null): Promise<null> => {
    if (isTauri()) return invokeCmd<null>("set_sleep_timer", { minutes });
    settingsStore = {
      ...settingsStore,
      sleepTimerEndsMs: minutes === null ? null : Date.now() + minutes * 60_000,
    };
    listeners.get("settings")?.forEach((l) => l(settingsStore));
    return Promise.resolve(null);
  },
  applyProfile: (id: string): Promise<null> => {
    if (isTauri()) return invokeCmd<null>("apply_profile", { id });
    const p = settingsStore.profiles.find((q) => q.id === id);
    if (p) {
      settingsStore = {
        ...settingsStore,
        theme: p.theme,
        eqPreset: p.eqPreset,
        eqBands: p.eqBands,
        lyricsMode: p.lyricsMode,
        videoBackdrop: p.videoBackdrop,
        activeProfile: id,
      };
      emitMock("settings", settingsStore);
    }
    return Promise.resolve(null);
  },
  deleteProfile: (id: string): Promise<null> => {
    if (isTauri()) return invokeCmd<null>("delete_profile", { id });
    settingsStore = {
      ...settingsStore,
      profiles: settingsStore.profiles.filter((q) => q.id !== id),
      activeProfile:
        settingsStore.activeProfile === id ? null : settingsStore.activeProfile,
    };
    emitMock("settings", settingsStore);
    return Promise.resolve(null);
  },
  /** Save the current theme as a shareable .nbtheme JSON. */
  exportTheme: (path: string): Promise<null> =>
    isTauri() ? invokeCmd<null>("export_theme", { path }) : Promise.resolve(null),
  /** Load + validate a theme file; mock returns a Rose demo theme. */
  importTheme: (path: string): Promise<ThemeSettings> =>
    isTauri()
      ? invokeCmd<ThemeSettings>("import_theme", { path })
      : Promise.resolve({ name: "rose", accent: null, accent2: null, dynamic: false }),
  pickThemeImport: async (): Promise<string | null> => {
    if (!isTauri()) return null;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({
      filters: [{ name: "Noctbeat theme", extensions: ["nbtheme", "json"] }],
    });
    return typeof sel === "string" ? sel : null;
  },
  pickThemeExport: async (name: string): Promise<string | null> => {
    if (!isTauri()) return null;
    const { save } = await import("@tauri-apps/plugin-dialog");
    return save({
      defaultPath: `${name}.nbtheme`,
      filters: [{ name: "Noctbeat theme", extensions: ["nbtheme", "json"] }],
    });
  },
  /** Native file picker for a playlist file; null when cancelled or mocked. */
  pickPlaylist: async (): Promise<string | null> => {
    if (!isTauri()) return null;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({
      filters: [
        { name: "Playlist", extensions: ["m3u", "m3u8", "pls", "xspf"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return typeof sel === "string" ? sel : null;
  },
  importPlaylist: (path: string): Promise<ImportResult> => {
    if (isTauri()) return invokeCmd<ImportResult>("import_playlist", { path });
    /* Mirror the real importer: remote rows are skipped, files append
       to the queue in order. */
    const pl = findPl(path);
    if (!pl) return Promise.resolve({ imported: 0, remote: 0, missing: 0 });
    let imported = 0;
    let remote = 0;
    for (const pt of pl.tracks) {
      if (pt.remote) {
        remote++;
        continue;
      }
      const hit = DEMO_PLAYLIST.find(([t, a]) => t === pt.title && a === pt.artist);
      mock.playlist.push(
        hit ?? [pt.title, pt.artist, "", pt.durationMs ?? 0, "", ""],
      );
      imported++;
    }
    emitMock("queue", mockQueueState());
    return Promise.resolve({ imported, remote, missing: 0 });
  },
  /** Write the queue as an .m3u8 in the music folder; returns the path. */
  exportPlaylist: (name: string): Promise<ExportResult> =>
    isTauri()
      ? invokeCmd<ExportResult>("export_playlist", { name })
      : Promise.resolve({ path: "/demo/playlist.m3u8", exported: 9, skippedRemote: 0 }),
  /** Playlist files at the top level of the music folder. */
  listPlaylists: (): Promise<PlaylistFile[]> =>
    isTauri()
      ? invokeCmd<PlaylistFile[]>("list_playlists")
      : Promise.resolve(mockPlaylistStore.map((m) => m.file)),
  /** Create an empty playlist file; returns its name + path. */
  createPlaylist: (name: string): Promise<PlaylistFile> => {
    if (isTauri()) return invokeCmd<PlaylistFile>("create_playlist", { name });
    const stem = name.trim() || "playlist";
    let path = `/demo/${stem}.m3u8`;
    let n = 2;
    while (findPl(path)) path = `/demo/${stem}-${n++}.m3u8`;
    const file = { name: path.split("/").pop()!.replace(/\.m3u8$/, ""), path };
    mockPlaylistStore.push({ file, tracks: [] });
    return Promise.resolve(file);
  },
  /** Rename a playlist file in place, keeping its extension. */
  renamePlaylist: (path: string, name: string): Promise<PlaylistFile> => {
    if (isTauri()) return invokeCmd<PlaylistFile>("rename_playlist", { path, name });
    const pl = findPl(path);
    if (pl) pl.file = { ...pl.file, name };
    return Promise.resolve({ name, path });
  },
  deletePlaylist: (path: string): Promise<void> => {
    if (isTauri()) return invokeCmd("delete_playlist", { path });
    const i = mockPlaylistStore.findIndex((m) => m.file.path === path);
    if (i >= 0) mockPlaylistStore.splice(i, 1);
    return Promise.resolve();
  },
  /** Every entry of a playlist file, in order — files and remote rows. */
  playlistTracks: (path: string): Promise<PlaylistTrack[]> =>
    isTauri()
      ? invokeCmd<PlaylistTrack[]>("playlist_tracks", { path })
      /* Copy: the view derives state by filtering/splicing the result —
         handing it the store's array would mutate both at once. */
      : Promise.resolve([...(findPl(path)?.tracks ?? [])]),
  /** Snapshot a playlist before a destructive edit so Undo can restore
      the exact original contents. */
  playlistBackup: (path: string): Promise<void> => {
    if (isTauri()) return invokeCmd("playlist_backup", { path });
    const pl = findPl(path);
    if (pl) {
      mockPlaylistBackups.set(path, {
        file: { ...pl.file },
        tracks: pl.tracks.map((tr) => ({ ...tr })),
      });
    }
    return Promise.resolve();
  },
  /** Restore the latest exact playlist backup. */
  playlistRestoreBackup: (path: string): Promise<void> => {
    if (isTauri()) return invokeCmd("playlist_restore_backup", { path });
    const backup = mockPlaylistBackups.get(path);
    if (!backup) return Promise.reject(new Error("nothing to undo"));
    mockPlaylistBackups.delete(path);
    const existing = findPl(path);
    if (existing) {
      existing.tracks = backup.tracks.map((tr) => ({ ...tr }));
    } else {
      mockPlaylistStore.push({
        file: { ...backup.file },
        tracks: backup.tracks.map((tr) => ({ ...tr })),
      });
    }
    return Promise.resolve();
  },
  /** Drop the entry at `index` from an .m3u/.m3u8 playlist. */
  playlistRemoveTrack: (path: string, index: number): Promise<void> => {
    if (isTauri()) return invokeCmd("playlist_remove_track", { path, index });
    findPl(path)?.tracks.splice(index, 1);
    return Promise.resolve();
  },
  /** Move the entry at `from` to position `to` and rewrite the file. */
  playlistMoveTrack: (path: string, from: number, to: number): Promise<void> => {
    if (isTauri()) return invokeCmd("playlist_move_track", { path, from, to });
    const pl = findPl(path);
    if (pl && from !== to && pl.tracks[from]) {
      const [m] = pl.tracks.splice(from, 1);
      pl.tracks.splice(to, 0, m);
    }
    return Promise.resolve();
  },
  /** Append local files to an .m3u/.m3u8 playlist; returns added count. */
  playlistAddTracks: (path: string, paths: string[]): Promise<number> => {
    if (isTauri()) return invokeCmd<number>("playlist_add_tracks", { path, paths });
    const pl = findPl(path);
    const local = paths.filter((p) => !/^(remote:|https?:)/i.test(p));
    if (pl)
      local.forEach((p) => {
        /* Re-resolve demo metadata by path — undo restores must come
           back with their title/artist, not the bare filename. The
           real backend reads tags off the file; the mock has no
           files, so it matches the demo playlist instead. */
        const m = p.match(/^\/demo\/(\d+)\.mp3$/);
        const demo = m ? DEMO_PLAYLIST[Number(m[1])] : undefined;
        pl.tracks.push(
          demo
            ? {
                title: demo[0],
                artist: demo[1],
                durationMs: demo[3],
                path: p,
                remote: false,
              }
            : {
                title: p.split("/").pop()?.replace(/\.[^.]+$/, "") ?? p,
                artist: "",
                durationMs: 0,
                path: p,
                remote: false,
              },
        );
      });
    return Promise.resolve(local.length);
  },
  getArtistStats: (artist: string): Promise<ArtistStats> =>
    isTauri()
      ? invokeCmd<ArtistStats>("get_artist_stats", { artist })
      : Promise.resolve({
          artist,
          plays: 3,
          totalMs: 700_000,
          tracks: mock.playlist
            .filter(([, a]) => a.toLowerCase() === artist.toLowerCase())
            .map(([title, a]) => ({ name: title, sub: a, plays: 3, ms: 700_000 })),
        }),
  getStats: (): Promise<Stats> => {
    if (isTauri()) return invokeCmd<Stats>("get_stats");
    // Deterministic sample so the page renders in browser dev.
    const day = 86_400_000;
    const today = Math.floor(Date.now() / day) * day;
    const mk = (i: number, ms: number): DayStat => ({
      date: new Date(today - i * day).toISOString().slice(0, 10),
      plays: i === 0 ? 5 : 0,
      ms,
    });
    return Promise.resolve({
      totalMs: 1_830_000,
      plays: 9,
      topTracks: DEMO_PLAYLIST.map(([title, artist], i) => ({
        name: title,
        sub: artist,
        plays: Math.max(0, 3 - i),
        ms: Math.max(30_000, 500_000 - i * 120_000),
      })),
      topArtists: [
        { name: "Violet Sector", sub: "", plays: 6, ms: 1_300_000 },
        { name: "Ultramar", sub: "", plays: 3, ms: 530_000 },
      ],
      days: Array.from({ length: 14 }, (_, i) => mk(13 - i, i === 13 ? 1_830_000 : 0)),
    });
  },
  clearHistory: () =>
    isTauri() ? invokeCmd<null>("clear_history") : Promise.resolve(null),
  /** Newest-first unique plays (trackId is the file path for locals). */
  recentPlays: (limit = 12): Promise<PlayRecord[]> =>
    isTauri()
      ? invokeCmd<PlayRecord[]>("recent_plays", { limit })
      : Promise.resolve(
          mock.playlist.slice(0, limit).map(([title, artist], i) => ({
            trackId: `demo-${i}`,
            title,
            artist,
            source: "demo",
            durationMs: 200_000,
            msListened: 60_000,
            playedAtMs: Date.now() - (i + 1) * 3_600_000,
          })),
        ),
  listenStatus: (): Promise<ListenStatus> =>
    isTauri()
      ? invokeCmd<ListenStatus>("listen_status")
      : Promise.resolve(mockListen),
  /** Host a session; `web` routes through the public relay so friends on
      other networks can join. `name` defaults to the OS user. */
  listenHostStart: (name?: string, web?: boolean): Promise<ListenStatus> => {
    if (isTauri())
      return invokeCmd<ListenStatus>("listen_host_start", {
        name: name ?? null,
        web: web ?? null,
      });
    mockListen = {
      ...mockListen,
      hosting: true,
      hostAddr: web
        ? "https://noctbeat-relay.onrender.com/a1b2c3d4e5f67890"
        : "http://192.168.1.42:17894",
      hostName: name || "Fausto",
      following: null,
    };
    emitMock("listen", mockListen);
    return Promise.resolve(mockListen);
  },
  listenHostStop: (): Promise<ListenStatus> => {
    if (isTauri()) return invokeCmd<ListenStatus>("listen_host_stop");
    mockListen = { ...mockListen, hosting: false, hostAddr: null, peers: 0 };
    emitMock("listen", mockListen);
    return Promise.resolve(mockListen);
  },
  /** Join a friend's session by address (`ip`, `ip:port` or `http://…`). */
  listenJoin: (addr: string): Promise<ListenStatus> => {
    if (isTauri()) return invokeCmd<ListenStatus>("listen_join", { addr });
    if (!addr.trim()) return Promise.reject(new Error("empty address"));
    mockListen = {
      ...mockListen,
      following: addr.startsWith("http") ? addr : `http://${addr}`,
      hosting: false,
      hostAddr: null,
      hostName: "Friend's session",
      lastError: null,
    };
    emitMock("listen", mockListen);
    return Promise.resolve(mockListen);
  },
  listenLeave: (): Promise<ListenStatus> => {
    if (isTauri()) return invokeCmd<ListenStatus>("listen_leave");
    mockListen = { ...mockListen, following: null, hostName: null, missingTrack: null };
    emitMock("listen", mockListen);
    return Promise.resolve(mockListen);
  },
  getWrapped: (): Promise<Wrapped> => {
    if (isTauri()) return invokeCmd<Wrapped>("get_wrapped");
    const month = new Date().toISOString().slice(0, 7);
    return Promise.resolve({
      month,
      totalMs: 4_980_000,
      plays: 23,
      uniqueTracks: 9,
      uniqueArtists: 4,
      streakDays: 4,
      bestDay: { date: `${month}-12`, plays: 8, ms: 1_700_000 },
      topTracks: DEMO_PLAYLIST.slice(0, 5).map(([title, artist], i) => ({
        name: title,
        sub: artist,
        plays: 7 - i,
        ms: 1_100_000 - i * 160_000,
      })),
      topArtists: [
        { name: "Violet Sector", sub: "", plays: 9, ms: 2_100_000 },
        { name: "Ultramar", sub: "", plays: 6, ms: 1_400_000 },
        { name: "Velvet Fields", sub: "", plays: 5, ms: 900_000 },
      ],
    });
  },
};
