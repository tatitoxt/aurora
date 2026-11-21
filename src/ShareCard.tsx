import { useT } from "./i18n";
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
  // Backdrop: the artwork, darkened — iBaila-moody, no neon.
  ctx.fillStyle = "#07070c";
  ctx.fillRect(0, 0, W, H);
  if (art) {
    const iw = (art as HTMLImageElement).width || 1;
    const ih = (art as HTMLImageElement).height || 1;
    const scale = Math.max(W / iw, H / ih) * 1.1;
    const dw = iw * scale,
      dh = ih * scale;
    ctx.save();
    ctx.filter = "blur(48px) brightness(0.5) saturate(1.15)";
    ctx.drawImage(art, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    ctx.fillStyle = "rgba(5,5,9,0.45)";
    ctx.fillRect(0, 0, W, H);
    // Bottom vignette so the wordmark/progress never fight busy art.
    const v = ctx.createLinearGradient(0, H * 0.55, 0, H);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.5)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  } else {
    const g = ctx.createRadialGradient(W / 2, H * 0.4, 0, W / 2, H * 0.4, W * 0.7);
    g.addColorStop(0, accents.a1 + "22");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // Art tile (or neutral tile stand-in — no gradient slop).
  const AX = 72,
    AY = (H - 380) / 2,
    AS = 380;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 60;
  ctx.shadowOffsetY = 24;
  rr(ctx, AX, AY, AS, AS, 28);
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.restore();
  ctx.save();
  rr(ctx, AX, AY, AS, AS, 28);
  ctx.clip();
  if (art) {
    ctx.drawImage(art, AX, AY, AS, AS);
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(AX, AY, AS, AS);
    ctx.fillStyle = "rgba(255,255,255,0.32)";
    ctx.font = "600 130px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("♪", AX + AS / 2, AY + AS / 2 + 45);
    ctx.textAlign = "left";
  }
  ctx.restore();
  rr(ctx, AX, AY, AS, AS, 28);
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Text column: small caps kicker, big title, dim subtitle.
  const TX = AX + AS + 64;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(244,244,250,0.5)";
  ctx.font = "600 22px system-ui, -apple-system, sans-serif";
  ctx.fillText("NOW PLAYING", TX, 158);
  ctx.fillStyle = "#f4f4fa";
  ctx.font = "700 62px system-ui, -apple-system, sans-serif";
  ctx.fillText(m.title, TX, 230, W - TX - 72);
  ctx.fillStyle = "rgba(244,244,250,0.62)";
  ctx.font = "400 34px system-ui, -apple-system, sans-serif";
  ctx.fillText(m.subtitle, TX, 286, W - TX - 72);

  // Progress bar: thin white track + knob, iBaila-style restraint.
  const BY = 390,
    BW = W - TX - 72;
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  rr(ctx, TX, BY, BW, 8, 4);
  ctx.fill();
  if (m.progress > 0) {
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    const fw = Math.max(8, BW * m.progress);
    rr(ctx, TX, BY, fw, 8, 4);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(TX + fw, BY + 4, 11, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
  }
  ctx.fillStyle = "rgba(244,244,250,0.55)";
  ctx.font = "400 26px ui-monospace, monospace";
  ctx.fillText(m.elapsed, TX, BY + 52);
  ctx.textAlign = "right";
  ctx.fillText(m.total, TX + BW, BY + 52);
  ctx.textAlign = "left";

  // Wordmark: quiet, single accent dot — no gradient bar.
  ctx.fillStyle = "rgba(244,244,250,0.4)";
  ctx.font = "300 26px system-ui, -apple-system, sans-serif";
  ctx.fillText(branding.productName, TX, H - 64);
  ctx.beginPath();
  ctx.arc(TX + ctx.measureText(branding.productName).width + 22, H - 73, 7, 0, Math.PI * 2);
  ctx.fillStyle = accents.a1;
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
  const t = useT();
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
      setNote(t("share.copied"));
    } catch {
      setNote(t("share.copyUnavailable"));
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
          <span>{t("share.title")}</span>
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
