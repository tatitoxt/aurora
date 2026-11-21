import { useEffect, useRef, useState } from "react";
import { bridge, subscribe, DEFAULT_SETTINGS, type EnergyUpdate, type NowPlaying, type Settings } from "../bridge";
import { beatPulse } from "../lib";
import { cssVar } from "../themes";

const DEFAULTS: Settings = DEFAULT_SETTINGS;

export default function Edge() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [palette, setPalette] = useState<{ dominant: string; accents: string[] } | null>(null);
  const [npStatus, setNpStatus] = useState<NowPlaying["status"]>("stopped");
  const [onBattery, setOnBattery] = useState(false);
  const [fsActive, setFsActive] = useState(false);
  const [pulse, setPulse] = useState(0);
  const lastBeat = useRef(0);
  const lastArtwork = useRef("");
  const lastPaletteFail = useRef(0);
  const raf = useRef(0);
  const [, force] = useState(0);

  useEffect(() => {
    bridge.getSettings().then(setSettings);
    const offNp = subscribe<NowPlaying>("now-playing", (np) => {
      setNpStatus(np.status);
      const art = np.track?.artworkUrl ?? "";
      const retryOk = Date.now() - lastPaletteFail.current > 30_000;
      if (art && retryOk && art !== lastArtwork.current) {
        lastArtwork.current = art;
        bridge
          .getPalette(art)
          .then(setPalette)
          .catch(() => {
            lastArtwork.current = "";
            lastPaletteFail.current = Date.now();
          });
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

  // Battery status: dim the glow while discharging (auto-dim setting).
  useEffect(() => {
    interface BatteryLike {
      charging: boolean;
      onchargingchange: unknown;
      onlevelchange: unknown;
    }
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
    if (nav.getBattery) {
      let bat: BatteryLike | null = null;
      const upd = () => bat && setOnBattery(!bat.charging);
      nav
        .getBattery()
        .then((b) => {
          bat = b;
          upd();
          b.onchargingchange = upd;
          b.onlevelchange = upd;
        })
        .catch(() => {});
      return () => {
        if (bat) {
          bat.onchargingchange = null;
          bat.onlevelchange = null;
        }
      };
    }
    // Desktop webviews (WebKit/WKWebView) lack getBattery — the shell
    // reads the OS power state instead.
    const poll = () => bridge.getOnBattery().then(setOnBattery).catch(() => {});
    poll();
    const timer = window.setInterval(poll, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // Foreign fullscreen app: hide the glow while e.g. a video player owns the
  // screen. Polled at 5s; skipped entirely when the setting is off.
  useEffect(() => {
    if (!settings.hideInFullscreen) {
      setFsActive(false);
      return;
    }
    const poll = () => bridge.getFullscreenAppActive().then(setFsActive).catch(() => {});
    poll();
    const timer = window.setInterval(poll, 5_000);
    return () => window.clearInterval(timer);
  }, [settings.hideInFullscreen]);

  const silent = settings.lightsOffOnSilence && npStatus !== "playing";
  const suppressed = silent || fsActive;

  useEffect(() => {
    if (settings.batterySaver || suppressed) return;
    const loop = () => {
      setPulse(beatPulse(lastBeat.current, Date.now()));
      force((n) => n + 1);
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [settings.batterySaver, suppressed]);

  const useArtwork = settings.colorMode.mode === "artwork";
  // Before artwork extraction lands (or with no artwork), the glow follows
  // the active theme's accents instead of the hard-coded defaults.
  const themeC1 = cssVar("--accent") || "#8b5cf6";
  const themeC2 = cssVar("--accent2") || themeC1;
  const c1 = useArtwork ? (palette?.dominant ?? themeC1) : settings.customColor;
  const c2 = useArtwork
    ? (palette?.accents[0] ?? palette?.dominant ?? themeC2)
    : settings.customColor;
  const t = settings.edgeThicknessPx;
  const dim = settings.batterySaver || (onBattery && settings.autoDimOnBattery) ? 0.55 : 1;
  const base = settings.brightness * dim;
  const opacity = suppressed ? 0 : Math.min(1, base * (0.55 + pulse * 0.45));

  const style = {
    "--t": `${t}px`,
    "--c1": c1,
    "--c2": c2,
    "--o": settings.batterySaver && !suppressed ? base : opacity,
  } as React.CSSProperties;

  return (
    <div className="edge" data-testid="edge" style={style}>
      <div className="edge__glow" />
      <div className={`edge__pulse ${pulse > 0.3 && !suppressed ? "on" : ""}`} style={{ "--t": `${t}px`, "--c2": c2 } as React.CSSProperties} />
    </div>
  );
}
