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
