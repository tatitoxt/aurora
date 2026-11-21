import { useEffect, useState } from "react";
import {
  bridge,
  subscribe,
  type NowPlaying,
  type LrcLine,
  type QueueState,
} from "../bridge";
import { activeLyricIndex, formatTime } from "../lib";
import { CornersIn, Pause, Play, Shuffle, SkipBack, SkipForward } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";

/** iBaila "Albums"-style fullscreen: blurred art wall, giant outlined clock,
 * Continue Playing panel left, lyric center, transport pill bottom. */
export default function Fullscreen() {
  const nav = useNavigate();
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [lyrics, setLyrics] = useState<LrcLine[] | null>(null);
  const [queue, setQueue] = useState<QueueState>({ items: [], currentIndex: null });
  const [art, setArt] = useState("");
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    bridge.getNowPlaying().then(setNp);
    bridge.getQueue().then(setQueue);
    const off = subscribe<NowPlaying>("now-playing", setNp);
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => {
      off();
      clearInterval(clock);
    };
  }, []);

  const track = np?.track ?? null;
  useEffect(() => {
    if (!track) {
      setLyrics(null);
      setArt("");
      return;
    }
    bridge.getLyrics().then(setLyrics);
    bridge.getQueue().then(setQueue);
    if (track.artworkUrl) void bridge.artSrc(track.artworkUrl).then(setArt);
    else setArt("");
  }, [track?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = np?.positionMs ?? 0;
  const dur = track?.durationMs ?? 1;
  const active = lyrics ? activeLyricIndex(lyrics, pos) : -1;
  const playing = np?.status === "playing";
  const line = lyrics && active >= 0 ? lyrics[active].text : null;

  const hh = String(now.getHours() % 12 || 12);
  const mm = String(now.getMinutes()).padStart(2, "0");
  const date = now.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  return (
    <div className="fs">
      <div className="fs__bg">
        {art ? <img src={art} alt="" /> : null}
        <div className="fs__veil" />
      </div>

      <div className="fs__clockwrap">
        <div className="fs__date">{date}</div>
        <div className="fs__clock">
          {hh}
          <span className="fs__colon">:</span>
          {mm}
        </div>
      </div>

      {queue.items.length > 0 && (
        <aside className="fs__queue">
          <div className="fs__qhead">Continue Playing</div>
          <div className="fs__qlist">
            {queue.items.slice(0, 12).map((it, i) => (
              <button
                key={it.path + i}
                className={`fs__qrow ${i === queue.currentIndex ? "fs__qrow--on" : ""}`}
                onClick={() => void bridge.playQueueIndex(i)}
              >
                <span className="fs__qtitle">{it.track.title}</span>
                <span className="fs__qsub">{it.track.artist}</span>
              </button>
            ))}
          </div>
        </aside>
      )}

      <div className="fs__center">
        {line ? (
          <div className="fs__lyric">{line}</div>
        ) : track ? (
          <div className="fs__lyric fs__lyric--title">{track.title}</div>
        ) : (
          <div className="fs__lyric fs__lyric--title">{bridge.productName}</div>
        )}
      </div>

      <div className="fs__bottom">
        <div className="fs__prog">
          <span className="fs__time">{formatTime(pos)}</span>
          <div className="fs__bar">
            <div
              className="fs__barfill"
              style={{ width: `${Math.min(100, (pos / Math.max(dur, 1)) * 100)}%` }}
            />
          </div>
          <span className="fs__time">{formatTime(dur)}</span>
        </div>
        <div className="fs__pill">
          <button className="fs__icon" aria-label="Shuffle" onClick={() => void bridge.mediaControl("next")}>
            <Shuffle size={15} />
          </button>
          <button className="fs__icon" aria-label="Previous" onClick={() => void bridge.mediaControl("previous")}>
            <SkipBack weight="fill" size={17} />
          </button>
          <button
            className="fs__play"
            aria-label={playing ? "Pause" : "Play"}
            onClick={() => void bridge.mediaControl("play-pause")}
          >
            {playing ? <Pause weight="fill" size={20} /> : <Play weight="fill" size={20} />}
          </button>
          <button className="fs__icon" aria-label="Next" onClick={() => void bridge.mediaControl("next")}>
            <SkipForward weight="fill" size={17} />
          </button>
          <div className="fs__meta">
            {art ? <img src={art} alt="" /> : null}
            <div className="fs__meta-txt">
              <div className="fs__mtitle">{track?.title ?? "Nothing playing"}</div>
              <div className="fs__msub">
                {track ? `${track.artist} · ${track.album}` : "Start music"}
              </div>
            </div>
          </div>
          <button
            className="fs__icon"
            aria-label="Exit fullscreen"
            title="Exit fullscreen"
            onClick={() =>
              void bridge.toggleFullscreen().then(() => nav("/"))
            }
          >
            <CornersIn size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
