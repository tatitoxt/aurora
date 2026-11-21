import type { Wrapped } from "./bridge";
import { ellipsize } from "./share";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-01" → "January 2026"; falls back to the raw string. */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const name = MONTHS[m - 1];
  return name && y ? `${name} ${y}` : month;
}

export interface WrappedModel {
  headline: string;
  minutes: string;
  plays: string;
  streak: string;
  unique: string;
  topTrack: string;
  topArtist: string;
  bestDay: string;
}

/** Text model the recap page and poster paint — pure, unit-tested. */
export function wrappedModel(w: Wrapped): WrappedModel {
  const minutes = Math.round(w.totalMs / 60_000);
  const hours = Math.floor(minutes / 60);
  return {
    headline: `${monthLabel(w.month)} in music`,
    minutes: hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes} min`,
    plays: `${w.plays} ${w.plays === 1 ? "play" : "plays"}`,
    streak:
      w.streakDays > 1
        ? `${w.streakDays} days in a row`
        : w.streakDays === 1
          ? "1 day"
          : "-",
    unique: `${w.uniqueTracks} tracks · ${w.uniqueArtists} artists`,
    topTrack: w.topTracks[0]
      ? ellipsize(
          [w.topTracks[0].name, w.topTracks[0].sub]
            .filter(Boolean)
            .join(" · "),
          48,
        )
      : "-",
    topArtist: ellipsize(w.topArtists[0]?.name ?? "-", 40),
    bestDay: w.bestDay ? `${w.bestDay.date} · ${w.bestDay.plays} plays` : "-",
  };
}
