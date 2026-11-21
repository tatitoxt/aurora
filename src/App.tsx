import { useEffect, useRef, useState } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import Player from "./pages/Player";
import Edge from "./pages/Edge";
import Settings from "./pages/Settings";
import Hud from "./pages/Hud";
import DeskLyrics from "./pages/DeskLyrics";
import Library from "./pages/Library";
import Artist from "./pages/Artist";
import Albums from "./pages/Albums";
import Album from "./pages/Album";
import Stats from "./pages/Stats";
import Wrapped from "./pages/Wrapped";
import Visualizer from "./pages/Visualizer";
import Fullscreen from "./pages/Fullscreen";
import Palette from "./Palette";
import { bridge, onFileDrop, subscribe, type Settings as AppSettings } from "./bridge";
import { favEntryFor, loadFavs, toggleFav } from "./favs";
import { useT } from "./i18n";
import { applyTheme } from "./themes";

export default function App() {
  useEffect(() => {
    void bridge.getSettings().then((s) => applyTheme(s.theme));
    return subscribe<AppSettings>("settings", (s) => applyTheme(s.theme));
  }, []);
  return (
    <>
      <Routes>
        <Route path="/" element={<Player />} />
        <Route path="/edge" element={<Edge />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/hud" element={<Hud />} />
        <Route path="/desklyrics" element={<DeskLyrics />} />
        <Route path="/library" element={<Library />} />
        <Route path="/artist/:name" element={<Artist />} />
        <Route path="/albums" element={<Albums />} />
        <Route path="/album/:artist/:name" element={<Album />} />
        <Route path="/stats" element={<Stats />} />
        <Route path="/wrapped" element={<Wrapped />} />
        <Route path="/visualizer" element={<Visualizer />} />
        <Route path="/fullscreen" element={<Fullscreen />} />
      </Routes>
      <PaletteGate />
      <DropGate />
      <ShortcutsGate />
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
 * click-through edge glow or the floating HUD/overlay surfaces. */
function PaletteGate() {
  const loc = useLocation();
  if (["/edge", "/hud", "/desklyrics"].includes(loc.pathname)) return null;
  return <Palette />;
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
    if (["/edge", "/hud", "/desklyrics", "/fullscreen"].includes(loc.pathname))
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
        else void b.getNowPlaying().then((np) => b.seek(np.positionMs + 10_000));
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
        void b.getVolume().then((v) => b.setVolume(Math.min(1, Math.max(0, v + d))));
      } else if (e.key === "s" || e.key === "S") {
        void b.getShuffle().then((on) => b.setShuffle(!on));
      } else if (e.key === "r" || e.key === "R") {
        void b.getRepeat().then((m) =>
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
    if (["/edge", "/hud", "/desklyrics"].includes(loc.pathname)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onFileDrop((paths) => {
      void bridge.enqueueFiles(paths).then((n) => {
        const tt = tRef.current;
        setNote(n > 0 ? tt(n === 1 ? "app.trackAdded" : "app.tracksAdded", { n }) : tt("app.noAudioDrop"));
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
