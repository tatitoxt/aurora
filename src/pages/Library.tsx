import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { bridge, type NowPlaying, type QueueState } from "../bridge";
import { subscribe } from "../bridge";
import { formatTime } from "../lib";

export default function Library() {
  const [queue, setQueue] = useState<QueueState>({ items: [], currentIndex: null });
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [error, setError] = useState("");

  const refresh = () => bridge.getQueue().then(setQueue).catch(() => {});

  useEffect(() => {
    refresh();
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
          <span>{queue.items.length} tracks</span>
          <div className="seg">
            <button onClick={rescan}>Rescan</button>
            <button onClick={() => void bridge.clearQueue().then(refresh)}>Clear</button>
          </div>
        </div>
        {error && <span className="license-bad">{error}</span>}
        {queue.items.length === 0 && !error && (
          <span className="field">
            Set a music folder in settings, then press Rescan.
          </span>
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
