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
export function beatPulse(lastBeatMs: number, nowMs: number, decayMs = 320): number {
  const t = Math.max(0, nowMs - lastBeatMs) / decayMs;
  return t >= 1 ? 0 : 1 - t * t;
}

/** Split a lyric line into text tokens, flagging adlibs — background
 * vocals conventionally written inside parentheses — so renderers can
 * style them smaller and dimmer than the lead words. */
export function adlibSegments(text: string): { text: string; adlib: boolean }[] {
  const out: { text: string; adlib: boolean }[] = [];
  let depth = 0;
  let buf = "";
  const flush = () => {
    if (buf) out.push({ text: buf, adlib: depth > 0 || /^\s*\(/.test(buf) || /\)\s*$/.test(buf) });
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
