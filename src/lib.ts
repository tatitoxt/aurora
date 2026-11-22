import type { LrcLine } from "./bridge";

export function formatTime(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Last line at or before pos; -1 before the first line. */
export function activeLyricIndex(lines: LrcLine[], posMs: number): number {
  if (!lines.length || posMs < lines[0].atMs) return -1;
  let lo = 0,
    hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].atMs <= posMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Ease-out pulse: 1 right after a beat, decaying to 0 over `decayMs`. */
export function beatPulse(
  lastBeatMs: number,
  nowMs: number,
  decayMs = 320,
): number {
  const t = Math.max(0, nowMs - lastBeatMs) / decayMs;
  return t >= 1 ? 0 : 1 - t * t;
}

/** Split a lyric line into text tokens, flagging adlibs — background
 * vocals conventionally written inside parentheses — so renderers can
 * style them smaller and dimmer than the lead words. */
export function adlibSegments(
  text: string,
): { text: string; adlib: boolean }[] {
  const out: { text: string; adlib: boolean }[] = [];
  let depth = 0;
  let buf = "";
  const flush = () => {
    if (buf)
      out.push({
        text: buf,
        adlib: depth > 0 || /^\s*\(/.test(buf) || /\)\s*$/.test(buf),
      });
    buf = "";
  };
  for (const ch of text) {
    if (ch === "(") {
      flush();
      depth++;
      buf += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      buf += ch;
      flush();
    } else {
      buf += ch;
    }
  }
  flush();
  return out;
}

/** Per-word adlib flags for already-tokenized lyrics: a word is an adlib
 * when it sits inside an open parenthesis group. */
export function adlibMask(words: string[]): boolean[] {
  const mask: boolean[] = [];
  let depth = 0;
  for (const w of words) {
    const starts = depth > 0 || w.includes("(");
    mask.push(starts);
    for (const ch of w) {
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
    }
  }
  return mask;
}

/** Artist cards for a song list: first artwork per artist, max 8. Collab
 *  credits ("A & B") are hidden when a credited artist has its own card;
 *  punctuated names like "Earth, Wind & Fire" stay whole. */
export function artistCards(
  songs: { artist: string; artworkUrl: string }[],
): [string, string][] {
  const seen = new Map<string, string>();
  for (const s of songs) {
    if (s.artist && !seen.has(s.artist)) seen.set(s.artist, s.artworkUrl);
  }
  const names = [...seen.keys()];
  return [...seen]
    .filter(([n]) => {
      const parts = n.split(/\s*(?:,|&|\bfeat\.?|\bx\b)\s*/i);
      return !(
        parts.length > 1 && names.some((o) => o !== n && parts.includes(o))
      );
    })
    .slice(0, 8);
}

const ALT_VERSION =
  /\b(remix|sped|slowed|reverb|accelerat\w*|nightcore|cover|8d|instrumental|karaoke|live|loop)\b/i;

/** Order provider hits by how well they match a catalog song: alternate
 *  versions the catalog title doesn't ask for (sped up, remix, cover…) go
 *  last, then the closest duration wins. */
export function rankHits<T extends { title: string; durationMs: number }>(
  hits: T[],
  want: { title: string; durationMs: number },
): T[] {
  const wantsAlt = ALT_VERSION.test(want.title);
  const score = (h: T) =>
    (!wantsAlt && ALT_VERSION.test(h.title) ? 1e9 : 0) +
    (want.durationMs > 0 && h.durationMs > 0
      ? Math.abs(h.durationMs - want.durationMs)
      : 0);
  return hits
    .map((h, i) => ({ h, i, s: score(h) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.h);
}
