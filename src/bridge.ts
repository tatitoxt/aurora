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
}
export interface DisplayInfo {
  id: string;
  name: string;
  primary: boolean;
}
export type ColorMode = { mode: "artwork" } | { mode: "custom" };
export interface DisplayRule {
  displayId: string;
  enabled: boolean;
}
export interface Settings {
  version: number;
  edgeThicknessPx: number;
  glowStrength: number;
  brightness: number;
  colorMode: ColorMode;
  customColor: string;
  batterySaver: boolean;
  hideInFullscreen: boolean;
  displays: DisplayRule[];
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
  /** Audio output device name; null = OS default. */
  audioOutput: string | null;
  /** Active EQ preset name; "custom" after a slider moves. */
  eqPreset: string;
  /** Per-band gain in dB (5 bands: 60/250/1k/4k/12k Hz). Empty = flat. */
  eqBands: number[];
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
export type LicenseState =
  | { state: "unlicensed" }
  | { state: "valid"; customer_email: string | null; last_validated_ms: number }
  | { state: "invalid"; reason: string }
  | { state: "offline"; grace_until_ms: number };

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  edgeThicknessPx: 24,
  glowStrength: 0.7,
  brightness: 0.8,
  colorMode: { mode: "artwork" },
  customColor: "#8b5cf6",
  batterySaver: false,
  hideInFullscreen: true,
  displays: [],
  licenseKey: null,
  hudEnabled: true,
  hudAlwaysOnTop: true,
  hudPosition: null,
  musicDir: null,
  ytdlpPath: null,
  theme: { name: "noct", accent: null, accent2: null },
  lyricsMode: "lines",
  videoBackdrop: true,
  audioOutput: null,
  eqPreset: "flat",
  eqBands: [],
  deskLyricsEnabled: false,
  deskLyricsPosition: null,
  sleepTimerEndsMs: null,
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

const DEMO_PLAYLIST: Array<[string, string, string, number]> = [
  ["Neon Reversal", "Violet Sector", "Parallax Bloom", 214_000],
  ["Slow Meridian", "Violet Sector", "Parallax Bloom", 187_000],
  ["Glass Tide", "Ultramar", "Field Lines", 243_000],
];

const DEMO_LRC: LrcLine[] = [
  [0, "Lights out, the room goes quiet"],
  [4_000, "Synth lines running through the wires"],
  [8_000, "Every edge begins to glow"],
  [12_000, "Colors only night can know"],
  [16_000, "Hold the beat, don't let it die"],
  [20_000, "We glow like neon in the sky"],
].map(([atMs, text]) => ({ atMs: atMs as number, text: text as string }));

class MockSource {
  index = 0;
  status: PlaybackStatus = "playing";
  positionMs = 0;
  anchor = Date.now();

  private pos() {
    return this.status === "playing"
      ? this.positionMs + Date.now() - this.anchor
      : this.positionMs;
  }

  private track(): Track {
    const [title, artist, album, durationMs] = DEMO_PLAYLIST[this.index];
    return { id: `${artist} — ${title}`, title, artist, album, artworkUrl: "", durationMs };
  }

