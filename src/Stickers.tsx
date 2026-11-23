import { useEffect, useRef, useState } from "react";
import { useT } from "./i18n";
import {
  AirplaneTilt,
  Butterfly,
  Flower,
  Guitar,
  Heart,
  Lightning,
  Moon,
  MusicNote,
  Planet,
  Smiley,
  Sparkle,
  Star,
  VinylRecord,
} from "@phosphor-icons/react";
import {
  addSticker,
  loadStickers,
  moveSticker,
  removeSticker,
  subscribeStickers,
  type Sticker,
} from "./stickerStore";

const GLYPHS: Record<string, React.ReactNode> = {
  star: <Star weight="fill" />,
  heart: <Heart weight="fill" />,
  sparkle: <Sparkle weight="fill" />,
  moon: <Moon weight="fill" />,
  note: <MusicNote weight="fill" />,
  vinyl: <VinylRecord weight="fill" />,
  lightning: <Lightning weight="fill" />,
  flower: <Flower weight="fill" />,
  butterfly: <Butterfly weight="fill" />,
  planet: <Planet weight="fill" />,
  guitar: <Guitar weight="fill" />,
  smiley: <Smiley weight="fill" />,
  plane: <AirplaneTilt weight="fill" />,
};

/** The absolute layer of placed stickers inside the player card. Drag to
 * move, right-click to remove. Positions are fractions of the card. */
export function StickerLayer() {
  const t = useT();
  const [list, setList] = useState<Sticker[]>(loadStickers);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => subscribeStickers(() => setList(loadStickers())), []);
  if (list.length === 0) return null;

  const startDrag = (e: React.PointerEvent, s: Sticker) => {
    e.preventDefault();
    e.stopPropagation();
    const box = host.current?.getBoundingClientRect();
    if (!box) return;
    // Keep the grab offset so the sticker doesn't jump to the pointer.
    const grabX = (e.clientX - box.left) / box.width - s.x;
    const grabY = (e.clientY - box.top) / box.height - s.y;
    const move = (ev: PointerEvent) => {
      setList(
        moveSticker(
          s.id,
          (ev.clientX - box.left) / box.width - grabX,
          (ev.clientY - box.top) / box.height - grabY,
        ),
      );
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  return (
    <div ref={host} className="stickers">
      {list.map((s) => (
        <span
          key={s.id}
          className="sticker"
          role="button"
          tabIndex={0}
          aria-label={t("stk.hint")}
          style={{
            left: `${s.x * 100}%`,
            top: `${s.y * 100}%`,
            transform: `translate(-50%, -50%) scale(${s.s})`,
          }}
          onPointerDown={(e) => startDrag(e, s)}
          onContextMenu={(e) => {
            e.preventDefault();
            setList(removeSticker(s.id));
          }}
          onKeyDown={(e) => {
            if (e.key === "Delete" || e.key === "Backspace") setList(removeSticker(s.id));
          }}
        >
          {GLYPHS[s.glyph] ?? GLYPHS.star}
        </span>
      ))}
    </div>
  );
}

/** Picker popover: click a glyph to stamp it onto the card. */
export function StickerPicker({ onDone }: { onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDone();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [onDone]);
  return (
    <div ref={ref} className="stickpick">
      {Object.keys(GLYPHS).map((g) => (
        <button
          key={g}
          className="stickpick__btn"
          aria-label={`Add ${g} sticker`}
          onClick={() => {
            addSticker(g);
            onDone();
          }}
        >
          {GLYPHS[g]}
        </button>
      ))}
    </div>
  );
}
