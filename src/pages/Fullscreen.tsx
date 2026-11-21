import { useEffect, useState } from "react";
import {
  bridge,
  subscribe,
  type NowPlaying,
  type LrcLine,
  type QueueState,
} from "../bridge";
import { activeLyricIndex, formatTime } from "../lib";
import {
  CaretDown,
  CornersIn,
  GearSix,
  Moon,
  Pause,
  Play,
  Shuffle,
  SkipBack,
  SkipForward,
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";

function QueueThumb({ track }: { track: { artworkUrl: string; title: string } }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (track.artworkUrl) void bridge.artSrc(track.artworkUrl).then(setSrc);
    else setSrc("");
  }, [track.artworkUrl]);
  return src ? (
    <img className="fs__qthumb" src={src} alt="" />
  ) : (
    <div className="fs__qthumb fs__meta-art" aria-hidden="true" />
  );
}

/** iBaila "Albums"-style fullscreen: blurred art wall, giant outlined clock,
 * Continue Playing panel left, lyric center, transport pill bottom. */
export default function Fullscreen() {
  const nav = useNavigate();
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [lyrics, setLyrics] = useState<LrcLine[] | null>(null);
  const [queue, setQueue] = useState<QueueState>({ items: [], currentIndex: null });
  const [art, setArt] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [shuffle, setShuffle] = useState(false);
  const [queueOpen, setQueueOpen] = useState(true);

  useEffect(() => {
    bridge.getNowPlaying().then(setNp);
    bridge.getQueue().then(setQueue);
    bridge.getShuffle().then(setShuffle);
    const off = subscribe<NowPlaying>("now-playing", setNp);
    const offQ = subscribe<QueueState>("queue", setQueue);
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => {
      off();
      offQ();
      clearInterval(clock);
    };
  }, []);

  const track = np?.track ?? null;
  const pos = np?.positionMs ?? 0;
  const dur = track?.durationMs ?? 0;

  // Resolved artwork URLs for the mosaic wall and the cover carousel.
  const [artMap, setArtMap] = useState<Record<string, string>>({});
  useEffect(() => {
    const urls = [
      ...new Set(
        queue.items.map((it) => it.track.artworkUrl).filter(Boolean) as string[]
      ),
    ].slice(0, 24);
    let dead = false;
    void Promise.all(urls.map((u) => bridge.artSrc(u).catch(() => ""))).then(
      (srcs) => {
        if (dead) return;
        const m: Record<string, string> = {};
        urls.forEach((u, i) => {
          if (srcs[i]) m[u] = srcs[i];
        });
        setArtMap(m);
      }
    );
    return () => {
      dead = true;
    };
  }, [queue.items]);
  const wall = Object.values(artMap);

  // Keyboard: space toggles play, arrows seek/skip, Esc exits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Palette overlay or any editable owns the keys.
      const t = e.target as HTMLElement | null;
      if (
        t?.closest(".palette") ||
        t?.closest("input, textarea, [contenteditable]")
      )
        return;
      if (e.key === " ") {
        e.preventDefault();
        void bridge.mediaControl("play-pause");
      } else if (e.key === "ArrowRight") {
        if (e.shiftKey) void bridge.mediaControl("next");
        else void bridge.seek(pos + 10_000);
      } else if (e.key === "ArrowLeft") {
        if (e.shiftKey) void bridge.mediaControl("previous");
        else void bridge.seek(Math.max(0, pos - 10_000));
      } else if (e.key === "Escape") {
        void bridge.toggleFullscreen().then(() => nav("/"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav, pos]);

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

  const active = lyrics ? activeLyricIndex(lyrics, pos) : -1;
  const playing = np?.status === "playing";
  const line = lyrics && active >= 0 ? lyrics[active].text : null;

  // Cover carousel: a window of queue items centered on the current one.
  const ci = queue.currentIndex ?? 0;
  const covers = queue.items
    .map((it, i) => ({ it, i }))
    .filter(({ i }) => Math.abs(i - ci) <= 3)
    .map(({ it, i }) => ({
      key: it.path + i,
      src: artMap[it.track.artworkUrl],
      title: it.track.title,
      artist: it.track.artist,
      on: i === ci,
    }));

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
        {wall.length > 1 ? (
          <div className="fs__wall">
            {(wall.length < 12
              ? Array.from({ length: Math.ceil(12 / wall.length) }, () => wall).flat()
              : wall
            ).map((src, i) => (
              <img key={i} src={src} alt="" />
            ))}
          </div>
        ) : art ? (
          <img src={art} alt="" />
        ) : (
          <div className="fs__mesh" />
        )}
        <div className="fs__veil" />
      </div>
      <div className="fs__sparks" aria-hidden="true" />
      <div className="fs__rim" aria-hidden="true" />
      <div className="fs__grain" aria-hidden="true" />

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
          <button
            className="fs__qheadrow"
            onClick={() => setQueueOpen((o) => !o)}
            aria-expanded={queueOpen}
          >
            <span className="fs__qmosaic" aria-hidden="true">
              {wall.slice(0, 4).map((src, i) => (
                <img key={i} src={src} alt="" />
              ))}
            </span>
            <span className="fs__qheadtxt">
              <span className="fs__qhead">Continue Playing</span>
              <span className="fs__qsub2">
                Up next{{ local: " in your library", youtube: " on YouTube", soundcloud: " on SoundCloud", mpris: " on your player", demo: "" }[np?.source ?? "local"] ?? ""}
              </span>
            </span>
            <CaretDown
              size={13}
              className={`fs__qchev ${queueOpen ? "fs__qchev--open" : ""}`}
            />
          </button>
          {queueOpen && (
          <div className="fs__qlist">
            {queue.items.slice(0, 12).map((it, i) => (
              <button
                key={it.path + i}
                className={`fs__qrow ${i === queue.currentIndex ? "fs__qrow--on" : ""}`}
                onClick={() => void bridge.playQueueIndex(i)}
              >
                <div className="fs__qbody">
                  <QueueThumb track={it.track} />
                  <span className="fs__qtxt">
                    <span className="fs__qtitle">{it.track.title}</span>
                    <span className="fs__qsub">{it.track.artist}</span>
                  </span>
                  {i === queue.currentIndex && playing && (
                    <span className="fs__eq" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
          )}
        </aside>
      )}

      <div className="fs__center">
        {line ? (
          <div className="fs__lyric" key={active}>
            {line}
          </div>
        ) : track ? (
          <div className="fs__lyric fs__lyric--title">{track.title}</div>
        ) : (
          <div className="fs__lyric fs__lyric--title">{bridge.productName}</div>
        )}
      </div>

      {covers.length > 1 && (
        <div className="fs__covers">
          {covers.map((c) => (
            <div
              key={c.key}
              className={`fs__cover ${c.on ? "fs__cover--on" : ""}`}
            >
              {c.src ? <img src={c.src} alt="" /> : <div className="fs__cover-img fs__meta-art" style={{ width: "100%", aspectRatio: "1", borderRadius: 12 }} />}
              <div className="fs__cname">{c.title}</div>
              <div className="fs__cart">{c.artist}</div>
            </div>
          ))}
        </div>
      )}

      <div className="fs__bottom">
        <div className="fs__prog">
          <span className="fs__time">{formatTime(pos)}</span>
          <div
            className={`fs__bar ${np?.source === "local" && dur ? "" : "fs__bar--off"}`}
            role="slider"
            aria-label="Seek"
            onClick={(e) => {
              if (np?.source !== "local" || !dur) return;
              const r = e.currentTarget.getBoundingClientRect();
              const frac = (e.clientX - r.left) / r.width;
              void bridge.seek(Math.floor(frac * dur));
            }}
          >
            <div
              className="fs__barfill"
              style={{
                transform: `scaleX(${dur ? Math.min(1, pos / dur) : 0})`,
              }}
            />
            <div
              className="fs__barknob"
              style={{ left: `${dur ? Math.min(100, (pos / dur) * 100) : 0}%` }}
            />
          </div>
          <span className="fs__time">{formatTime(dur)}</span>
        </div>
        <div className="fs__pill">
          <button
            className={`fs__icon ${shuffle ? "fs__icon--on" : ""}`}
            aria-label="Shuffle"
            title="Shuffle"
            onClick={() => void bridge.setShuffle(!shuffle).then(setShuffle)}
          >
            <Shuffle size={15} weight={shuffle ? "fill" : "regular"} />
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
            {art ? (
              <img src={art} alt="" />
            ) : (
              <div className="fs__meta-art" />
            )}
            <div className="fs__meta-txt">
              <div className="fs__mtitle">{track?.title ?? "Nothing playing"}</div>
              <div className="fs__msub">
                {track ? `${track.artist} · ${track.album}` : "Start music"}
              </div>
            </div>
          </div>
          <button
            className="fs__icon"
            aria-label="Sleep timer"
            title="Sleep timer · 30 min"
            onClick={() => void bridge.setSleepTimer(30)}
          >
            <Moon size={15} />
          </button>
          <button
            className="fs__icon"
            aria-label="Settings"
            title="Settings"
            onClick={() => nav("/settings")}
          >
            <GearSix size={15} />
          </button>
          <button
            className="fs__icon"
            aria-label="Exit fullscreen"
            title="Exit fullscreen (Esc)"
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
