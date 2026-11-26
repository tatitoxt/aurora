import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import Palette from "./Palette";
import {
  bridge,
  onFileDrop,
  subscribe,
  type NowPlaying,
  type Settings as AppSettings,
} from "./bridge";
import { favEntryFor, loadFavs, toggleFav } from "./favs";
import { useT } from "./i18n";
import { applyDynAccent, applyGlassOpacity, applyTheme } from "./themes";
import { useRadioAutoplay } from "./autoplay";

// Each window (Stage, HUD, desk lyrics) loads only its own page chunk.
const Stage = lazy(() => import("./pages/Stage"));
const Settings = lazy(() => import("./pages/Settings"));
const Hud = lazy(() => import("./pages/Hud"));
const DeskLyrics = lazy(() => import("./pages/DeskLyrics"));
const Library = lazy(() => import("./pages/Library"));
const Browse = lazy(() => import("./pages/Browse"));
const Artist = lazy(() => import("./pages/Artist"));
const Albums = lazy(() => import("./pages/Albums"));
const Album = lazy(() => import("./pages/Album"));
const Stats = lazy(() => import("./pages/Stats"));
const Wrapped = lazy(() => import("./pages/Wrapped"));
const Visualizer = lazy(() => import("./pages/Visualizer"));

export default function App() {
  const loc = useLocation();
  /* Radio is playback state, not a Browse-page concern: it keeps working
     when the user switches back to Live View, but overlay webviews do not
     each get their own copy of the listener. */
  useRadioAutoplay(!["/hud", "/desklyrics"].includes(loc.pathname));
  // Every icon button explains itself on hover: mirror aria-label into title.
  useEffect(() => {
    const label = (b: HTMLElement) => {
      const l = b.getAttribute("aria-label");
      if (!l || (b.title && !b.dataset.autotitle)) return;
      if (b.title !== l) b.title = l;
      b.dataset.autotitle = "1";
    };
    const scan = (root: ParentNode) =>
      root.querySelectorAll<HTMLElement>("button[aria-label]").forEach(label);
    scan(document);
    // Only touch nodes that changed: a full rescan on every lyric/progress
    // mutation was a measurable main-thread cost.
    const mo = new MutationObserver((recs) => {
      for (const r of recs) {
        if (r.type === "attributes") {
          if (r.target instanceof HTMLButtonElement) label(r.target);
          continue;
        }
        r.addedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement)) return;
          if (n instanceof HTMLButtonElement) label(n);
          scan(n);
        });
      }
    });
    mo.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-label"],
    });
    return () => mo.disconnect();
  }, []);
  // OS accent (macOS Appearance / Windows personalization) tints active controls.
  useEffect(() => {
    void bridge
      .systemAccent()
      .then(
        (c) =>
          c && document.documentElement.style.setProperty("--sys-accent", c),
      )
      .catch(() => {});
  }, []);
  useEffect(() => {
    let theme: AppSettings["theme"] | null = null;
    let art: string | undefined;
    let pal: { a: string; b: string | null } | null = null;
    /* Dynamic accent: after every theme (re)apply, overlay the artwork
       palette of whatever is playing. The palette is cached per artwork —
       a settings event (e.g. an EQ slider) must not re-download the art. */
    const dyn = () => {
      if (!theme?.dynamic || !art || (theme.accent && theme.accent2)) return;
      if (pal) {
        applyDynAccent(theme, pal.a, pal.b);
        return;
      }
      const url = art;
      void bridge
        .getPalette(url)
        .then((p) => {
          if (art !== url) return;
          pal = { a: p.accents[0] ?? p.dominant, b: p.accents[1] ?? null };
          if (theme?.dynamic) applyDynAccent(theme, pal.a, pal.b);
        })
        .catch(() => {});
    };
    const onTheme = (t: AppSettings["theme"]) => {
      theme = t;
      applyTheme(t);
      dyn();
    };
    void bridge.getSettings().then((s) => {
      onTheme(s.theme);
      applyGlassOpacity(s.glassOpacity);
    });
    const offS = subscribe<AppSettings>("settings", (s) => {
      onTheme(s.theme);
      applyGlassOpacity(s.glassOpacity);
    });
    void bridge.getNowPlaying().then((np) => {
      art = np?.track?.artworkUrl;
      dyn();
    });
    const offN = subscribe<NowPlaying>("now-playing", (np) => {
      const next = np?.track?.artworkUrl ?? undefined;
      if (next === art) return;
      art = next;
      pal = null;
      dyn();
    });
    return () => {
      offS();
      offN();
    };
  }, []);
  return (
    <>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Stage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/hud" element={<Hud />} />
          <Route path="/desklyrics" element={<DeskLyrics />} />
          <Route path="/library" element={<Library />} />
          <Route path="/browse" element={<Browse />} />
          <Route path="/artist/:name" element={<Artist />} />
          <Route path="/albums" element={<Albums />} />
          <Route path="/album/:artist/:name" element={<Album />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/wrapped" element={<Wrapped />} />
          <Route path="/visualizer" element={<Visualizer />} />
          <Route path="/fullscreen" element={<Stage />} />
        </Routes>
      </Suspense>
      <PaletteGate />
      <DropGate />
      <ShortcutsGate />
      <FsSync />
      <UpdateGate />
    </>
  );
}

