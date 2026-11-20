import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { bridge, type NowPlaying, type QueueState, type RemoteTrack } from "../bridge";
import { subscribe } from "../bridge";
import { formatTime } from "../lib";

const SOURCES = [
  { id: "youtube", label: "YouTube" },
  { id: "soundcloud", label: "SoundCloud" },
];

export default function Library() {
  const [queue, setQueue] = useState<QueueState>({ items: [], currentIndex: null });
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [error, setError] = useState("");

  const [ytReady, setYtReady] = useState(false);
  const [source, setSource] = useState("youtube");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RemoteTrack[]>([]);
  const [searching, setSearching] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  const refresh = () => bridge.getQueue().then(setQueue).catch(() => {});

  useEffect(() => {
    refresh();
    void bridge.providerStatus().then(setYtReady);
    const off = subscribe<NowPlaying>("now-playing", () => refresh());
    const offNp = subscribe<NowPlaying>("now-playing", setNp);
    return () => {
      off();
      offNp();
    };
  }, []);

  const rescan = () => {
    setError("");
    bridge
      .scanLibrary()
      .then((items) => setQueue({ items, currentIndex: null }))
      .catch((e) => setError(String(e)));
  };

  const search = () => {
    if (!query.trim()) return;
    setSearching(true);
    setError("");
    bridge
      .providerSearch(source, query.trim())
      .then(setResults)
      .catch((e) => setError(String(e)))
      .finally(() => setSearching(false));
  };

  const playRemote = (t: RemoteTrack) => {
    setDownloading(t.id);
    setError("");
    bridge
      .providerPlay(t)
      .then(() => refresh())
      .catch((e) => setError(String(e)))
      .finally(() => setDownloading(null));
  };

  const playing = np?.status === "playing";

  return (
    <div className="glass">
      <div className="settings">
        <div className="row">
          <h1>Library</h1>
          <Link to="/" className="wordmark" style={{ textDecoration: "none" }}>
            Back
          </Link>
        </div>

        <div className="row">
          <span>Stream</span>
          <div className="seg">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                className={source === s.id ? "on" : ""}
                onClick={() => setSource(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <input
            type="text"
            placeholder="Search tracks…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
          />
          <button onClick={search} disabled={searching}>
            {searching ? "…" : "Go"}
          </button>
        </div>
        {!ytReady && (
          <span className="field">
            Streaming needs <code style={{whiteSpace:"nowrap"}}>yt-dlp</code> installed (brew or pip).
          </span>
        )}
        <div className="lib">
          {results.map((t) => (
            <button
              key={`${t.source}:${t.id}`}
              className="lib__row"
              onClick={() => playRemote(t)}
              disabled={downloading !== null}
            >
              <span className="lib__title">
                {downloading === t.id ? "⤓ " : ""}
                {t.title}
              </span>
              <span className="lib__sub">{t.artist}</span>
              <span className="lib__dur">{t.durationMs ? formatTime(t.durationMs) : ""}</span>
            </button>
          ))}
        </div>

        <div className="row">
          <span>{queue.items.length} tracks</span>
          <div className="seg">
            <button onClick={rescan}>Rescan</button>
            <button onClick={() => void bridge.clearQueue().then(refresh)}>Clear</button>
          </div>
        </div>
        {error && <span className="license-bad">{error}</span>}
        {queue.items.length === 0 && !error && (
          <span className="field">Set a music folder in settings, then press Rescan.</span>
        )}
        <div className="lib">
          {queue.items.map((item, i) => {
            const current = queue.currentIndex === i;
            return (
              <button
                key={item.path}
                className={`lib__row ${current ? "lib__row--current" : ""}`}
                onClick={() => void bridge.playQueueIndex(i).then(refresh)}
              >
                <span className="lib__title">{item.track.title}</span>
                <span className="lib__sub">{item.track.artist}</span>
                <span className="lib__dur">
                  {current && playing ? "▸ " : ""}
                  {item.track.durationMs ? formatTime(item.track.durationMs) : ""}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
