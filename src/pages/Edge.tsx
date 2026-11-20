import { useEffect, useRef, useState } from "react";
import { bridge, subscribe, type EnergyUpdate, type NowPlaying, type Settings } from "../bridge";
import { beatPulse } from "../lib";

const DEFAULTS: Settings = {
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
};

export default function Edge() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [palette, setPalette] = useState<{ dominant: string; accents: string[] }>({
    dominant: "#8b5cf6",
    accents: ["#22d3ee"],
  });
  const [pulse, setPulse] = useState(0);
  const lastBeat = useRef(0);
  const lastArtwork = useRef("");
  const raf = useRef(0);
  const [, force] = useState(0);

  useEffect(() => {
    bridge.getSettings().then(setSettings);
    const offNp = subscribe<NowPlaying>("now-playing", (np) => {
      const art = np.track?.artworkUrl ?? "";
      if (art && art !== lastArtwork.current) {
        lastArtwork.current = art;
        bridge.getPalette(art).then(setPalette).catch(() => {});
      }
    });
    const offEnergy = subscribe<EnergyUpdate>("energy", (e) => {
      if (e.beat) lastBeat.current = Date.now();
    });
    const offSettings = subscribe<Settings>("settings", setSettings);
    return () => {
      offNp();
      offEnergy();
      offSettings();
    };
  }, []);

  useEffect(() => {
    if (settings.batterySaver) return;
    const loop = () => {
      setPulse(beatPulse(lastBeat.current, Date.now()));
      force((n) => n + 1);
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [settings.batterySaver]);

  const useArtwork = settings.colorMode.mode === "artwork";
  const c1 = useArtwork ? palette.dominant : settings.customColor;
  const c2 = useArtwork ? palette.accents[0] ?? c1 : settings.customColor;
  const t = settings.edgeThicknessPx;
  const opacity = Math.min(1, settings.brightness * (0.55 + pulse * 0.45));

  const style = {
    "--t": `${t}px`,
    "--c1": c1,
    "--c2": c2,
    "--o": settings.batterySaver ? settings.brightness * 0.6 : opacity,
  } as React.CSSProperties;

  return (
    <div className="edge" data-testid="edge" style={style}>
      <div className="edge__glow" />
      <div className={`edge__pulse ${pulse > 0.3 ? "on" : ""}`} style={{ "--t": `${t}px`, "--c2": c2 } as React.CSSProperties} />
    </div>
  );
}
