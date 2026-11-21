import { describe, expect, it } from "vitest";
import { cardModel, ellipsize } from "../share";
import type { Track } from "../bridge";

const track: Track = {
  id: "t1",
  title: "Aurora Skyline",
  artist: "Orkelya",
  album: "Night Shift",
  durationMs: 200_000,
  artworkUrl: "",
};

describe("ellipsize", () => {
  it("keeps short text intact", () => {
    expect(ellipsize("hello", 10)).toBe("hello");
  });
  it("truncates long text with an ellipsis", () => {
    const out = ellipsize("a]b cdefghijklmnopqrstuvwxyz", 12);
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("cardModel", () => {
  it("maps a track and position into card fields", () => {
    const m = cardModel(track, 100_000);
    expect(m.title).toBe("Aurora Skyline");
    expect(m.subtitle).toBe("Orkelya · Night Shift");
    expect(m.progress).toBeCloseTo(0.5);
    expect(m.elapsed).toBe("1:40");
    expect(m.total).toBe("3:20");
  });
  it("handles no track", () => {
    const m = cardModel(null, 5_000);
    expect(m.title).toBe("Nothing playing");
    expect(m.progress).toBe(0);
    expect(m.total).toBe("-:--");
  });
  it("clamps progress at 1", () => {
    expect(cardModel(track, 999_999).progress).toBe(1);
  });
  it("ellipsizes very long titles", () => {
    const long = { ...track, title: "X".repeat(80) };
    expect(cardModel(long, 0).title.length).toBeLessThanOrEqual(42);
  });
});
