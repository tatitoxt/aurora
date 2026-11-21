import type { Track } from "./bridge";
import { formatTime } from "./lib";

export interface CardModel {
  title: string;
  subtitle: string;
  /** 0..1 fill of the progress bar. */
  progress: number;
  elapsed: string;
  total: string;
}

/** Text/timing model the share card paints — pure, unit-tested. */
export function cardModel(track: Track | null, posMs: number): CardModel {
  const total = track?.durationMs ?? 0;
  return {
    title: ellipsize(track?.title || "Nothing playing", 42),
    subtitle: ellipsize(
      [track?.artist, track?.album].filter(Boolean).join(" · "),
      52,
    ),
    progress: total > 0 ? Math.min(1, posMs / total) : 0,
    elapsed: formatTime(posMs),
    total: total > 0 ? formatTime(total) : "-:--",
  };
}

export function ellipsize(text: string, maxChars: number): string {
  return text.length > maxChars
    ? text.slice(0, maxChars - 1).trimEnd() + "…"
    : text;
}
