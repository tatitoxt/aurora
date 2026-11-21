import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { artSrc, bridge, subscribe, type NowPlaying, type QueueItem } from "../bridge";
import { formatTime } from "../lib";

function fmtLong(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr ${m % 60} min`;
}

export default function Album() {
  const { artist: artistParam = "", name = "" } = useParams();
  const artist = artistParam;
  const album = name;
  const [items, setItems] = useState<QueueItem[]>([]);
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
          (i) =>
            i.track.artist.trim().toLowerCase() === artist.trim().toLowerCase() &&
            (i.track.album || "Singles").trim().toLowerCase() ===
              album.trim().toLowerCase(),
        );
        setItems(mine);
        const urls = [...new Set(mine.map((i) => i.track.artworkUrl).filter(Boolean))];
        return Promise.all(urls.map((u) => artSrc(u).then((s) => [u, s] as const))).then(
          (pairs) => setArts(Object.fromEntries(pairs)),
        );
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    const off = subscribe<NowPlaying>("now-playing", setNp);
    return off;
  }, [artist, album]);

  const totalMs = useMemo(
    () => items.reduce((n, i) => n + i.track.durationMs, 0),
    [items],
  );
  const heroArt = items.map((i) => i.track.artworkUrl).find(Boolean) ?? "";
  const covers = useMemo(
    () => [...new Set(items.map((i) => i.track.artworkUrl).filter(Boolean))].slice(0, 4),
    [items],
  );

  const play = (index: number) => {
    setError("");
    bridge.playItems(items, index).catch((e) => setError(String(e)));
  };

  return (
    <div className="glass art">
      <div className="art__hero">
        {heroArt && arts[heroArt] && (
          <img className="art__heroBg" src={arts[heroArt]} alt="" aria-hidden />
        )}
        <div className="art__heroScrim" />
        <Link to="/albums" className="art__back">
          ← Albums
        </Link>
        <div className="art__heroBody">
          <span className="art__kicker">Album</span>
          <h1 className="art__name">{album}</h1>
          <span className="art__meta">
            <Link to={`/artist/${encodeURIComponent(artist)}`} className="tops__link">
              {artist}
            </Link>{" "}
            · {items.length} {items.length === 1 ? "track" : "tracks"}
            {totalMs > 0 && ` · ${fmtLong(totalMs)}`}
          </span>
        </div>
        {items.length > 0 && (
          <button className="art__playAll" onClick={() => play(0)}>
            ▸ Play
          </button>
        )}
        {covers.length > 1 && (
          <div className="art__collage" aria-hidden>
            {covers.map(
              (c) =>
                arts[c] && <img key={c} src={arts[c]} alt="" />,
            )}
          </div>
        )}
      </div>

      <div className="art__scroll">
        {loading && <span className="art__meta">Scanning library…</span>}
        {error && <span className="art__meta">{error}</span>}
        {!loading && !error && items.length === 0 && (
          <span className="art__meta">No tracks found for this album.</span>
        )}
        {items.map((item, i) => {
          const current = np?.track?.id === item.track.id;
          return (
            <button
              key={item.track.id}
              className={`lib__row art__row ${current ? "lib__row--current" : ""}`}
              onClick={() => play(i)}
            >
              <span className="art__num">{i + 1}</span>
              <span className="lib__title">{item.track.title}</span>
              <span className="lib__sub">{item.track.artist}</span>
              <span className="lib__dur">
                {item.track.durationMs ? formatTime(item.track.durationMs) : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
