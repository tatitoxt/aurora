import { useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import Player from "./pages/Player";
import Edge from "./pages/Edge";
import Settings from "./pages/Settings";
import Hud from "./pages/Hud";
import DeskLyrics from "./pages/DeskLyrics";
import Library from "./pages/Library";
import Palette from "./Palette";
import { bridge, subscribe, type Settings as AppSettings } from "./bridge";
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
      </Routes>
      <PaletteGate />
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
