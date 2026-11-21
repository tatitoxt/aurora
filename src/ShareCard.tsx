import { useEffect, useRef, useState } from "react";
import { Copy, DownloadSimple, X } from "@phosphor-icons/react";
import { cardModel } from "./share";
import { branding } from "./branding";
import type { Track } from "./bridge";

export const SHARE_EVENT = "noctbeat:share";
export function openShare() {
  window.dispatchEvent(new CustomEvent(SHARE_EVENT));
}

const W = 1200;
const H = 630;

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Paints the 1200x630 share image. `art` may be null — a gradient tile
 * stands in so the card never ships an empty square. */
export function paintCard(
  ctx: CanvasRenderingContext2D,
  m: ReturnType<typeof cardModel>,
  art: CanvasImageSource | null,
  accents: { a1: string; a2: string },
) {
  // Backdrop: deep navy with accent glows, mirroring the app's glass.
  ctx.fillStyle = "#0b0b16";
  ctx.fillRect(0, 0, W, H);
  const glow = (x: number, y: number, r: number, c: string) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, c);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };
  glow(120, 60, 560, accents.a1 + "55");
  glow(W - 80, H - 40, 620, accents.a2 + "44");

  // Art tile (or accent gradient stand-in).
  const AX = 72,
    AY = (H - 380) / 2,
    AS = 380;
  ctx.save();
  rr(ctx, AX, AY, AS, AS, 28);
  ctx.clip();
  if (art) {
    ctx.drawImage(art, AX, AY, AS, AS);
  } else {
    const g = ctx.createLinearGradient(AX, AY, AX + AS, AY + AS);
    g.addColorStop(0, accents.a1);
    g.addColorStop(1, accents.a2);
    ctx.fillStyle = g;
    ctx.fillRect(AX, AY, AS, AS);
  }
  ctx.restore();
  rr(ctx, AX, AY, AS, AS, 28);
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Text column.
  const TX = AX + AS + 64;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#f4f4fa";
  ctx.font = "600 58px system-ui, -apple-system, sans-serif";
  ctx.fillText(m.title, TX, 210, W - TX - 72);
  ctx.fillStyle = "rgba(244,244,250,0.62)";
  ctx.font = "400 34px system-ui, -apple-system, sans-serif";
  ctx.fillText(m.subtitle, TX, 268, W - TX - 72);

  // Progress bar.
  const BY = 390,
    BW = W - TX - 72;
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  rr(ctx, TX, BY, BW, 10, 5);
  ctx.fill();
  if (m.progress > 0) {
    const g = ctx.createLinearGradient(TX, 0, TX + BW, 0);
    g.addColorStop(0, accents.a1);
    g.addColorStop(1, accents.a2);
    ctx.fillStyle = g;
    rr(ctx, TX, BY, Math.max(10, BW * m.progress), 10, 5);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(244,244,250,0.55)";
  ctx.font = "400 26px ui-monospace, monospace";
  ctx.fillText(m.elapsed, TX, BY + 52);
  ctx.textAlign = "right";
  ctx.fillText(m.total, TX + BW, BY + 52);
  ctx.textAlign = "left";

  // Wordmark.
  ctx.fillStyle = "rgba(244,244,250,0.4)";
  ctx.font = "300 26px system-ui, -apple-system, sans-serif";
  ctx.fillText(branding.productName, TX, H - 64);
  const eg = ctx.createLinearGradient(TX, 0, W - 72, 0);
  eg.addColorStop(0, accents.a1);
  eg.addColorStop(1, accents.a2);
  ctx.fillStyle = eg;
  rr(ctx, W - 200, H - 84, 128, 20, 10);
  ctx.fill();
}

function readAccents(): { a1: string; a2: string } {
  const cs = getComputedStyle(document.documentElement);
  return {
    a1: cs.getPropertyValue("--accent").trim() || "#8b5cf6",
    a2: cs.getPropertyValue("--accent2").trim() || "#22d3ee",
  };
}

/** Modal that renders the current track as a shareable image. */
export default function ShareCard({
  track,
  artUrl,
  posMs,
  onClose,
}: {
  track: Track | null;
  artUrl: string;
  posMs: number;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    setReady(false);
    const paint = (art: CanvasImageSource | null) => {
      const ctx = canvasRef.current?.getContext("2d");
      if (ctx) paintCard(ctx, cardModel(track, posMs), art, readAccents());
      setReady(true);
    };
    if (!artUrl) {
      paint(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => paint(img);
    img.onerror = () => paint(null);
    img.src = artUrl;
  }, [track, artUrl, posMs]);

  const toBlob = () =>
    new Promise<Blob | null>((res) => canvasRef.current?.toBlob(res, "image/png"));

  const copy = async () => {
    try {
      // Hand the ClipboardItem a promise so the write happens inside the
      // click gesture — awaiting toBlob first drops it on strict WebKit.
      const pending = toBlob().then((b) => {
        if (!b) throw new Error("empty");
        return b;
      });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": pending })]);
      setNote("Copied");
    } catch {
      setNote("Copy unavailable — use download");
    }
  };

  const download = async () => {
    const blob = await toBlob();
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${branding.shortName}-now-playing.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="share" onMouseDown={(e) => e.stopPropagation()}>
        <div className="share__head">
          <span>Share</span>
          <button className="ctl" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <canvas ref={canvasRef} width={W} height={H} />
        <div className="share__row">
          <button onClick={copy} disabled={!ready}>
            <Copy size={13} /> Copy image
          </button>
          <button onClick={download} disabled={!ready}>
            <DownloadSimple size={13} /> Download PNG
          </button>
          {note && <span className="share__note">{note}</span>}
        </div>
      </div>
    </div>
  );
}
