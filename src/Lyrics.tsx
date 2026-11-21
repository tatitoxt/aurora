import { useEffect, useRef } from "react";
import type { LrcLine } from "./bridge";

/** Spotify-style scrolling list: active line centered, neighbors dim. */
export function LineLyrics({ lines, active }: { lines: LrcLine[]; active: number }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current
      ?.querySelector(".lyric--active")
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active]);
  return (
    <div className="player__lyrics" ref={box}>
      {lines.map((l, i) => (
        <div key={l.atMs} className={`lyric ${i === active ? "lyric--active" : ""}`}>
          {l.text}
        </div>
      ))}
    </div>
  );
}

/** iBaila-style karaoke: the current line huge and centered, words lighting up
 * one by one with the accent as the song reaches them. Word timing comes from
 * enhanced-LRC word tags when the source has them; otherwise it is split
 * evenly across the line. */
export function KaraokeLyric({
  line,
  nextLine,
  posMs,
}: {
  line: LrcLine | null;
  nextLine: LrcLine | null;
  posMs: number;
}) {
  if (!line) return null;
  const timed = line.words && line.words.length > 0;
  // A2 segments are syllables with verbatim spacing; the even split needs
  // a space appended per word.
  const segments = timed
    ? line.words!.map((w) => w.text)
    : line.text
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w + " ");
  const elapsed = posMs - line.atMs;
  const current = timed
    ? elapsed < 0
      ? -1
      : line.words!.reduce((acc, w, i) => (posMs >= w.atMs ? i : acc), -1)
    : Math.floor(
        elapsed /
          (Math.max(nextLine ? nextLine.atMs - line.atMs : 5000, 800) /
            Math.max(segments.length, 1)),
      );

  return (
    <div className="karaoke">
      <div className="karaoke__line" key={line.atMs}>
        {segments.map((w, i) => {
          const cls =
            i < current ? "kword kword--done" : i === current ? "kword kword--now" : "kword";
          return (
            <span key={i} className={cls}>
              {w}
            </span>
          );
        })}
      </div>
      {nextLine && <div className="karaoke__next">{nextLine.text}</div>}
    </div>
  );
}