/** Silent auto-update: check once on launch in the player window,
 * download+install in the background, relaunch when done. Offline,
 * dev builds and unsigned builds just ignore the failure. */
function UpdateGate() {
  const loc = useLocation();
  useEffect(() => {
    if (loc.pathname !== "/") return;
    if (!("__TAURI_INTERNALS__" in window)) return;
    let cancelled = false;
    void (async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const { relaunch } = await import("@tauri-apps/plugin-process");
        const update = await check();
        if (update && !cancelled) {
          await update.downloadAndInstall();
          if (!cancelled) await relaunch();
        }
      } catch {
        // no release endpoint yet, offline, or dev build
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loc.pathname]);
  return null;
}

/** Ctrl+K palette lives in the player window only — never on the
 * floating HUD/overlay surfaces. */
function PaletteGate() {
  const loc = useLocation();
  if (["/hud", "/desklyrics"].includes(loc.pathname)) return null;
  return <Palette />;
}

/** Keep the route glued to the real window fullscreen state: any exit
 * (Esc, macOS green button, our own toggle) pops back to the player.
 * Only the player home is swapped — a page like Library open in another
 * route is left alone so fullscreen never hijacks navigation. */
function FsSync() {
  const nav = useNavigate();
  const loc = useLocation();
  const locRef = useRef(loc.pathname);
  locRef.current = loc.pathname;
  useEffect(() => {
    if (["/hud", "/desklyrics"].includes(loc.pathname)) return;
    return subscribe<boolean>("fullscreen", (on) => {
      if (on) {
        if (locRef.current === "/") nav("/fullscreen");
      } else if (locRef.current === "/fullscreen") nav("/");
    });
  }, [loc.pathname, nav]);
  return null;
}

/** App-wide shortcuts on the player surfaces: Space play/pause, arrows
 * seek/volume (Shift+arrows skip), S shuffle, R repeat, L like, F the
 * fullscreen view. Overlay windows and the fullscreen page keep their own
 * handlers — this mounts nowhere near them. */
function ShortcutsGate() {
  const loc = useLocation();
  const nav = useNavigate();
  const navRef = useRef(nav);
  navRef.current = nav;
  useEffect(() => {
    // The stage ("/" and "/fullscreen") owns its own key handler.
    if (["/", "/hud", "/desklyrics", "/fullscreen"].includes(loc.pathname))
      return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t?.closest(".palette") ||
        t?.closest("input, textarea, select, [contenteditable]")
      )
        return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const b = bridge;
      if (e.key === " ") {
        if (t?.closest("button, [role='button'], a")) return;
        e.preventDefault();
        void b.mediaControl("play-pause");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (e.shiftKey) void b.mediaControl("next");
        else
          void b.getNowPlaying().then((np) => b.seek(np.positionMs + 10_000));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (e.shiftKey) void b.mediaControl("previous");
        else
          void b
            .getNowPlaying()
            .then((np) => b.seek(Math.max(0, np.positionMs - 10_000)));
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const d = e.key === "ArrowUp" ? 0.05 : -0.05;
        void b
          .getVolume()
          .then((v) => b.setVolume(Math.min(1, Math.max(0, v + d))));
      } else if (e.key === "s" || e.key === "S") {
        void b.getShuffle().then((on) => b.setShuffle(!on));
      } else if (e.key === "r" || e.key === "R") {
        void b
          .getRepeat()
          .then((m) =>
            b.setRepeat(m === "off" ? "all" : m === "all" ? "one" : "off"),
          );
      } else if (e.key === "l" || e.key === "L") {
        void b.getNowPlaying().then((np) => {
          const entry = favEntryFor(np);
          if (entry) toggleFav(loadFavs(), entry);
        });
      } else if (e.key === "f" || e.key === "F") {
        void b.toggleFullscreen().then((on) => {
          if (on) navRef.current("/fullscreen");
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loc.pathname]);
  return null;
}

/** Dropping audio files or a folder anywhere on a player surface
 * enqueues them (deduped). Surfaces a short confirmation toast. */
function DropGate() {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const loc = useLocation();
  const [note, setNote] = useState("");
  useEffect(() => {
    if (["/hud", "/desklyrics"].includes(loc.pathname)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onFileDrop((paths) => {
      void bridge.enqueueFiles(paths).then((n) => {
        const tt = tRef.current;
        setNote(
          n > 0
            ? tt(n === 1 ? "app.trackAdded" : "app.tracksAdded", { n })
            : tt("app.noAudioDrop"),
        );
        clearTimeout(timer);
        timer = setTimeout(() => setNote(""), 2600);
      });
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [loc.pathname]);
  if (!note) return null;
  return <div className="dropnote">{note}</div>;
}