  poll(): NowPlaying {
    let p = this.pos();
    const t = this.track();
    if (p >= t.durationMs) this.skip(1), (p = this.pos());
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
    this.index = (this.index + dir + DEMO_PLAYLIST.length) % DEMO_PLAYLIST.length;
    this.positionMs = 0;
    this.anchor = Date.now();
  }
}

const mock = new MockSource();
const listeners = new Map<string, Set<(p: unknown) => void>>();
let settingsStore: Settings = { ...DEFAULT_SETTINGS };

export function subscribe<T>(event: "now-playing" | "energy" | "settings", cb: (p: T) => void): () => void {
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

let mockTimer: ReturnType<typeof setInterval> | null = null;
function ensureMockLoop() {
  if (isTauri() || mockTimer) return;
  mockTimer = setInterval(() => {
    const np = mock.poll();
    emitMock("now-playing", np);
    const playing = np.status === "playing";
    const beat = playing && np.positionMs % 500 < 200;
    emitMock("energy", {
      level: playing ? (beat ? 0.85 : 0.5) : 0,
      beat,
      bpm: playing ? 120 : undefined,
    } satisfies EnergyUpdate);
  }, 200);
}
ensureMockLoop();

export const bridge = {
  artSrc,
  isTauri,
  productName: branding.productName,

  getNowPlaying: () => (isTauri() ? invokeCmd<NowPlaying>("get_now_playing") : Promise.resolve(mock.poll())),
  mediaControl: (cmd: Control) => {
    if (isTauri()) return invokeCmd<null>("media_control", { cmd });
    mock.control(cmd);
    return Promise.resolve(null);
  },
  getPalette: (artworkUrl: string) =>
    isTauri()
      ? invokeCmd<{ dominant: string; accents: string[] }>("get_palette", { artworkUrl })
      : Promise.resolve({ dominant: "#8b5cf6", accents: ["#22d3ee", "#f472b6", "#facc15"] }),
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
  showPlayer: () => {
    if (isTauri()) return invokeCmd<null>("show_player");
    window.location.hash = "#/";
    return Promise.resolve(null);
  },
  getLicenseState: (): Promise<LicenseState> =>
    isTauri()
      ? invokeCmd<LicenseState>("get_license_state")
      : Promise.resolve({ state: "unlicensed" }),
  activateLicense: (key: string): Promise<LicenseState> =>
    isTauri()
      ? invokeCmd<LicenseState>("activate_license", { key })
      : Promise.resolve({ state: "invalid", reason: "license validation requires the desktop app" }),
  getEnergy: () =>
    isTauri()
      ? invokeCmd<EnergyUpdate>("get_energy")
      : Promise.resolve({ level: 0.5, beat: false, bpm: 120 }),
  seek: (positionMs: number) =>
    isTauri() ? invokeCmd<null>("seek", { positionMs }) : Promise.resolve(null),
  setVolume: (volume: number) =>
    isTauri() ? invokeCmd<null>("set_volume", { volume }) : Promise.resolve(null),
  getQueue: (): Promise<QueueState> =>
    isTauri()
      ? invokeCmd<QueueState>("get_queue")
      : Promise.resolve({
          items: DEMO_PLAYLIST.map(([title, artist, album, durationMs], i) => ({
            track: {
              id: `${artist} — ${title}`,
              title,
              artist,
              album,
              artworkUrl: "",
              durationMs,
            },
            path: `/demo/${i}.mp3`,
          })),
          currentIndex: mock.index,
        }),
  playQueueIndex: (index: number) => {
    if (isTauri()) return invokeCmd<null>("play_queue_index", { index });
    mock.index = index;
    mock.positionMs = 0;
    mock.anchor = Date.now();
    mock.status = "playing";
    return Promise.resolve(null);
  },
  clearQueue: () =>
    isTauri() ? invokeCmd<null>("clear_queue") : Promise.resolve(null),
  scanLibrary: (dir?: string) =>
    isTauri()
      ? invokeCmd<QueueItem[]>("scan_library", { dir: dir ?? null })
      : bridge.getQueue().then((q) => q.items),
  providerStatus: () =>
    isTauri() ? invokeCmd<boolean>("provider_status") : Promise.resolve(false),
  providerSearch: (source: string, query: string): Promise<RemoteTrack[]> =>
    isTauri()
      ? invokeCmd<RemoteTrack[]>("provider_search", { source, query })
      : Promise.resolve(
          DEMO_PLAYLIST.slice(0, 3).map(([title, artist, , durationMs], i) => ({
            id: `demo-${i}`,
            source,
            title,
            artist,
            durationMs,
            url: "",
            artworkUrl: "",
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
  resolveVideo: (artist: string, title: string): Promise<string | null> =>
    isTauri()
      ? invokeCmd<string | null>("resolve_video", { artist, title }).catch(() => null)
      : Promise.resolve(null),
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
  listDisplays: () =>
    isTauri()
      ? invokeCmd<DisplayInfo[]>("list_displays")
      : Promise.resolve([{ id: "display-0", name: "Display 1", primary: true }]),
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
        plays: 3 - i,
        ms: 500_000 - i * 120_000,
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
        { name: "Neon Fields", sub: "", plays: 5, ms: 900_000 },
      ],
    });
  },
};
