import { describe, expect, it } from "vitest";
import { artistCards, rankHits } from "../lib";

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

describe("rankHits", () => {
  const hit = (title: string, durationMs: number) => ({ title, durationMs });
  it("prefers the original over sped-up or remix versions", () => {
    const hits = [
      hit("Monkeys Spinning Monkeys - accelerating version", 458000),
      hit("Monkeys Spinning Monkeys", 125000),
    ];
    expect(
      rankHits(hits, hit("Monkeys Spinning Monkeys", 124000))[0].title,
    ).toBe("Monkeys Spinning Monkeys");
  });
  it("picks the closest duration and keeps order on ties", () => {
    const hits = [hit("A", 300000), hit("A", 240000), hit("A", 240000)];
    expect(rankHits(hits, hit("A", 239000))).toEqual([
      hits[1],
      hits[2],
      hits[0],
    ]);
  });
  it("keeps alternates when the catalog asks for one", () => {
    const hits = [hit("Song", 200000), hit("Song (Remix)", 260000)];
    expect(rankHits(hits, hit("Song Remix", 260000))[0]).toBe(hits[1]);
  });
});
