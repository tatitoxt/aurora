import { useEffect } from "react";
import { Route, Routes } from "react-router-dom";
import Player from "./pages/Player";
import Edge from "./pages/Edge";
import Settings from "./pages/Settings";
import Hud from "./pages/Hud";
import Library from "./pages/Library";
import { bridge, subscribe, type Settings as AppSettings } from "./bridge";
import { applyTheme } from "./themes";

export default function App() {
  useEffect(() => {
    void bridge.getSettings().then((s) => applyTheme(s.theme));
    return subscribe<AppSettings>("settings", (s) => applyTheme(s.theme));
  }, []);
  return (
    <Routes>
      <Route path="/" element={<Player />} />
      <Route path="/edge" element={<Edge />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/hud" element={<Hud />} />
      <Route path="/library" element={<Library />} />
    </Routes>
  );
}
