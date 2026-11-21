import { useEffect, useState } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
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
    </>
  );
}

/** Ctrl+K palette lives in the player window only — never on the
 * click-through edge glow or the floating HUD/overlay surfaces. */
function PaletteGate() {
  const loc = useLocation();
  if (["/edge", "/hud", "/desklyrics"].includes(loc.pathname)) return null;
  return <Palette />;
}

/** Dropping audio files or a folder anywhere on a player surface
 * enqueues them (deduped). Surfaces a short confirmation toast. */
function DropGate() {
  const t = useT();
  const loc = useLocation();
  const [note, setNote] = useState("");
  useEffect(() => {
    if (["/edge", "/hud", "/desklyrics"].includes(loc.pathname)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onFileDrop((paths) => {
      void bridge.enqueueFiles(paths).then((n) => {
        setNote(n > 0 ? t(n === 1 ? "app.trackAdded" : "app.tracksAdded", { n }) : t("app.noAudioDrop"));
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
