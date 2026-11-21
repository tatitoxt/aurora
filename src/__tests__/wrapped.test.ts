import { describe, expect, it } from "vitest";
import { monthLabel, wrappedModel } from "../wrapped";
import type { Wrapped } from "../bridge";

const base: Wrapped = {
  month: "2026-01",
  totalMs: 3_600_000,
  plays: 12,
  uniqueTracks: 8,
  uniqueArtists: 3,
  streakDays: 4,
  bestDay: { date: "2026-01-12", plays: 5, ms: 900_000 },
  topTracks: [{ name: "Aurora", sub: "Violet Sector", plays: 6, ms: 1_500_000 }],
  topArtists: [{ name: "Violet Sector", sub: "", plays: 9, ms: 2_000_000 }],
};

describe("monthLabel", () => {
  it("maps YYYY-MM to a readable month", () => {
    expect(monthLabel("2026-01")).toBe("January 2026");
    expect(monthLabel("2025-12")).toBe("December 2025");
  });
  it("falls back on malformed input", () => {
    expect(monthLabel("nope")).toBe("nope");
  });
});

describe("wrappedModel", () => {
  it("formats the hero numbers", () => {
    const m = wrappedModel(base);
    expect(m.headline).toBe("January 2026 in music");
    expect(m.minutes).toBe("1h 0m");
    expect(m.plays).toBe("12 plays");
    expect(m.streak).toBe("4 days in a row");
    expect(m.unique).toBe("8 tracks · 3 artists");
    expect(m.topTrack).toBe("Aurora · Violet Sector");
    expect(m.topArtist).toBe("Violet Sector");
    expect(m.bestDay).toBe("2026-01-12 · 5 plays");
  });
  it("handles an empty month", () => {
    const m = wrappedModel({
      ...base,
      plays: 0,
      totalMs: 0,
      streakDays: 0,
      bestDay: null,
      topTracks: [],
      topArtists: [],
    });
    expect(m.minutes).toBe("0 min");
    expect(m.streak).toBe("-");
    expect(m.topTrack).toBe("-");
    expect(m.bestDay).toBe("-");
  });
  it("singularizes one play and one streak day", () => {
    const m = wrappedModel({ ...base, plays: 1, streakDays: 1 });
    expect(m.plays).toBe("1 play");
    expect(m.streak).toBe("1 day");
  });
});
