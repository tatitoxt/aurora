import { describe, expect, it } from "vitest";
import { artistCards } from "../lib";

const song = (artist: string, art = artist) => ({ artist, artworkUrl: art });

describe("artistCards", () => {
  it("keeps punctuated band names whole", () => {
    expect(artistCards([song("Earth, Wind & Fire")]).map((a) => a[0])).toEqual([
      "Earth, Wind & Fire",
    ]);
  });
  it("does not drop artists that merely contain another name", () => {
    const names = artistCards([
      song("Queen"),
      song("Queens of the Stone Age"),
    ]).map((a) => a[0]);
    expect(names).toEqual(["Queen", "Queens of the Stone Age"]);
  });
  it("hides collab credits when a credited artist has a card", () => {
    const names = artistCards([
      song("Juice WRLD"),
      song("Juice WRLD & Marshmello"),
      song("Juice WRLD feat. Halsey"),
    ]).map((a) => a[0]);
    expect(names).toEqual(["Juice WRLD"]);
  });
  it("uses the first artwork and caps at 8", () => {
    const list = Array.from({ length: 12 }, (_, i) => song(`A${i}`));
    list.unshift(song("A0", "first"));
    const cards = artistCards(list);
    expect(cards).toHaveLength(8);
    expect(cards[0]).toEqual(["A0", "first"]);
  });
});
