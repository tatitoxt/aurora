import { type CSSProperties } from "react";
import Library from "./Library";
import { VideoBackdrop } from "../VideoBackdrop";
import { useT } from "../i18n";
import { useLyricAnim } from "../lyricanim";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  bridge,
  subscribe,
  DEFAULT_SETTINGS,
  type NowPlaying,
  type LrcLine,
  type QueueState,
  type Settings,
} from "../bridge";
import { activeLyricIndex, adlibMask, adlibSegments, formatTime } from "../lib";
import { lyricOffsetFor, setLyricOffset, subscribeLyroff } from "../lyroff";
import SearchPanel from "../SearchPanel";
import {
  favEntryFor,
  favKeyFor,
  favKeys,
  loadFavs,
  subscribeFavs,
  toggleFav,
  type FavEntry,
} from "../favs";
import {
  ArrowsOut,
  Command,
  CornersIn,
  Export,
  GearSix,
  LockSimple,
  LockSimpleOpen,
  Moon,
  Pause,
  Play,
  PictureInPicture,
  Repeat,
  RepeatOnce,
  Shuffle,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SpeakerX,
  DotsThree,
  Heart,
  Plus,
  Playlist,
  TextT,
  YoutubeLogo,
  SoundcloudLogo,
  SpotifyLogo,
  AppleLogo,
  AmazonLogo,
  TidalLogo,
  CaretDown,
  CaretUp,
  SquaresFour,
  Books,
  ListBullets,
  MagnifyingGlass,
  Sparkle,
  PushPin,
  X,
} from "@phosphor-icons/react";
import { useLocation, useNavigate } from "react-router-dom";
import ShareCard, { SHARE_EVENT } from "../ShareCard";
import AmbientBg from "../AmbientBg";
import { openPalette } from "../Palette";
import { StickerLayer } from "../Stickers";

const PROVIDERS = [
  { id: "auto", label: "Automatic", icon: Sparkle, live: true },
  { id: "youtube", label: "YouTube Music", icon: YoutubeLogo, live: true },
  { id: "soundcloud", label: "SoundCloud", icon: SoundcloudLogo, live: true },
  { id: "spotify", label: "Spotify", icon: SpotifyLogo, live: false },
  { id: "apple", label: "Apple Music", icon: AppleLogo, live: false },
  { id: "tidal", label: "Tidal", icon: TidalLogo, live: false },
  { id: "amazon", label: "Amazon Music", icon: AmazonLogo, live: false },
] as const;

/** Provider host reported by the browser extension → friendly label + picker id. */
const EXT_HOSTS: [RegExp, string, string][] = [
  [/(music|www)\.youtube\.com/, "YouTube Music", "youtube"],
  [/open\.spotify\.com/, "Spotify", "spotify"],
  [/soundcloud\.com/, "SoundCloud", "soundcloud"],
  [/music\.apple\.com/, "Apple Music", "apple"],
  [/listen\.tidal\.com/, "Tidal", "tidal"],
  [/music\.amazon\./, "Amazon Music", "amazon"],
];
const extLabel = (host: string) =>
  EXT_HOSTS.find(([re]) => re.test(host))?.[1] ?? host;
const extProviderId = (host: string | null | undefined) =>
  (host && EXT_HOSTS.find(([re]) => re.test(host))?.[2]) ?? null;

/** Sharp video backdrop: muted, synced to the track position, faded in
 * once it can play. */
/** Stage videos go through VideoBackdrop so YouTube embeds (browser preview)
 * render as driven iframes with audio — desktop still gets the muted stream. */
function FsVideo({
  url,
  posMs,
  playing,
  cls = "fs__video",
  audible = false,
}: {
  url: string;
  posMs: number;
  playing: boolean;
  cls?: string;
  audible?: boolean;
}) {
  return (
    <VideoBackdrop
      url={url}
      posMs={posMs}
      playing={playing}
      cls={cls}
      readyCls="fs__video--ready"
      audible={audible}
    />
  );
}

/** The single player surface: the same composition at every window size
 * and in fullscreen — videoclip behind, lyric center, covers strip and the
 * transport pill. No view modes. */
