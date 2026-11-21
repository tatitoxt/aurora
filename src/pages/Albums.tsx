import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { artSrc, bridge, type QueueItem } from "../bridge";

interface AlbumGroup {
  artist: string;
  name: string;
  items: QueueItem[];
  art: string;
  ms: number;
}

export default function Albums() {
  const [groups, setGroups] = useState<AlbumGroup[]>([]);
  const [arts, setArts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError("");
    bridge
      .libraryTracks()
      .then((all) => {
        const by = new Map<string, AlbumGroup>();
        for (const i of all) {
          const artist = i.track.artist || "Unknown Artist";
          const name = i.track.album || "Singles";
          const key = `${artist} ${name}`;
          const g =
            by.get(key) ??
            by
              .set(key, { artist, name, items: [], art: "", ms: 0 })
              .get(key)!;
          g.items.push(i);
          g.ms += i.track.durationMs;
          if (!g.art && i.track.artworkUrl) g.art = i.track.artworkUrl;
        }
        const list = [...by.values()].sort(
          (a, b) => a.artist.localeCompare(b.artist) || a.name.localeCompare(b.name),
        );
        setGroups(list);
        const urls = [...new Set(list.map((g) => g.art).filter(Boolean))];
        return Promise.all(urls.map((u) => artSrc(u).then((s) => [u, s] as const))).then(
          (pairs) => setArts(Object.fromEntries(pairs)),
        );
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const stats = useMemo(
    () => ({
      albums: groups.length,
      tracks: groups.reduce((n, g) => n + g.items.length, 0),
    }),
    [groups],
  );

  return (
    <div className="glass art">
      <div className="art__hero">
        <div className="art__heroScrim" />
        <Link to="/library" className="art__back">
          ← Library
        </Link>
        <div className="art__heroBody">
          <span className="art__kicker">Collection</span>
          <h1 className="art__name">Albums</h1>
          <span className="art__meta">
            {stats.albums} {stats.albums === 1 ? "album" : "albums"} · {stats.tracks}{" "}
            {stats.tracks === 1 ? "track" : "tracks"}
          </span>
        </div>
      </div>

      <div className="art__scroll">
        {loading && <span className="art__meta">Scanning library…</span>}
        {error && <span className="art__meta">{error}</span>}
        {!loading && !error && groups.length === 0 && (
          <span className="art__meta">
            No local music yet — pick a folder in Settings → Music folder.
          </span>
        )}
        <div className="art__albums">
          {groups.map((g) => (
            <Link
              key={`${g.artist}${g.name}`}
              to={`/album/${encodeURIComponent(g.artist)}/${encodeURIComponent(g.name)}`}
              className="art__album"
            >
              {g.art && arts[g.art] ? (
                <img className="art__albumCover" src={arts[g.art]} alt="" />
              ) : (
                <span className="art__albumCover art__albumCover--ph" />
              )}
              <span className="art__albumName">{g.name}</span>
              <span className="art__albumSub">
                {g.artist} · {g.items.length}{" "}
                {g.items.length === 1 ? "track" : "tracks"}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
