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
  ytdlpPath: string | null;
  theme: ThemeSettings;
  /** "lines" (scrolling list) or "karaoke" (word-by-word). */
  lyricsMode: string;
  /** Karaoke backdrop plays the music video (yt-dlp) instead of blurred art. */
  videoBackdrop: boolean;
  /** Animated "liquid" gradient blobs behind player surfaces. */
  ambientBg: boolean;
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
export interface RemoteTrack {
  id: string;
  /** Provider key: "youtube" | "soundcloud". */
  source: string;
  title: string;
  artist: string;
  durationMs: number;
  url: string;
  artworkUrl: string;
}

export interface QueueItem {
  track: Track;
  path: string;
}
export interface QueueState {
  items: QueueItem[];
  currentIndex: number | null;
}
export interface PlaylistUrlResult {
  title: string;
  imported: number;
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
  hudEnabled: true,
  hudAlwaysOnTop: true,
  hudPosition: null,
  musicDir: null,
  ytdlpPath: null,
  theme: { name: "noct", accent: null, accent2: null, dynamic: true },
  lyricsMode: "lines",
  videoBackdrop: true,
  ambientBg: true,
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

const DEMO_PLAYLIST: Array<[string, string, string, number, string]> = [
  ["Aurora Reversal", "Violet Sector", "Parallax Bloom", 214_000, "/art/aurora.jpg"],
  ["Slow Meridian", "Violet Sector", "Parallax Bloom", 187_000, "/art/aurora.jpg"],
  ["Glass Tide", "Ultramar", "Field Lines", 243_000, "/art/glasstide.jpg"],
  ["Lucid Dreams", "Juice WRLD", "Goodbye & Good Riddance", 239_000, "/art/lucid.jpg"],
  ["Midnight Relay", "Chromewave", "Night Grid", 201_000, "/art/nightgrid.jpg"],
  ["Velvet Static", "Ultramar", "Field Lines", 176_000, "/art/glasstide.jpg"],
  ["Afterglow Avenue", "Velvet Fields", "Daybreak", 224_000, "/art/moon.jpg"],
  ["Low Orbit", "Lunar Plain", "Earthrise", 198_000, "/art/orbit.jpg"],
  ["Paper Satellites", "Violet Sector", "Parallax Bloom", 232_000, "/art/aurora.jpg"],
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

export function subscribe<T>(event: "now-playing" | "energy" | "settings" | "queue" | "listen" | "fullscreen", cb: (p: T) => void): () => void {
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
    items: mock.playlist.map(([title, artist, album, durationMs, artworkUrl], i) => ({
      track: {
        id: `${artist} — ${title}`,
        title,
        artist,
        album,
        artworkUrl,
        durationMs,
      },
      path: `/demo/${i}.mp3`,
    })),
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
  getExtStatus: (): Promise<{ tabs: number; provider: string | null } | null> =>
    isTauri()
      ? invokeCmd("get_ext_status")
      : Promise.resolve({ tabs: 1, provider: "open.spotify.com" }),
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
  seek: (positionMs: number) => {
    if (isTauri()) return invokeCmd<null>("seek", { positionMs });
    mock.seek(positionMs);
    return Promise.resolve(null);
  },
  setVolume: (volume: number) =>
    isTauri() ? invokeCmd<null>("set_volume", { volume }) : Promise.resolve(null),
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
    isTauri() ? invokeCmd<number>("get_volume") : Promise.resolve(1),
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
      (i) => [i.track.title, i.track.artist, i.track.album, i.track.durationMs, i.track.artworkUrl] as [string, string, string, number, string],
    );
    mock.index = index;
    mock.positionMs = 0;
    mock.anchor = Date.now();
    mock.status = "playing";
    emitMock("queue", mockQueueState());
    return Promise.resolve(null);
  },
  providerStatus: () =>
    isTauri() ? invokeCmd<boolean>("provider_status") : Promise.resolve(false),
  providerSearch: (source: string, query: string): Promise<RemoteTrack[]> =>
    isTauri()
      ? invokeCmd<RemoteTrack[]>("provider_search", { source, query })
      : Promise.resolve(
          DEMO_PLAYLIST.slice(0, 3).map(([title, artist, , durationMs, artworkUrl], i) => ({
            id: `demo-${i}`,
            source,
            title,
            artist,
            durationMs,
            url: "",
            artworkUrl,
          })),
        ),
  providerPlay: (track: RemoteTrack) =>
    isTauri()
      ? invokeCmd<QueueItem>("provider_play", { track })
      : Promise.resolve({
          track: {
            id: track.id,
            title: track.title,
            artist: track.artist,
            album: "",
            artworkUrl: track.artworkUrl,
            durationMs: track.durationMs,
          },
          path: `/demo/${track.id}.mp3`,
        }),
  providerEnqueue: (track: RemoteTrack) =>
    isTauri()
      ? invokeCmd<QueueItem>("provider_enqueue", { track })
      : Promise.resolve({
          track: {
            id: track.id,
            title: track.title,
            artist: track.artist,
            album: "",
            artworkUrl: track.artworkUrl,
            durationMs: track.durationMs,
          },
          path: `/demo/${track.id}.mp3`,
        }),
  resolveVideo: (artist: string, title: string): Promise<string | null> =>
    isTauri()
      ? invokeCmd<string | null>("resolve_video", { artist, title }).catch(() => null)
      : /* demo preview only: public CC0 sample so the videoclip backdrop is
         * testable outside Tauri; the real app resolves via yt-dlp. */
        Promise.resolve(
          "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
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
  importPlaylist: (path: string): Promise<ImportResult> =>
    isTauri()
      ? invokeCmd<ImportResult>("import_playlist", { path })
      : Promise.resolve({ imported: 0, remote: 0, missing: 0 }),
  importPlaylistUrl: (url: string): Promise<PlaylistUrlResult> =>
    isTauri()
      ? invokeCmd<PlaylistUrlResult>("import_playlist_url", { url })
      : Promise.resolve({ title: "Demo mix", imported: 0 }),
  /** Write the queue as an .m3u8 in the music folder; returns the path. */
  exportPlaylist: (name: string): Promise<ExportResult> =>
    isTauri()
      ? invokeCmd<ExportResult>("export_playlist", { name })
      : Promise.resolve({ path: "/demo/playlist.m3u8", exported: 9, skippedRemote: 0 }),
  /** Playlist files at the top level of the music folder. */
  listPlaylists: (): Promise<PlaylistFile[]> =>
    isTauri()
      ? invokeCmd<PlaylistFile[]>("list_playlists")
      : Promise.resolve([{ name: "Favorites", path: "/demo/favorites.m3u8" }]),
  /** Rename a playlist file in place, keeping its extension. */
  renamePlaylist: (path: string, name: string): Promise<PlaylistFile> =>
    isTauri()
      ? invokeCmd<PlaylistFile>("rename_playlist", { path, name })
      : Promise.resolve({ name, path }),
  deletePlaylist: (path: string): Promise<void> =>
    isTauri() ? invokeCmd("delete_playlist", { path }) : Promise.resolve(),
  /** Every entry of a playlist file, in order — files and remote rows. */
  playlistTracks: (path: string): Promise<PlaylistTrack[]> =>
    isTauri()
      ? invokeCmd<PlaylistTrack[]>("playlist_tracks", { path })
      : Promise.resolve(
          mock.playlist.map(([title, artist, , durationMs], i) => ({
            title,
            artist,
            durationMs,
            path: `/demo/${i}.mp3`,
            remote: false,
          })),
        ),
  /** Drop the entry at `index` from an .m3u/.m3u8 playlist. */
  playlistRemoveTrack: (path: string, index: number): Promise<void> =>
    isTauri()
      ? invokeCmd("playlist_remove_track", { path, index })
      : Promise.resolve(),
  /** Append local files to an .m3u/.m3u8 playlist; returns added count. */
  playlistAddTracks: (path: string, paths: string[]): Promise<number> =>
    isTauri()
      ? invokeCmd<number>("playlist_add_tracks", { path, paths })
      : Promise.resolve(paths.length),
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
        ? "https://noctbeat-relay--pzxd7n62.preview.devinapps.com/a1b2c3d4e5f67890"
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
