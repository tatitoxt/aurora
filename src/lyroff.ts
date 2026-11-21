import type { NowPlaying } from "./bridge";

/** Per-track lyric timing offsets in ms (added to position). Mirrors the
 * favs store pattern: localStorage + same-document event + `storage`
 * event for the other webviews (hud/desklyrics). */

const KEY = "noctbeat.lyroff";
export const LYROFF_EVENT = "noctbeat:lyroff";

function load(): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as Record<string, number>;
  } catch {
    return {};
  }
}

/** Offset for the track playing in `np`, keyed like the favs store. */
export function lyricOffsetFor(np: NowPlaying | null): number {
  const id = np?.track?.id;
  if (!id) return 0;
  const v = load()[`${np?.source ?? ""}:${id}`];
  return typeof v === "number" ? v : 0;
}

/** Persist `ms` for the playing track (0 removes the entry). */
export function setLyricOffset(np: NowPlaying | null, ms: number) {
  const id = np?.track?.id;
  if (!id) return;
  const map = load();
  const key = `${np?.source ?? ""}:${id}`;
  if (ms === 0) delete map[key];
  else map[key] = ms;
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // Quota exceeded — in-memory state still updates this session.
  }
  window.dispatchEvent(new Event(LYROFF_EVENT));
}

export function subscribeLyroff(cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) cb();
  };
  window.addEventListener(LYROFF_EVENT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(LYROFF_EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
}
