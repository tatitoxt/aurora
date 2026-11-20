import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { bridge, subscribe, type NowPlaying, type LrcLine } from "../bridge";
import { activeLyricIndex, formatTime } from "../lib";

export default function Player() {
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [lyrics, setLyrics] = useState<LrcLine[] | null>(null);
  const [art, setArt] = useState<string>("");
  const trackId = useRef<string | null>(null);

  useEffect(() => {
    bridge.getNowPlaying().then(setNp);
    const off = subscribe<NowPlaying>("now-playing", setNp);
    return off;
  }, []);

  const track = np?.track ?? null;
  useEffect(() => {
    if (track && track.id !== trackId.current) {
      trackId.current = track.id;
      bridge.getLyrics().then(setLyrics);
      if (track.artworkUrl) setArt(track.artworkUrl);
    }
  }, [track]);

  const pos = np?.positionMs ?? 0;
  const dur = track?.durationMs ?? 1;
  const active = lyrics ? activeLyricIndex(lyrics, pos) : -1;
  const playing = np?.status === "playing";

  return (
    <div className="glass">
      <div className="player">
        <div className="player__art">
          {art ? <img src={art} alt={track?.album ?? ""} /> : null}
        </div>
        <div className="player__meta">
          <div className="player__title">{track?.title ?? "Nothing playing"}</div>
          <div className="player__sub">
            {track ? `${track.artist} — ${track.album}` : "Start music in any app"}
          </div>
        </div>
        <div>
          <div className="player__progress">
            <div className="player__progress-fill" style={{ width: `${(pos / dur) * 100}%` }} />
          </div>
          <div className="player__times">
            <span>{formatTime(pos)}</span>
            <span>{track ? formatTime(dur) : "-:--"}</span>
          </div>
        </div>
        <div className="player__controls">
          <button className="ctl" aria-label="Previous" onClick={() => bridge.mediaControl("previous")}>
            <svg viewBox="0 0 24 24"><path d="M6 4h2v16H6zM20 4v16L9.5 12z" /></svg>
          </button>
          <button
            className="ctl ctl--play"
            aria-label={playing ? "Pause" : "Play"}
            onClick={() => bridge.mediaControl("play-pause")}
          >
            {playing ? (
              <svg viewBox="0 0 24 24"><path d="M7 4h4v16H7zM13 4h4v16h-4z" /></svg>
            ) : (
              <svg viewBox="0 0 24 24"><path d="M8 4l12 8-12 8z" /></svg>
            )}
          </button>
          <button className="ctl" aria-label="Next" onClick={() => bridge.mediaControl("next")}>
            <svg viewBox="0 0 24 24"><path d="M16 4h2v16h-2zM4 4v16l10.5-8z" /></svg>
          </button>
        </div>
        {lyrics && lyrics.length > 0 && (
          <div className="player__lyrics">
            {lyrics.map((l, i) => (
              <div key={l.atMs} className={`lyric ${i === active ? "lyric--active" : ""}`}>
                {l.text}
              </div>
            ))}
          </div>
        )}
        <Link to="/settings" className="wordmark" style={{ textDecoration: "none" }}>
          {bridge.productName}
        </Link>
      </div>
    </div>
  );
}
