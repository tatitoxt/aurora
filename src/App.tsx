import { Route, Routes } from "react-router-dom";
import Player from "./pages/Player";
import Edge from "./pages/Edge";
import Settings from "./pages/Settings";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Player />} />
      <Route path="/edge" element={<Edge />} />
      <Route path="/settings" element={<Settings />} />
    </Routes>
  );
}
