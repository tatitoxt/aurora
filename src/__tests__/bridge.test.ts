import { describe, expect, it } from "vitest";
import { bridge, DEFAULT_SETTINGS } from "../bridge";
import { activeLyricIndex, beatPulse, formatTime } from "../lib";

describe("formatTime", () => {
  it("formats mm:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(61_500)).toBe("1:01");
    expect(formatTime(3_599_000)).toBe("59:59");
  });
});

describe("activeLyricIndex", () => {
  const lines = [
    { atMs: 0, text: "a" },
    { atMs: 5_000, text: "b" },
    { atMs: 10_000, text: "c" },
  ];
  it("returns -1 before the first line", () => {
    expect(activeLyricIndex(lines, -1)).toBe(-1);
  });
  it("returns the current line", () => {
    expect(activeLyricIndex(lines, 0)).toBe(0);
    expect(activeLyricIndex(lines, 6_000)).toBe(1);
    expect(activeLyricIndex(lines, 99_000)).toBe(2);
  });
  it("handles empty", () => {
    expect(activeLyricIndex([], 100)).toBe(-1);
  });
});

describe("beatPulse", () => {
  it("decays from 1 to 0", () => {
    expect(beatPulse(1000, 1000)).toBe(1);
    expect(beatPulse(1000, 1320)).toBe(0);
    expect(beatPulse(1000, 1160)).toBeCloseTo(0.75, 2);
  });
});

describe("browser mock bridge", () => {
  it("polls a demo track", async () => {
    const np = await bridge.getNowPlaying();
    expect(np.track?.title).toBeTruthy();
    expect(np.status).toBe("playing");
  });

  it("media control skips tracks", async () => {
    const first = (await bridge.getNowPlaying()).track!.id;
    await bridge.mediaControl("next");
    const second = (await bridge.getNowPlaying()).track!.id;
    expect(second).not.toBe(first);
    await bridge.mediaControl("previous");
  });

  it("serves demo lyrics", async () => {
    const lyrics = await bridge.getLyrics();
    expect(lyrics!.length).toBeGreaterThan(0);
    expect(lyrics![0].text).toBeTruthy();
  });

  it("persists settings in-session", async () => {
    const s = { ...DEFAULT_SETTINGS, crossfadeMs: 4000 };
    await bridge.updateSettings(s);
    expect((await bridge.getSettings()).crossfadeMs).toBe(4000);
  });

  it("reports license state", async () => {
    expect((await bridge.getLicenseState()).state).toBe("unlicensed");
    const res = await bridge.activateLicense("X");
    expect(res.state).toBe("invalid");
  });
});
