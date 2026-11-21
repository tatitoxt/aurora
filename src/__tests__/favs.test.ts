import { beforeEach, describe, expect, it } from "vitest";
import {
  favEntryFor,
  favKeyFor,
  favKeys,
  listable,
  loadFavs,
  remoteParts,
  toggleFav,
  toQueueItem,
  toRemoteTrack,
  type FavEntry,
} from "../favs";
import type { NowPlaying } from "../bridge";

const np = (id: string, source = "local"): NowPlaying => ({
  track: {
    id,
    title: "Song",
    artist: "Artist",
    album: "Album",
    artworkUrl: "https://art/x.jpg",
    durationMs: 60_000,
  },
  status: "playing",
  positionMs: 0,
  source,
  updatedAtMs: 0,
});

const entry: FavEntry = {
  key: "local:/music/a.mp3",
  trackId: "/music/a.mp3",
  title: "Song",
  artist: "Artist",
  artworkUrl: "https://art/x.jpg",
  durationMs: 60_000,
};

describe("favs", () => {
  beforeEach(() => localStorage.clear());

  it("builds the heart key from source + track id", () => {
    expect(favKeyFor(np("/m/a.mp3"))).toBe("local:/m/a.mp3");
    expect(favKeyFor(np("youtube:abc", "local"))).toBe("local:youtube:abc");
    expect(favKeyFor(null)).toBe("");
  });

  it("captures display metadata in the entry", () => {
    const e = favEntryFor(np("/m/a.mp3"));
    expect(e).toMatchObject({
      key: "local:/m/a.mp3",
      trackId: "/m/a.mp3",
      title: "Song",
      artist: "Artist",
    });
    expect(favEntryFor(null)).toBeNull();
  });

  it("toggles entries in and out, newest first", () => {
    let favs = toggleFav([], entry);
    expect(favKeys(favs).has(entry.key)).toBe(true);
    const second = { ...entry, key: "local:/m/b.mp3", trackId: "/m/b.mp3" };
    favs = toggleFav(favs, second);
    expect(favs[0].key).toBe(second.key);
    favs = toggleFav(favs, entry);
    expect(favKeys(favs).has(entry.key)).toBe(false);
    expect(loadFavs().length).toBe(1);
  });

  it("keeps legacy string keys for the heart, hidden from the list", () => {
    localStorage.setItem("noctbeat.favs", JSON.stringify(["local:/old.mp3", 42]));
    const favs = loadFavs();
    expect(favKeys(favs).has("local:/old.mp3")).toBe(true);
    expect(listable(favs)).toHaveLength(0);
  });

  it("round-trips stored entries through loadFavs", () => {
    localStorage.setItem(
      "noctbeat.favs",
      JSON.stringify([{ key: "local:youtube:abc", trackId: "youtube:abc", title: "V", artist: "A", artworkUrl: "", durationMs: 5 }]),
    );
    expect(listable(loadFavs())[0].title).toBe("V");
  });

  it("classifies provider ids vs local paths", () => {
    expect(remoteParts("youtube:abc")).toEqual({ source: "youtube", id: "abc" });
    expect(remoteParts("soundcloud:user/track")).toEqual({
      source: "soundcloud",
      id: "user/track",
    });
    expect(remoteParts("/music/a.mp3")).toBeNull();
  });

  it("rebuilds a playable RemoteTrack from a liked stream", () => {
    const rt = toRemoteTrack({ ...entry, trackId: "youtube:abc123" });
    expect(rt).toMatchObject({
      id: "abc123",
      source: "youtube",
      url: "https://www.youtube.com/watch?v=abc123",
      title: "Song",
    });
    expect(toRemoteTrack(entry)).toBeNull();
  });

  it("maps a local like to a queue item keyed by its path", () => {
    const item = toQueueItem(entry);
    expect(item.path).toBe("/music/a.mp3");
    expect(item.track.title).toBe("Song");
  });
});
