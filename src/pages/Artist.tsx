import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { artSrc, bridge, subscribe, type NowPlaying, type QueueItem, type Stats } from "../bridge";
import { formatTime } from "../lib";

function fmtLong(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr ${m % 60} min`;
}

interface AlbumGroup {
  name: string;
  items: QueueItem[];
  art: string;
}

export default function Artist() {
  const { name = "" } = useParams();
  const artist = decodeURIComponent(name);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [arts, setArts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError("");
    bridge
      .libraryTracks()
      .then((all) => {
        const mine = all.filter(
          (i) => i.track.artist.trim().toLowerCase() === artist.trim().toLowerCase(),
        );
        setItems(mine);
        // Convert file artwork paths once, keyed by raw artworkUrl.
        const urls = [...new Set(mine.map((i) => i.track.artworkUrl).filter(Boolean))];
        return Promise.all(urls.map((u) => artSrc(u).then((s) => [u, s] as const))).then(
          (pairs) => setArts(Object.fromEntries(pairs)),
        );
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    void bridge.getStats().then(setStats).catch(() => {});
    const off = subscribe<NowPlaying>("now-playing", setNp);
    return off;
  }, [artist]);

  // History play counts keyed by title (TopEntry.sub is the artist).
  const playMap = useMemo(() => {
    const m = new Map<string, { plays: number; ms: number }>();
    for (const t of stats?.topTracks ?? []) {
      if (t.sub.trim().toLowerCase() === artist.trim().toLowerCase()) {
        m.set(t.name, { plays: t.plays, ms: t.ms });
      }
    }
    return m;
  }, [stats, artist]);

  // Popular first (history-ranked), then the rest alphabetically.
  const popular = useMemo(() => {
    return [...items].sort((a, b) => {
      const pa = playMap.get(a.track.title)?.plays ?? 0;
      const pb = playMap.get(b.track.title)?.plays ?? 0;
      return pb - pa || a.track.title.localeCompare(b.track.title);
    });
  }, [items, playMap]);

  const albums = useMemo<AlbumGroup[]>(() => {
    const by = new Map<string, QueueItem[]>();
    for (const i of items) {
      const k = i.track.album || "Singles";
      (by.get(k) ?? by.set(k, []).get(k)!).push(i);
    }
    return [...by.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, items]) => ({
        name,
        items,
        art: items.map((i) => i.track.artworkUrl).find(Boolean) ?? "",
      }));
  }, [items]);

  const totalPlays = stats?.topArtists.find(
    (a) => a.name.trim().toLowerCase() === artist.trim().toLowerCase(),
  );

  const play = (list: QueueItem[], index: number) => {
    setError("");
    bridge.playItems(list, index).catch((e) => setError(String(e)));
  };

  // Up to 4 distinct covers for the hero background + collage.
  const covers = useMemo(
    () => [...new Set(items.map((i) => i.track.artworkUrl).filter(Boolean))].slice(0, 4),
    [items],
  );
  const heroArt = covers[0];

  return (
    <div className="art">
      <div className="art__hero">
        {heroArt && arts[heroArt] && (
          <img className="art__heroBg" src={arts[heroArt]} alt="" aria-hidden />
        )}
        <div className="art__heroScrim" />
        <Link to="/library" className="art__back">
          ← Library
        </Link>
        <div className="art__heroBody">
          <span className="art__kicker">Artist</span>
          <h1 className="art__name">{artist}</h1>
          <span className="art__meta">
            {items.length} {items.length === 1 ? "track" : "tracks"}
            {totalPlays ? ` · ${totalPlays.plays} plays · ${fmtLong(totalPlays.ms)}` : ""}
          </span>
        </div>
        {items.length > 0 && (
          <button className="art__playAll" onClick={() => play(popular, 0)}>
            ▸ Play
          </button>
        )}
        {covers.length > 1 && (
          <div className="art__collage">
            {covers.map((u) =>
              arts[u] ? <img key={u} src={arts[u]} alt="" aria-hidden /> : null,
            )}
          </div>
        )}
      </div>

      <div className="art__scroll">
        {error && <span className="license-bad">{error}</span>}
        {!loading && !error && items.length === 0 && (
          <span className="field">No tracks by {artist} in the music folder.</span>
        )}

        {popular.length > 0 && (
          <>
            <h2 className="art__h">Popular</h2>
            <div className="lib">
              {popular.map((item, i) => {
                const current = np?.track?.id === item.track.id;
                return (
                  <button
                    key={item.path || item.track.id}
                    className={`lib__row art__row ${current ? "lib__row--current" : ""}`}
                    onClick={() => play(popular, i)}
                  >
                    <span className="art__num">{current && np?.status === "playing" ? "▸" : i + 1}</span>
                    <span className="lib__title">{item.track.title}</span>
                    <span className="lib__sub">
                      {item.track.album}
                      {playMap.get(item.track.title)
                        ? ` · ${playMap.get(item.track.title)!.plays} plays`
                        : ""}
                    </span>
                    <span className="lib__dur">
                      {item.track.durationMs ? formatTime(item.track.durationMs) : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {albums.length > 1 && (
          <>
            <h2 className="art__h">Albums</h2>
            <div className="art__albums">
              {albums.map((a) => (
                <button key={a.name} className="art__album" onClick={() => play(a.items, 0)}>
                  {a.art && arts[a.art] ? (
                    <img className="art__albumCover" src={arts[a.art]} alt="" />
                  ) : (
                    <span className="art__albumCover art__albumCover--ph" />
                  )}
                  <span className="art__albumName">{a.name}</span>
                  <span className="art__albumSub">
                    {a.items.length} {a.items.length === 1 ? "track" : "tracks"}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