export default function Stage() {
  const t = useT();
  const lanim = useLyricAnim();
  const nav = useNavigate();
  const loc = useLocation();
  const [nativeFs, setNativeFs] = useState(false);
  useEffect(() => {
    void bridge
      .isFullscreen()
      .then(setNativeFs)
      .catch(() => {});
    return subscribe<boolean>("fullscreen", setNativeFs);
  }, []);
  const exitFs = () => {
    // Only toggle when the window really is fullscreen — otherwise the
    // button would ENTER fullscreen while trying to leave the view.
    void bridge.isFullscreen().then((on) => {
      if (on) void bridge.toggleFullscreen();
      else if (loc.pathname === "/fullscreen") nav("/");
    });
  };
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [lyrics, setLyrics] = useState<LrcLine[] | null>(null);
  const [queue, setQueue] = useState<QueueState>({
    items: [],
    currentIndex: null,
  });
  const [art, setArt] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [shuffle, setShuffle] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [repeat, setRepeat] = useState<"off" | "all" | "one">("off");
  const [vol, setVol] = useState(1);
  const [volOpen, setVolOpen] = useState(false);
  const [share, setShare] = useState(false);
  const [speed, setSpeed] = useState(1.0);
  const [lyricsOn, setLyricsOn] = useState(true);
  const [thumbsOn, setThumbsOn] = useState(
    () => localStorage.getItem("fs.thumbs") !== "0",
  );
  const toggleThumbs = () =>
    setThumbsOn((v) => {
      localStorage.setItem("fs.thumbs", v ? "0" : "1");
      return !v;
    });
  const [timingOpen, setTimingOpen] = useState(false);
  const [, setStreamReady] = useState(false);
  const [searchSrc, setSearchSrc] = useState("auto");
  const [ext, setExt] = useState<{
    tabs: number;
    provider: string | null;
    providers?: string[];
  } | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [provOpen, setProvOpen] = useState(false);
  const [provMode, setProvMode] = useState<"prov" | "search">("prov");
  const [libOpen, setLibOpen] = useState(false);
  const libOpenRef = useRef(false);
  libOpenRef.current = libOpen;
  /* Floating "Up next" panel: glass over the video, pinnable and movable. */
  const [qPinned, setQPinned] = useState(
    () => localStorage.getItem("fs.qpin") === "1",
  );
  const [qOpen, setQOpen] = useState(qPinned);
  const [qPos, setQPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      return JSON.parse(localStorage.getItem("fs.qpos") || "null");
    } catch {
      return null;
    }
  });
  const toggleQPin = () =>
    setQPinned((v) => {
      localStorage.setItem("fs.qpin", v ? "0" : "1");
      return !v;
    });
  const [libPos, setLibPos] = useState<{ x: number; y: number } | null>(
    () => {
      try {
        return JSON.parse(localStorage.getItem("fs.libpos") || "null");
      } catch {
        return null;
      }
    },
  );
  const dragPanel = (
    setPos: (p: { x: number; y: number }) => void,
    key: string,
  ) => (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const panel = e.currentTarget.parentElement as HTMLElement;
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    let last: { x: number; y: number } | null = null;
    const move = (ev: PointerEvent) => {
      last = {
        x: Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx)),
        y: Math.max(
          0,
          Math.min(window.innerHeight - r.height, ev.clientY - dy),
        ),
      };
      setPos(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (last) localStorage.setItem(key, JSON.stringify(last));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const [coverScale, setCoverScale] = useState(() => {
    const v = parseFloat(localStorage.getItem("noctbeat.fscss") ?? "100");
    return Number.isFinite(v) ? Math.min(160, Math.max(60, v)) : 100;
  });
  const [clockScale, setClockScale] = useState(() => {
    const v = parseFloat(localStorage.getItem("noctbeat.fsclocksc") ?? "100");
    return Number.isFinite(v) ? Math.min(160, Math.max(60, v)) : 100;
  });
  const [lyricScale, setLyricScale] = useState(() => {
    const v = parseFloat(localStorage.getItem("noctbeat.fslyrsc") ?? "100");
    return Number.isFinite(v) ? Math.min(160, Math.max(60, v)) : 100;
  });
  const [scaleLock, setScaleLock] = useState(
    () => localStorage.getItem("noctbeat.fslock") === "1",
  );
  const [favs, setFavs] = useState<FavEntry[]>(loadFavs);
  useEffect(() => subscribeFavs(() => setFavs(loadFavs())), []);
  // Palette's "Share now playing" dispatches a window event — the share card
  // is only mounted here, so listen for it.
  useEffect(() => {
    const on = () => setShare(true);
    window.addEventListener(SHARE_EVENT, on);
    return () => window.removeEventListener(SHARE_EVENT, on);
  }, []);
  const favSet = useMemo(() => favKeys(favs), [favs]);

  useEffect(() => {
    bridge.getNowPlaying().then(setNp);
    bridge.getQueue().then(setQueue);
    bridge.getShuffle().then(setShuffle);
    bridge.getRepeat().then(setRepeat);
    bridge.getVolume().then(setVol);
    bridge.getSettings().then(setSettings);
    bridge.providerStatus().then(setStreamReady);
    const off = subscribe<NowPlaying>("now-playing", setNp);
    const offQ = subscribe<QueueState>("queue", setQueue);
    const offS = subscribe<Settings>("settings", setSettings);
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => {
      off();
      offQ();
      offS();
      clearInterval(clock);
    };
  }, []);

  /* Refresh the bridge state each time the picker opens — tabs can
     connect or go quiet while the stage stays mounted. */
  useEffect(() => {
    if (!provOpen) return;
    bridge
      .getExtStatus()
      .then(setExt)
      .catch(() => {});
  }, [provOpen]);

  const connected = new Set(
    (ext?.providers?.length
      ? ext.providers
      : ext?.provider
        ? [ext.provider]
        : []
    ).map(extProviderId),
  );
  const provLabel = (id: string) =>
    id === "auto"
      ? t("fs.auto")
      : (PROVIDERS.find((p) => p.id === id)?.label ?? id);
  const ProvIcon =
    PROVIDERS.find((p) => p.id === searchSrc)?.icon ?? YoutubeLogo;
  const track = np?.track ?? null;
  const pos = np?.positionMs ?? 0;
  const dur = track?.durationMs ?? 0;
  const favKey = favKeyFor(np);
  const fav = favKey !== "" && favSet.has(favKey);
  const onToggleFav = () => {
    const entry = favEntryFor(np);
    if (entry) setFavs((prev) => toggleFav(prev, entry));
  };

  // Resolved artwork URLs for the mosaic wall and the cover carousel.
  const [artMap, setArtMap] = useState<Record<string, string>>({});
  useEffect(() => {
    const urls = [
      ...new Set(
        queue.items
          .map((it) => it.track.artworkUrl)
          .filter(Boolean) as string[],
      ),
    ].slice(0, 24);
    let dead = false;
    void Promise.all(urls.map((u) => bridge.artSrc(u).catch(() => ""))).then(
      (srcs) => {
        if (dead) return;
        const m: Record<string, string> = {};
        urls.forEach((u, i) => {
          if (srcs[i]) m[u] = srcs[i];
        });
        setArtMap(m);
      },
    );
    return () => {
      dead = true;
    };
  }, [queue.items]);
  const wall = Object.values(artMap);

  // Keyboard: space toggles play, arrows seek/volume, S/R/L/F, Esc exits fs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The Library popup owns the keyboard while open; Escape only dismisses it.
      if (libOpenRef.current) {
        if (e.key === "Escape") setLibOpen(false);
        return;
      }
      // Palette overlay or any editable owns the keys.
      const t = e.target as HTMLElement | null;
      if (
        t?.closest(".palette") ||
        t?.closest("input, textarea, [contenteditable]")
      )
        return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === " ") {
        // Buttons (incl. role=button lyrics) own Space themselves.
        if (t?.closest("button, [role='button']")) return;
        e.preventDefault();
        void bridge.mediaControl("play-pause");
      } else if (e.key === "ArrowRight") {
        if (e.shiftKey) void bridge.mediaControl("next");
        else void bridge.seek(pos + 10_000);
      } else if (e.key === "ArrowLeft") {
        if (e.shiftKey) void bridge.mediaControl("previous");
        else void bridge.seek(Math.max(0, pos - 10_000));
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const d = e.key === "ArrowUp" ? 0.05 : -0.05;
        void bridge.getVolume().then((v) => {
          const nv = Math.min(1, Math.max(0, v + d));
          setVol(nv);
          void bridge.setVolume(nv);
        });
      } else if (e.key === "s" || e.key === "S") {
        void bridge.getShuffle().then((on) => {
          const next = !on;
          setShuffle(next);
          void bridge.setShuffle(next);
        });
      } else if (e.key === "r" || e.key === "R") {
        void bridge.getRepeat().then((m) => {
          const next = m === "off" ? "all" : m === "all" ? "one" : "off";
          setRepeat(next as "off" | "all" | "one");
          void bridge.setRepeat(next);
        });
      } else if (e.key === "l" || e.key === "L") {
        const entry = favEntryFor(np);
        if (entry) setFavs((prev) => toggleFav(prev, entry));
      } else if (e.key === "f" || e.key === "F") {
        void bridge.toggleFullscreen();
      } else if (e.key === "Escape") {
        exitFs();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav, pos, loc.pathname]);

  useEffect(() => {
    if (!track) {
      setLyrics(null);
      setArt("");
      return;
    }
    bridge.getLyrics().then(setLyrics);
    bridge.getQueue().then(setQueue);
    if (track.artworkUrl) void bridge.artSrc(track.artworkUrl).then(setArt);
    else setArt("");
  }, [track?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The videoclip is ALWAYS the backdrop: resolved once per track
  // (track?.id dep — np object changes every tick). Falls back to the
  // blurred art wall when no clip resolves.
  const trackKey = track?.id ?? null;
  useEffect(() => {
    setVideoUrl(null);
    if (!trackKey || !track) return;
    let stale = false;
    bridge.resolveVideo(track.artist, track.title).then((u) => {
      if (!stale && u) setVideoUrl(u);
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackKey]);

  const [lyroffTick, setLyroffTick] = useState(0);
  useEffect(() => subscribeLyroff(() => setLyroffTick((t) => t + 1)), []);
  void lyroffTick;
  const lyroff = lyricOffsetFor(np);
  const active = lyrics ? activeLyricIndex(lyrics, pos + lyroff) : -1;

  // Close the timing editor when the playing track changes — its nudges
  // would otherwise save to the new track instead of the edited one.
  const timingKey = np?.track ? `${np.source}:${np.track.id}` : "";
  const prevTimingKey = useRef(timingKey);
  useEffect(() => {
    if (prevTimingKey.current !== timingKey) {
      prevTimingKey.current = timingKey;
      setTimingOpen(false);
    }
  }, [timingKey]);
  const playing = np?.status === "playing";
  const line = lyrics && active >= 0 ? lyrics[active].text : null;
  /* Karaoke word timing: enhanced-LRC word tags when present, else an even
     split of the line's duration across its words. */
  const lineObj = lyrics && active >= 0 ? lyrics[active] : null;
  const nextObj =
    lyrics && active + 1 < lyrics.length ? lyrics[active + 1] : null;
  const timedWords = !!lineObj?.words?.length;
  const wordSegs = !lineObj
    ? []
    : timedWords
      ? lineObj.words!.map((w) => w.text)
      : lineObj.text
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => w + " ");
  const wordAdlib = adlibMask(wordSegs);
  const posL = pos + lyroff;
  const wordNow = !lineObj
    ? -1
    : timedWords
      ? lineObj.words!.reduce((acc, w, i) => (posL >= w.atMs ? i : acc), -1)
      : Math.floor(
          (posL - lineObj.atMs) /
            (Math.max(nextObj ? nextObj.atMs - lineObj.atMs : 5000, 800) /
              Math.max(wordSegs.length, 1)),
        );

  // "local" files seek via rodio; "demo" (web preview / mock) seeks its own
  // clock. Other sources may not support seeking.
  const canSeek = np?.source === "local" || np?.source === "demo";
  const scrubTo = (el: HTMLElement, clientX: number) => {
    if (!canSeek || !dur) return;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    void bridge.seek(Math.floor(frac * dur));
  };
  // Click AND drag to scrub, like YouTube/Apple.
  const scrubProps = {
    role: "slider" as const,
    "aria-label": "Seek",
    style: { cursor: canSeek ? "pointer" : "default" },
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (!canSeek || e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      scrubTo(e.currentTarget, e.clientX);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (e.buttons & 1) scrubTo(e.currentTarget, e.clientX);
    },
  };

  /* Cover carousel: whichever cover sits nearest the strip's center is the
     highlighted card — scrolling never changes the song, only clicking does. */
  const ci = queue.currentIndex ?? 0;
  const [focusIdx, setFocusIdx] = useState(ci);
  /* Ring order centred on the playing track, so the strip always has
     covers on both sides (the playlist wraps around). */
  const qn = queue.items.length;
  const half = Math.floor((qn - 1) / 2);
  const ring = Array.from(
    { length: qn },
    (_, k) => (ci + k - half + qn * 2) % qn,
  );
  const slot = (i: number) => ring.indexOf(i);
  const covers = ring
    .map((i) => ({ it: queue.items[i], i }))
    .map(({ it, i }) => ({
      key: it.path + i,
      i,
      src: artMap[it.track.artworkUrl],
      title: it.track.title,
      artist: it.track.artist,
      on: i === focusIdx,
      playing: i === ci,
      side:
        slot(i) < slot(focusIdx) ? "l" : slot(i) > slot(focusIdx) ? "r" : "",
    }));

  /* Track change: refocus and recenter on the playing cover. */
  const coversRef = useRef<HTMLDivElement>(null);

  /* Inertial scrolling: wheel deltas and drag flings feed `target`/`vel`;
     a rAF loop eases scrollLeft toward target so motion is butter-smooth
     instead of jumping per input event. */
  const scrollAnim = useRef({
    raf: 0,
    target: 0,
    vel: 0,
    set: false,
    snap: false,
  });
  const runCoversAnim = () => {
    const s = scrollAnim.current;
    if (s.raf) return;
    const step = () => {
      const el = coversRef.current;
      if (!el) {
        s.raf = 0;
        return;
      }
      const max = Math.max(0, el.scrollWidth - el.clientWidth);
      if (!s.set) {
        s.target = el.scrollLeft;
        s.set = true;
      }
      s.target += s.vel;
      s.vel *= 0.93;
      s.target = Math.max(0, Math.min(max, s.target));
      const diff = s.target - el.scrollLeft;
      if (Math.abs(diff) < 0.5 && Math.abs(s.vel) < 0.3) {
        el.scrollLeft = s.target;
        s.vel = 0;
        s.raf = 0;
        s.snap = false;
        return;
      }
      el.scrollLeft += diff * (s.snap ? 0.09 : 0.16);
      s.raf = requestAnimationFrame(step);
    };
    s.raf = requestAnimationFrame(step);
  };
  const centerCover = (idx: number, gentle = false) => {
    const el = coversRef.current;
    const n = el?.querySelector<HTMLElement>(`[data-idx="${idx}"]`);
    if (!el || !n) return;
    const stripMid = el.getBoundingClientRect().left + el.clientWidth / 2;
    const r = n.getBoundingClientRect();
    const s = scrollAnim.current;
    s.target = el.scrollLeft + (r.left + r.width / 2 - stripMid);
    s.set = true;
    s.snap = gentle;
    runCoversAnim();
  };
  useEffect(() => {
    focusIdxRef.current = ci;
    setFocusIdx(ci);
    centerCover(ci);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ci, queue.items.length]);

  /* After the strip settles, highlight the cover nearest the center and
     ease it to the middle so the layout converges. */
  const focusTimer = useRef(0);
  useEffect(
    () => () => {
      window.clearTimeout(focusTimer.current);
      cancelAnimationFrame(scrollAnim.current.raf);
      scrollAnim.current.raf = 0;
    },
    [],
  );
  /* While scrolling, the cover nearest the strip's center highlights
     immediately — the song never changes until a click. When the strip
     settles it eases the focused cover to the exact middle (gentle snap). */
  const focusIdxRef = useRef(focusIdx);
  const nearestCover = () => {
    const el = coversRef.current;
    if (!el) return -1;
    const mid = el.getBoundingClientRect().left + el.clientWidth / 2;
    let best = -1;
    let bd = Infinity;
    el.querySelectorAll<HTMLElement>("[data-idx]").forEach((n) => {
      const r = n.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - mid);
      if (d < bd) {
        bd = d;
        best = Number(n.dataset.idx);
      }
    });
    return best;
  };
  const onCoversScroll = () => {
    const near = nearestCover();
    if (near >= 0 && near !== focusIdxRef.current) {
      focusIdxRef.current = near;
      setFocusIdx(near);
    }
    window.clearTimeout(focusTimer.current);
    focusTimer.current = window.setTimeout(() => {
      const best = nearestCover();
      if (best >= 0) {
        focusIdxRef.current = best;
        setFocusIdx(best);
        centerCover(best, true);
      }
    }, 140);
  };

  const hh = String(now.getHours() % 12 || 12);
  const mm = String(now.getMinutes()).padStart(2, "0");
  const date = now.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  // Drag the (decorated but titlebar-less) window from empty surfaces.
  const onGlassMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (
      (e.target as HTMLElement).closest(
        "button, input, a, select, [role='slider'], [role='button'], .fs__covers, .fs__qpanel, .fs__libpop, .stkr",
      )
    )
      return;
    void bridge.playerStartDrag();
  };

  return (
    <div
      className={`fs fs--albums ${nativeFs ? "" : "fs--win"}`}
      style={
        {
          "--cscale": coverScale / 100,
          "--clksc": clockScale / 100,
          "--lyrsc": lyricScale / 100,
        } as CSSProperties
      }
      onMouseDown={onGlassMouseDown}
    >
      <div className="fs__bg">
        {videoUrl ? (
          <FsVideo url={videoUrl} posMs={pos} playing={playing} audible />
        ) : wall.length > 1 ? (
          <div className="fs__wall">
            {(wall.length < 24
              ? Array.from(
                  { length: Math.ceil(24 / wall.length) },
                  () => wall,
                ).flat()
              : wall
            ).map((src, i) => (
              <img key={i} src={src} alt="" />
            ))}
          </div>
        ) : art ? (
          <img src={art} alt="" />
        ) : (
          <div className="fs__mesh" />
        )}
        <div className="fs__veil" />
        {settings.ambientBg && !videoUrl && <AmbientBg />}
      </div>
      <div className="fs__grain" aria-hidden="true" />

      {/* Top control strip — always visible above the video/wall. The
          left side stays clear for the macOS traffic lights. */}
      <div className="fs__topbar">
        <button
          className="fs__icon"
          aria-label={t("nav.library")}
          title={t("nav.library")}
          onClick={() => setLibOpen(true)}
        >
          <Books size={15} />
        </button>
        <button
          className={`fs__icon ${lyricsOn ? "fs__icon--on" : ""}`}
          aria-label={t("fs.lyricsBtn")}
          title={t("fs.lyricsBtn")}
          onClick={() => setLyricsOn((v) => !v)}
        >
          <TextT size={15} />
        </button>
        <button
          className="fs__icon"
          aria-label={t("nav.settings")}
          title={t("nav.settings")}
          onClick={() => nav("/settings")}
        >
          <GearSix size={15} />
        </button>
        <button
          className="fs__icon"
          aria-label={t("nav.hud")}
          title={t("nav.hud")}
          onClick={() =>
            void bridge.updateSettings({ ...settings, hudEnabled: true })
          }
        >
          <PictureInPicture size={15} />
        </button>
        <button
          className="fs__icon"
          aria-label={t("nav.fullscreen")}
          title={t("nav.fullscreen")}
          onClick={() => void bridge.toggleFullscreen()}
        >
          {nativeFs ? <CornersIn size={15} /> : <ArrowsOut size={15} />}
        </button>
      </div>

      <div className="fs__clockwrap">
        <div className="fs__date">{date}</div>
        <div className="fs__clock">
          {hh}
          <span className="fs__colon">
            <i />
            <i />
          </span>
          {mm}
        </div>
      </div>

      {libOpen && (
        <div
          className="fs__libpop"
          style={
            libPos
              ? {
                  left: `min(${libPos.x}px, calc(100% - 140px))`,
                  top: `min(${libPos.y}px, calc(100% - 80px))`,
                }
              : undefined
          }
          onClick={(e) =>
            (e.target as HTMLElement).closest("a") && setLibOpen(false)
          }
        >
          <div
            className="fs__libgrip"
            title={t("fs.dragMove")}
            onPointerDown={dragPanel(setLibPos, "fs.libpos")}
          />
          <button
            className="fs__icon fs__libclose"
            aria-label={t("fs.close")}
            onClick={() => setLibOpen(false)}
          >
            <X size={14} />
          </button>
          <Library />
        </div>
      )}
      {qOpen && queue.items.length > 0 && (
        <div
          className="fs__qpanel"
          style={
            qPos
              ? // re-clamped on render so a position saved in a bigger window stays reachable
                {
                  left: `min(${qPos.x}px, calc(100% - 140px))`,
                  top: `min(${qPos.y}px, calc(100% - 80px))`,
                }
              : undefined
          }
        >
          <div className="fs__qhead" onPointerDown={dragPanel(setQPos, "fs.qpos")}>
            <span className="fs__qtitle">{t("fs.upNext")}</span>
            <button
              className={`fs__icon ${qPinned ? "fs__icon--on" : ""}`}
              aria-label={qPinned ? t("fs.unpin") : t("fs.pin")}
              title={qPinned ? t("fs.unpin") : t("fs.pin")}
              onClick={toggleQPin}
            >
              <PushPin size={13} weight={qPinned ? "fill" : "regular"} />
            </button>
            <button
              className="fs__icon"
              aria-label={t("fs.close")}
              title={t("fs.close")}
              onClick={() => setQOpen(false)}
            >
              <X size={13} />
            </button>
          </div>
          <div className="fs__qlist">
            {queue.items.map((it, i) => (
              <button
                key={it.path + i}
                className={`fs__qrow ${i === ci ? "fs__qrow--on" : ""}`}
                onClick={() => {
                  void bridge.playQueueIndex(i);
                  if (!qPinned) setQOpen(false);
                }}
              >
                {artMap[it.track.artworkUrl] ? (
                  <img src={artMap[it.track.artworkUrl]} alt="" />
                ) : (
                  <span className="fs__qimg" />
                )}
                <span className="fs__qtxt">
                  <span className="fs__qname">{it.track.title}</span>
                  <span className="fs__qsub">{it.track.artist}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="fs__center">
        {lyricsOn ? (
          line ? (
            <div className="fs__lyrics">
              {active > 0 && (
                <div className="fs__lyrctx fs__lyrctx--up" key={`p${active}`}>
                  {adlibSegments(lyrics![active - 1].text)
                    .map((s) => s.text)
                    .join("")}
                </div>
              )}
              <div
                className={`fs__lyric ${lanim}`}
                key={active}
                role="button"
                tabIndex={0}
                onClick={() => setTimingOpen((v) => !v)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTimingOpen((v) => !v);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setTimingOpen((v) => !v);
                  }
                }}
              >
                {wordSegs.map((w, i) => {
                  // inline-block words drop trailing spaces, so keep them outside
                  const word = w.trimEnd();
                  return (
                    <Fragment key={i}>
                      <span
                        className={`fsword ${wordAdlib[i] ? "adlib" : ""} ${
                          i < wordNow
                            ? "fsword--done"
                            : i === wordNow
                              ? "fsword--now"
                              : ""
                        }`}
                        style={{ "--i": i } as CSSProperties}
                      >
                        {word}
                      </span>
                      {w.slice(word.length)}
                    </Fragment>
                  );
                })}
              </div>
              {lyrics && active + 1 < lyrics.length && (
                <div className="fs__lyrctx fs__lyrctx--dn" key={`n${active}`}>
                  {adlibSegments(lyrics[active + 1].text)
                    .map((s) => s.text)
                    .join("")}
                </div>
              )}
              {lyrics && active + 2 < lyrics.length && (
                <div className="fs__lyrctx fs__lyrctx--dn2" key={`m${active}`}>
                  {adlibSegments(lyrics[active + 2].text)
                    .map((s) => s.text)
                    .join("")}
                </div>
              )}
            </div>
          ) : track ? (
            <div className="fs__lyric fs__lyric--title">{track.title}</div>
          ) : (
            <div className="fs__lyric fs__lyric--title">
              {bridge.productName}
            </div>
          )
        ) : null}
        {timingOpen && (
          <span className="fs__timing">
            {([-200, -50, 50, 200] as number[]).map((d) => (
              <button
                key={d}
                className="fs__morebtn"
                onClick={() => setLyricOffset(np, lyroff + d)}
              >
                {d > 0 ? `+${d}` : d}ms
              </button>
            ))}
            <button
              className="fs__morebtn"
              onClick={() => {
                setLyricOffset(np, 0);
                setTimingOpen(false);
              }}
            >
              Reset
              {lyroff !== 0 ? ` (${lyroff > 0 ? "+" : ""}${lyroff}ms)` : ""}
            </button>
          </span>
        )}
      </div>

      {covers.length > 1 && thumbsOn && (
        <div
          ref={coversRef}
          className={`fs__covers ${lyricsOn ? "" : "fs__covers--big"}`}
          onScroll={onCoversScroll}
          onWheel={(e) => {
            // horizontal scroll on any wheel axis, eased through the
            // inertial target — pure browsing, no track change
            const el = coversRef.current;
            if (!el) return;
            const s = scrollAnim.current;
            if (!s.set) {
              s.target = el.scrollLeft;
              s.set = true;
            }
            const d =
              Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
            s.target += d;
            s.vel = 0;
            runCoversAnim();
          }}
          onPointerDown={(e) => {
            const el = coversRef.current;
            if (!el) return;
            e.preventDefault(); // stop native image/text dragging
            const s = scrollAnim.current;
            cancelAnimationFrame(s.raf);
            s.raf = 0;
            s.vel = 0;
            const sx = e.clientX,
              sl = el.scrollLeft;
            let moved = false;
            let lastX = sx,
              vel = 0;
            const move = (ev: PointerEvent) => {
              const dx = ev.clientX - sx;
              if (Math.abs(dx) > 6) moved = true;
              vel = lastX - ev.clientX; // px moved per event, scroll direction
              lastX = ev.clientX;
              el.scrollLeft = sl - dx;
              s.target = el.scrollLeft;
              s.set = true;
            };
            const end = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", end);
              window.removeEventListener("pointercancel", end);
              // Fling: release momentum keeps the strip gliding.
              if (moved && Math.abs(vel) > 1) {
                s.vel = vel * 6;
                runCoversAnim();
              }
              // A real drag must not count as a click on the cover under it.
              if (moved) {
                const cap = (ce: Event) => {
                  ce.stopPropagation();
                  ce.preventDefault();
                };
                el.addEventListener("click", cap, {
                  capture: true,
                  once: true,
                });
                window.setTimeout(
                  () => el.removeEventListener("click", cap, { capture: true }),
                  400,
                );
              }
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", end);
            window.addEventListener("pointercancel", end);
          }}
        >
          {covers.map((c) =>
            c.on ? (
              /* Center card: video/art inside, meta overlaid on scrim.
                 Highlighted by position — click plays it if it isn't the
                 track already playing. */
              <button
                key={c.key}
                data-idx={c.i}
                className={`fs__cover fs__cover--on ${c.playing ? "fs__cover--live" : ""}`}
                onClick={
                  c.playing ? undefined : () => void bridge.playQueueIndex(c.i)
                }
                title={`${c.title} — ${c.artist}`}
              >
                <div className="fs__coverimg">
                  {c.src ? (
                    <img src={c.src} alt="" />
                  ) : (
                    <div
                      className="fs__meta-art"
                      style={{ width: "100%", height: "100%" }}
                    />
                  )}
                  <div className="fs__cscrim" />
                  <div className="fs__cvmeta">
                    <div className="fs__cvtitle">{c.title}</div>
                    <div className="fs__cvart">{c.artist}</div>
                  </div>
                </div>
              </button>
            ) : (
              <button
                key={c.key}
                data-idx={c.i}
                className={`fs__cover fs__cover--${c.side} ${c.playing ? "fs__cover--live" : ""}`}
                style={
                  {
                    "--i": Math.min(Math.abs(c.i - focusIdx), 4),
                  } as CSSProperties
                }
                onClick={() => void bridge.playQueueIndex(c.i)}
                title={`${c.title} — ${c.artist}`}
              >
                {c.src ? (
                  <img src={c.src} alt="" />
                ) : (
                  <div
                    className="fs__cover-img fs__meta-art"
                    style={{
                      width: "100%",
                      aspectRatio: "1",
                      borderRadius: 12,
                    }}
                  />
                )}
                <div className="fs__cname">{c.title}</div>
                <div className="fs__cart">{c.artist}</div>
              </button>
            ),
          )}
        </div>
      )}

      <div className="fs__bottom">
        <div className="fs__dock">
          <div className="fs__nowrow">
            <div className="fs__nowtxt">
              <div className="fs__mtitle">
                {track?.title ?? t("fs.nothingPlaying")}
              </div>
              <div className="fs__msub">
                {track
                  ? `${track.artist} · ${track.album}`
                  : t("fs.startMusic")}
              </div>
              {covers.length > 1 && (
                <button
                  className="fs__icon fs__thumbtog"
                  aria-label={
                    thumbsOn ? t("fs.thumbsHide") : t("fs.thumbsShow")
                  }
                  title={thumbsOn ? t("fs.thumbsHide") : t("fs.thumbsShow")}
                  onClick={toggleThumbs}
                >
                  {thumbsOn ? <CaretDown size={14} /> : <CaretUp size={14} />}
                </button>
              )}
            </div>
            <div className="fs__timerow">
              <span className="fs__tm">{formatTime(pos)}</span>
              <div
                className={`fs__hair ${canSeek && dur ? "" : "fs__hair--off"}`}
                {...scrubProps}
              >
                <div
                  className="fs__hairfill"
                  style={{
                    width: `${dur ? Math.min(100, (pos / dur) * 100) : 0}%`,
                  }}
                />
              </div>
              <span className="fs__tm fs__tm--end">
                {dur ? formatTime(dur) : "-:--"}
              </span>
            </div>
          </div>
          <div className="fs__pill">
            <span className="fs__pgl">
              <span className="fs__vol fs__vol--prov">
                <button
                  className={`fs__icon ${provOpen && provMode === "prov" ? "fs__icon--on" : ""}`}
                  aria-label={t("fs.provider")}
                  title={t("fs.provider")}
                  onClick={() => {
                    setProvMode("prov");
                    setProvOpen((v) => !v || provMode !== "prov");
                  }}
                >
                  <ProvIcon size={16} weight="fill" />
                </button>
                {provOpen && (
                  <span
                    className={`fs__volpop fs__morepop fs__provpop fs__provpop--${provMode}`}
                  >
                    {provMode === "prov" && (
                      <>
                        {ext && ext.tabs > 0 ? (
                          <span className="fs__extlive">
                            ● {t("fs.connected")} ·{" "}
                            {(ext.providers?.length
                              ? ext.providers
                              : ext.provider
                                ? [ext.provider]
                                : []
                            )
                              .map(extLabel)
                              .join(", ")}
                          </span>
                        ) : (
                          <span className="fs__extlive fs__extlive--off">
                            {t("fs.extHint")}
                            <br />
                            {t("fs.extStep1")}
                            <br />
                            {bridge.isTauri() ? (
                              t("fs.extStep2")
                            ) : (
                              <a
                                href="noctbeat-bridge.zip"
                                download
                                className="fs__extdl"
                              >
                                ↓ {t("fs.extDownload")}
                              </a>
                            )}
                          </span>
                        )}
                        {PROVIDERS.map((p) => {
                          const on = connected.has(p.id);
                          return (
                            <button
                              key={p.id}
                              className={`fs__morebtn ${searchSrc === p.id ? "fs__morebtn--on" : ""}`}
                              onClick={() => setSearchSrc(p.id)}
                            >
                              <p.icon size={14} weight="fill" /> {provLabel(p.id)}
                              {on && (
                                <span className="fs__soon fs__soon--live">
                                  {t("fs.connected")}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </>
                    )}
                    {provMode === "search" && (
                      <SearchPanel
                        src={searchSrc}
                        label={provLabel}
                        connected={connected}
                        onPlayed={() => {}}
                      />
                    )}
                  </span>
                )}
              </span>
              <button
                className={`fs__icon ${qOpen ? "fs__icon--on" : ""}`}
                aria-label={t("fs.upNext")}
                title={t("fs.upNext")}
                onClick={() => setQOpen((v) => !v)}
              >
                <ListBullets size={15} />
              </button>
              <span className="fs__srcsep" />
              <button
                className={`fs__icon fs__pillopt ${fav ? "fs__icon--on fs__icon--fav" : ""}`}
                aria-label={fav ? "Unlike" : "Like"}
                title={fav ? t("fs.unlike") : t("fs.like")}
                onClick={onToggleFav}
              >
                <Heart size={15} weight={fav ? "fill" : "regular"} />
              </button>
              <button
                className={`fs__icon fs__pillopt ${shuffle ? "fs__icon--on" : ""}`}
                aria-label="Shuffle"
                title={t("fs.shuffle")}
                onClick={() =>
                  void bridge.setShuffle(!shuffle).then(setShuffle)
                }
              >
                <Shuffle size={15} weight={shuffle ? "fill" : "regular"} />
              </button>
              <button
                className="fs__icon"
                aria-label={t("fs.prev")}
                onClick={() => void bridge.mediaControl("previous")}
              >
                <SkipBack weight="fill" size={17} />
              </button>
            </span>
            <button
              className="fs__play"
              aria-label={playing ? t("fs.pauseBtn") : t("fs.playBtn")}
              onClick={() => void bridge.mediaControl("play-pause")}
            >
              {playing ? (
                <Pause weight="fill" size={20} />
              ) : (
                <Play weight="fill" size={20} />
              )}
            </button>
            <span className="fs__pgr">
              <button
                className="fs__icon"
                aria-label={t("fs.next")}
                onClick={() => void bridge.mediaControl("next")}
              >
                <SkipForward weight="fill" size={17} />
              </button>
              <button
                className={`fs__icon fs__pillopt ${repeat !== "off" ? "fs__icon--on" : ""}`}
                aria-label={`Repeat: ${repeat}`}
                title={t("fs.repeat", { mode: repeat })}
                onClick={() => {
                  const next =
                    repeat === "off" ? "all" : repeat === "all" ? "one" : "off";
                  void bridge
                    .setRepeat(next)
                    .then((m) => setRepeat(m as "off" | "all" | "one"));
                }}
              >
                {repeat === "one" ? (
                  <RepeatOnce size={15} weight="fill" />
                ) : (
                  <Repeat
                    size={15}
                    weight={repeat === "all" ? "fill" : "regular"}
                  />
                )}
              </button>
              <span className="fs__vol fs__volvol">
                <button
                  className={`fs__icon fs__pillopt ${vol === 0 ? "fs__icon--on" : ""}`}
                  aria-label="Volume"
                  title={t("fs.volume")}
                  onClick={() => setVolOpen((v) => !v)}
                >
                  {vol === 0 ? (
                    <SpeakerX size={15} />
                  ) : (
                    <SpeakerHigh size={15} />
                  )}
                </button>
                {volOpen && (
                  <span className="fs__volpop">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(vol * 100)}
                      aria-label="Volume"
                      onChange={(e) => {
                        const v = Number(e.target.value) / 100;
                        setVol(v);
                        void bridge.setVolume(v);
                      }}
                    />
                  </span>
                )}
              </span>
              <button
                  className={`fs__icon ${provOpen && provMode === "search" ? "fs__icon--on" : ""}`}
                  aria-label={t("fs.searchSongs")}
                  title={t("fs.searchSongs")}
                  onClick={() => {
                    setProvMode("search");
                    setProvOpen((v) => !v || provMode !== "search");
                  }}
                >
                  <MagnifyingGlass size={16} />
                </button>
              <span className="fs__vol">
                <button
                  className={`fs__icon ${moreOpen ? "fs__icon--on" : ""}`}
                  aria-label={t("fs.more")}
                  title={t("fs.more")}
                  onClick={() => setMoreOpen((v) => !v)}
                >
                  <DotsThree size={17} weight="bold" />
                </button>
                {moreOpen && (
                  <span className="fs__volpop fs__morepop">
                    {/* Compact-window controls: below 560px the pill hides
                    shuffle/repeat/fav/volume — reachable here instead. */}
                    <span className="fs__menuopt">
                      <button
                        className={`fs__icon ${shuffle ? "fs__icon--on" : ""}`}
                        aria-label="Shuffle"
                        title={t("fs.shuffle")}
                        onClick={() =>
                          void bridge.setShuffle(!shuffle).then(setShuffle)
                        }
                      >
                        <Shuffle
                          size={15}
                          weight={shuffle ? "fill" : "regular"}
                        />
                      </button>
                      <button
                        className={`fs__icon ${repeat !== "off" ? "fs__icon--on" : ""}`}
                        aria-label={`Repeat: ${repeat}`}
                        title={t("fs.repeat", { mode: repeat })}
                        onClick={() => {
                          const next =
                            repeat === "off"
                              ? "all"
                              : repeat === "all"
                                ? "one"
                                : "off";
                          void bridge
                            .setRepeat(next)
                            .then((m) => setRepeat(m as "off" | "all" | "one"));
                        }}
                      >
                        {repeat === "one" ? (
                          <RepeatOnce size={15} weight="fill" />
                        ) : (
                          <Repeat
                            size={15}
                            weight={repeat === "all" ? "fill" : "regular"}
                          />
                        )}
                      </button>
                      <button
                        className={`fs__icon ${fav ? "fs__icon--on fs__icon--fav" : ""}`}
                        aria-label={fav ? "Unlike" : "Like"}
                        title={fav ? t("fs.unlike") : t("fs.like")}
                        onClick={onToggleFav}
                      >
                        <Heart size={15} weight={fav ? "fill" : "regular"} />
                      </button>
                      <input
                        type="range"
                        className="fs__slider"
                        aria-label="Volume"
                        min={0}
                        max={100}
                        value={Math.round(vol * 100)}
                        onChange={(e) => {
                          const v = Number(e.target.value) / 100;
                          setVol(v);
                          void bridge.setVolume(v);
                        }}
                      />
                    </span>
                    <button
                      className="fs__morebtn"
                      onClick={() => {
                        setShare(true);
                        setMoreOpen(false);
                      }}
                    >
                      <Export size={13} /> {t("fs.share")}
                    </button>
                    <button
                      className="fs__morebtn"
                      onClick={() => {
                        openPalette();
                        setMoreOpen(false);
                      }}
                    >
                      <Command size={13} /> {t("nav.commands")}
                    </button>
                    <button
                      className="fs__morebtn"
                      onClick={() => {
                        void bridge.setSleepTimer(30);
                        setMoreOpen(false);
                      }}
                    >
                      <Moon size={13} /> {t("fs.sleep30")}
                    </button>
                    <span className="fs__moresep" />
                    <span className="fs__stylehead">{t("fs.speed")}</span>
                    {(
                      [
                        ["Slowed", 0.8],
                        ["Normal", 1.0],
                        ["Nightcore", 1.25],
                      ] as Array<[string, number]>
                    ).map(([label, v]) => (
                      <button
                        key={label}
                        className={`fs__morebtn ${speed === v ? "fs__morebtn--on" : ""}`}
                        onClick={() => {
                          setSpeed(v);
                          void bridge.setSpeed(v);
                        }}
                      >
                        {label} {v}×
                      </button>
                    ))}
                    <span className="fs__moresep" />
                    <button
                      className="fs__morebtn"
                      onClick={() => nav("/library")}
                    >
                      <Playlist size={13} /> {t("nav.library")}
                    </button>
                    <button
                      className="fs__morebtn"
                      onClick={() => nav("/settings")}
                    >
                      <GearSix size={13} /> {t("fs.settings")}
                    </button>
                    <button
                      className="fs__morebtn"
                      onClick={() => void bridge.toggleFullscreen()}
                    >
                      {nativeFs ? (
                        <CornersIn size={13} />
                      ) : (
                        <ArrowsOut size={13} />
                      )}{" "}
                      {t("nav.fullscreen")}
                    </button>
                    <span className="fs__moresep" />
                    <span className="fs__stylehead">{t("fs.size")}</span>
                    <span className="fs__sizerow">
                      <input
                        type="range"
                        min={60}
                        max={160}
                        step={5}
                        className="fs__sizeslider"
                        value={coverScale}
                        disabled={scaleLock}
                        aria-label={t("fs.size")}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setCoverScale(v);
                          localStorage.setItem("noctbeat.fscss", String(v));
                        }}
                      />
                      <button
                        className={`fs__icon fs__sizelock ${scaleLock ? "fs__icon--on" : ""}`}
                        aria-label={
                          scaleLock ? t("fs.unlockSize") : t("fs.lockSize")
                        }
                        title={
                          scaleLock ? t("fs.unlockSize") : t("fs.lockSize")
                        }
                        onClick={() => {
                          setScaleLock((v) => {
                            localStorage.setItem(
                              "noctbeat.fslock",
                              v ? "0" : "1",
                            );
                            return !v;
                          });
                        }}
                      >
                        {scaleLock ? (
                          <LockSimple size={13} />
                        ) : (
                          <LockSimpleOpen size={13} />
                        )}
                      </button>
                    </span>
                    <span className="fs__sizerow">
                      <input
                        type="range"
                        min={60}
                        max={160}
                        step={5}
                        className="fs__sizeslider"
                        value={clockScale}
                        disabled={scaleLock}
                        aria-label={t("fs.clockSize")}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setClockScale(v);
                          localStorage.setItem("noctbeat.fsclocksc", String(v));
                        }}
                      />
                    </span>
                    <span className="fs__sizerow">
                      <input
                        type="range"
                        min={60}
                        max={160}
                        step={5}
                        className="fs__sizeslider"
                        value={lyricScale}
                        disabled={scaleLock}
                        aria-label={t("fs.lyricSize")}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setLyricScale(v);
                          localStorage.setItem("noctbeat.fslyrsc", String(v));
                        }}
                      />
                    </span>
                    <span className="fs__moresep" />
                    <span className="fs__stylehead">{t("fs.soundFx")}</span>
                    {(
                      [
                        ["Off", "off"],
                        ["Reverb", "reverb"],
                        ["8D Audio", "8d"],
                        ["Echo", "echo"],
                      ] as Array<[string, string]>
                    ).map(([label, m]) => (
                      <button
                        key={m}
                        className={`fs__morebtn ${settings.soundFx === m ? "fs__morebtn--on" : ""}`}
                        onClick={() => void bridge.setFx(m)}
                      >
                        {label}
                      </button>
                    ))}
                  </span>
                )}
              </span>
            </span>
          </div>
        </div>
      </div>
      <StickerLayer />
      {share && (
        <ShareCard
          track={track}
          artUrl={art}
          posMs={pos}
          onClose={() => setShare(false)}
        />
      )}
    </div>
  );
}
