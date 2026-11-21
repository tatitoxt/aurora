import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { bridge, subscribe, type EnergyUpdate, type NowPlaying } from "../bridge";

const BANDS = 16;

/** Full-window spectrum visualizer: 16 real frequency bands from the audio
 * tap (or the demo pulse), smoothed in the detector and drawn every frame
 * with a beat flash behind the track metadata. */
export default function Visualizer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const energy = useRef<EnergyUpdate>({ level: 0, beat: false, bands: new Array(BANDS).fill(0) });
  const flash = useRef(0);
  const [np, setNp] = useState<NowPlaying | null>(null);

  useEffect(() => {
    const offE = subscribe<EnergyUpdate>("energy", (e) => {
      energy.current = e;
      if (e.beat) flash.current = 1;
    });
    const offN = subscribe<NowPlaying>("now-playing", setNp);
    void bridge.getNowPlaying().then(setNp).catch(() => {});
    return () => {
      offE();
      offN();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      const { width: w, height: h } = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const vars = getComputedStyle(canvas);
      const accent = vars.getPropertyValue("--accent").trim() || "#8b5cf6";
      const accent2 = vars.getPropertyValue("--accent2").trim() || "#22d3ee";

      // Beat flash: a soft radial glow that decays each frame.
      flash.current *= 0.9;
      if (flash.current > 0.01) {
        const g = ctx.createRadialGradient(w / 2, h, 0, w / 2, h, Math.max(w, h) * 0.7);
        g.addColorStop(0, accent);
        g.addColorStop(1, "transparent");
        ctx.save();
        ctx.globalAlpha = flash.current * 0.25;
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }

      const bands = energy.current.bands?.length ? energy.current.bands : new Array(BANDS).fill(0);
      const gap = 8;
      const bw = (w - gap * (BANDS + 1)) / BANDS;
      const maxH = h * 0.62;
      const grad = ctx.createLinearGradient(0, h, 0, h - maxH);
      grad.addColorStop(0, accent);
      grad.addColorStop(1, accent2);
      ctx.fillStyle = grad;
      for (let i = 0; i < BANDS; i++) {
        const bh = Math.max(4, (bands[i] ?? 0) * maxH);
        const x = gap + i * (bw + gap);
        const y = h - bh;
        const r = Math.min(bw / 2, 6, bh / 2);
        ctx.beginPath();
        ctx.roundRect(x, y, bw, bh, r);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="viz">
      <canvas ref={canvasRef} className="viz__canvas" />
      <div className="viz__meta glass">
        <div className="viz__title">{np?.track?.title ?? "Nothing playing"}</div>
        <div className="viz__artist">{np?.track?.artist ?? "—"}</div>
        <Link to="/" className="wordmark" style={{ textDecoration: "none" }}>
          Back to player
        </Link>
      </div>
    </div>
  );
}
