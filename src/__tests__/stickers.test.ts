import { describe, expect, it, beforeEach } from "vitest";
import { addSticker, loadStickers, moveSticker, removeSticker } from "../stickers";

describe("stickers store", () => {
  beforeEach(() => localStorage.clear());

  it("starts empty and adds a sticker", () => {
    expect(loadStickers()).toEqual([]);
    const list = addSticker("star");
    expect(list).toHaveLength(1);
    expect(list[0].glyph).toBe("star");
    expect(loadStickers()).toHaveLength(1);
  });

  it("moves a sticker and clamps to the card", () => {
    const [s] = addSticker("moon");
    const list = moveSticker(s.id, 1.5, -0.2);
    expect(list[0].x).toBeLessThanOrEqual(0.97);
    expect(list[0].y).toBeGreaterThanOrEqual(0);
  });

  it("removes a sticker by id", () => {
    const [a] = addSticker("heart");
    addSticker("star");
    expect(removeSticker(a.id)).toHaveLength(1);
    expect(loadStickers()[0].glyph).toBe("star");
  });

  it("persists across loads", () => {
    addSticker("vinyl");
    expect(loadStickers()[0].glyph).toBe("vinyl");
  });
});
