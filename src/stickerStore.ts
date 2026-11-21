/** Decorative stickers on the mini player: persisted in localStorage and
 * synced across webviews via the storage event, same pattern as favs.ts. */

export type Sticker = {
  id: string;
  glyph: string;
  /** position as a fraction of the card (0..1) so it survives resizes */
  x: number;
  y: number;
  /** scale multiplier, 1 = default */
  s: number;
};

const KEY = "noctbeat.stickers";
const EVENT = "noctbeat-stickers";

export function loadStickers(): Sticker[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as Sticker[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function save(list: Sticker[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function addSticker(glyph: string): Sticker[] {
  const list = loadStickers();
  const jitter = (list.length % 5) * 0.04;
  list.push({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    glyph,
    x: Math.min(0.82, 0.5 + jitter),
    y: Math.min(0.8, 0.12 + jitter),
    s: 1,
  });
  save(list);
  return list;
}

export function moveSticker(id: string, x: number, y: number): Sticker[] {
  const list = loadStickers().map((s) =>
    s.id === id ? { ...s, x: Math.min(0.97, Math.max(0, x)), y: Math.min(0.97, Math.max(0, y)) } : s,
  );
  save(list);
  return list;
}

export function removeSticker(id: string): Sticker[] {
  const list = loadStickers().filter((s) => s.id !== id);
  save(list);
  return list;
}

export function subscribeStickers(cb: () => void): () => void {
  const onCustom = () => cb();
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener(EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}
