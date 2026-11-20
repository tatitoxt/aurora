import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  bridge,
  subscribe,
  DEFAULT_SETTINGS,
  type NowPlaying,
  type LrcLine,
  type Settings,
} from "../bridge";
import { KaraokeLyric, LineLyrics } from "../Lyrics";
import { activeLyricIndex, formatTime } from "../lib";

const PREV = <svg viewBox="0 0 24 24"><path d="M6 4h2v16H6zM20 4v16L9.5 12z" /></svg>;
const NEXT = <svg viewBox="0 0 24 24"><path d="M16 4h2v16h-2zM4 4v16l10.5-8z" /></svg>;
const PAUSE = <svg viewBox="0 0 24 24"><path d="M7 4h4v16H7zM13 4h4v16h-4z" /></svg>;
const PLAY = <svg viewBox="0 0 24 24"><path d="M8 4l12 8-12 8z" /></svg>;

export default function Player() {
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [lyrics, setLyrics] = useState<LrcLine[] | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [art, setArt] = useState<string>("");
  const trackId = useRef<string | null>(null);

  useEffect(() => {
    bridge.getNowPlaying().then(setNp);
    bridge.getSettings().then(setSettings);
    const off = subscribe<NowPlaying>("now-playing", setNp);
    const offS = subscribe<Settings>("settings", setSettings);
    return () => {
      off();
      offS();
    };
  }, []);

  const track = np?.track ?? null;
  useEffect(() => {
    if (track && track.id !== trackId.current) {
      trackId.current = track.id;
      bridge.getLyrics().then(setLyrics);
      if (track.artworkUrl) void bridge.artSrc(track.artworkUrl).then(setArt);
      else setArt("");
    }
  }, [track]);

  const pos = np?.positionMs ?? 0;
  const dur = track?.durationMs ?? 1;
  const active = lyrics ? activeLyricIndex(lyrics, pos) : -1;
  const playing = np?.status === "playing";
  const karaoke = settings.lyricsMode === "karaoke";

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (np?.source !== "local") return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - r.left) / r.width;
    if (track?.durationMs) void bridge.seek(Math.floor(frac * track.durationMs));
  };

  const controls = (
    <div className="player__controls">
      <button className="ctl" aria-label="Previous" onClick={() => bridge.mediaControl("previous")}>
        {PREV}
      </button>
      <button
        className="ctl ctl--play"
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => bridge.mediaControl("play-pause")}
      >
        {playing ? PAUSE : PLAY}
      </button>
      <button className="ctl" aria-label="Next" onClick={() => bridge.mediaControl("next")}>
        {NEXT}
      </button>
    </div>
  );

  const progress = (
    <div>
      <div
        className="player__progress"
        role="slider"
        aria-label="Seek"
        style={{ cursor: np?.source === "local" ? "pointer" : "default" }}
        onClick={seek}
      >
        <div className="player__progress-fill" style={{ width: `${(pos / dur) * 100}%` }} />
      </div>
      <div className="player__times">
        <span>{formatTime(pos)}</span>
        <span>{track ? formatTime(dur) : "-:--"}</span>
      </div>
    </div>
  );

  const nav = (
    <div className="player__nav">
      <Link to="/library" className="wordmark" style={{ textDecoration: "none" }}>
        Library
      </Link>
      <Link to="/settings" className="wordmark" style={{ textDecoration: "none" }}>
        {bridge.productName}
      </Link>
    </div>
  );

  if (karaoke) {
    return (
      <div className="glass glass--bare">
        <div className="kbg">
          {art ? <img src={art} alt="" /> : null}
          <div className="kbg__veil" />
        </div>
        <div className="player player--karaoke">
          <div className="kmeta">
            <div className="kmeta__title">{track?.title ?? "Nothing playing"}</div>
            <div className="kmeta__sub">
              {track ? `${track.artist} — ${track.album}` : "Start music in any app"}
            </div>
          </div>
          <div className="kcenter">
            {lyrics && active >= 0 ? (
              <KaraokeLyric
                line={lyrics[active]}
                nextLine={lyrics[active + 1] ?? null}
                posMs={pos}
              />
            ) : (
              <div className="karaoke__idle">{track ? track.title : "Noctbeat"}</div>
            )}
          </div>
          {progress}
          {controls}
          {nav}
        </div>
      </div>
    );
  }

  return (
    <div className="glass">
      <div className="player">
        <div className="player__art">{art ? <img src={art} alt={track?.album ?? ""} /> : null}</div>
        <div className="player__meta">
          <div className="player__title">{track?.title ?? "Nothing playing"}</div>
          <div className="player__sub">
            {track ? `${track.artist} — ${track.album}` : "Start music in any app"}
          </div>
        </div>
        {progress}
        {controls}
        {lyrics && lyrics.length > 0 && <LineLyrics lines={lyrics} active={active} />}
        {nav}
      </div>
    </div>
  );
}
