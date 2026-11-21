import { useEffect, useRef, useState } from "react";
import {
  bridge,
  subscribe,
  DEFAULT_SETTINGS,
  type NowPlaying,
  type LrcLine,
  type QueueState,
  type RemoteTrack,
  type Settings,
} from "../bridge";
import { activeLyricIndex, formatTime } from "../lib";
import {
  CaretDown,
  CornersIn,
  Export,
  GearSix,
  Queue,
  Moon,
  Pause,
  Play,
  Repeat,
  RepeatOnce,
  Shuffle,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SpeakerX,
  DotsThree,
  Heart,
  TextT,
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import ShareCard from "../ShareCard";

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

/** Sharp video backdrop for the iBaila "albums" background: muted, synced to
 * the track position, faded in once it can play. */
function FsVideo({
  url,
  posMs,
  playing,
  cls = "fs__video",
}: {
  url: string;
  posMs: number;
  playing: boolean;
  cls?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (playing) void v.play().catch(() => {});
    else v.pause();
  }, [playing, url]);

  useEffect(() => {
    const v = ref.current;
    if (!v || !ready) return;
    const target = Math.min(posMs / 1000, v.duration || Infinity);
    if (Math.abs(v.currentTime - target) > 0.6) v.currentTime = target;
  }, [posMs, ready]);

  return (
    <video
      ref={ref}
      className={`${cls} ${ready ? "fs__video--ready" : ""}`}
      src={url}
      muted
      playsInline
      onCanPlay={() => setReady(true)}
    />
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
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [repeat, setRepeat] = useState<"off" | "all" | "one">("off");
  const [vol, setVol] = useState(1);
  const [volOpen, setVolOpen] = useState(false);
  const [share, setShare] = useState(false);
  const [lyricsOn, setLyricsOn] = useState(true);
  const [streamReady, setStreamReady] = useState(false);
  const [searchSrc, setSearchSrc] = useState("youtube");
  const [searchQ, setSearchQ] = useState("");
  const [searchRes, setSearchRes] = useState<RemoteTrack[]>([]);
  const [searching, setSearching] = useState(false);
  const [queueErr, setQueueErr] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [qpage, setQpage] = useState(0);
  const [favs, setFavs] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("noctbeat.favs") ?? "[]"));
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    bridge.getNowPlaying().then(setNp);
    bridge.getQueue().then(setQueue);
    bridge.getShuffle().then(setShuffle);
    bridge.getRepeat().then(setRepeat);
    bridge.getVolume().then(setVol);
    bridge.getSettings().then(setSettings);
    bridge.providerStatus().then(setStreamReady);
    const off = subscribe<NowPlaying>("now-playing", setNp);
    const offQ = subscribe<QueueState>("queue", setQueue);
    const offS = subscribe<Settings>("settings", setSettings);
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => {
      off();
      offQ();
      offS();
      clearInterval(clock);
    };
  }, []);

  const track = np?.track ?? null;
  const pos = np?.positionMs ?? 0;
  const dur = track?.durationMs ?? 0;
  const favKey = track ? `${np?.source ?? ""}:${track.id}` : "";
  const fav = favKey !== "" && favs.has(favKey);
  const toggleFav = () => {
    if (!favKey) return;
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(favKey)) next.delete(favKey);
      else next.add(favKey);
      localStorage.setItem("noctbeat.favs", JSON.stringify([...next]));
      return next;
    });
  };

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

  // iBaila "albums" backdrop: the music video plays sharp behind everything.
  // Resolved once per track (track?.id dep — np object changes every tick),
  // only when the video-backdrop setting is on. Falls back to the art wall.
  const wantVideo = settings.videoBackdrop;
  const trackKey = track?.id ?? null;
  useEffect(() => {
    setVideoUrl(null);
    if (!wantVideo || !trackKey || !track) return;
    let stale = false;
    bridge.resolveVideo(track.artist, track.title).then((u) => {
      if (!stale && u) setVideoUrl(u);
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantVideo, trackKey]);

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
        {videoUrl ? (
          <FsVideo url={videoUrl} posMs={pos} playing={playing} />
        ) : wall.length > 1 ? (
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

      {(queue.items.length > 0 || streamReady) && (
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
          <>
          {streamReady && (
            <div className="fs__qsearch">
              <div className="fs__qseg">
                {(["youtube", "soundcloud"] as const).map((s) => (
                  <button
                    key={s}
                    className={searchSrc === s ? "on" : ""}
                    onClick={() => setSearchSrc(s)}
                  >
                    {s === "youtube" ? "YouTube" : "SoundCloud"}
                  </button>
                ))}
              </div>
              <input
                value={searchQ}
                placeholder="Search tracks…"
                onChange={(e) => setSearchQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !searchQ.trim() || searching) return;
                  setSearching(true);
                  setQueueErr("");
                  void bridge
                    .providerSearch(searchSrc, searchQ.trim())
                    .then(setSearchRes)
                    .catch((err) => setQueueErr(String(err)))
                    .finally(() => setSearching(false));
                }}
              />
              {queueErr && <span className="fs__qerr">{queueErr}</span>}
              <div className="fs__qresults">
              {searchRes.map((t) => (
                <button
                  key={`${t.source}:${t.id}`}
                  className="fs__qrow"
                  onClick={() => {
                    setQueueErr("");
                    void bridge.providerPlay(t).catch((e) => setQueueErr(String(e)));
                  }}
                >
                  <div className="fs__qbody">
                    <span className="fs__qtxt">
                      <span className="fs__qtitle">{t.title}</span>
                      <span className="fs__qsub">{t.artist}</span>
                    </span>
                  </div>
                </button>
              ))}
              </div>
            </div>
          )}
          {queue.items.length > 0 && (
          <div className="fs__qlist">
            {queue.items.slice(qpage * 8, qpage * 8 + 8).map((it, i) => (
              <button
                key={it.path + (qpage * 8 + i)}
                className={`fs__qrow ${qpage * 8 + i === queue.currentIndex ? "fs__qrow--on" : ""}`}
                onClick={() => void bridge.playQueueIndex(qpage * 8 + i)}
              >
                <div className="fs__qbody">
                  <QueueThumb track={it.track} />
                  <span className="fs__qtxt">
                    <span className="fs__qtitle">{it.track.title}</span>
                    <span className="fs__qsub">{it.track.artist}</span>
                  </span>
                  {qpage * 8 + i === queue.currentIndex && playing && (
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
          {queue.items.length > 8 && (
            <div className="fs__qdots">
              {Array.from({ length: Math.ceil(queue.items.length / 8) }, (_, p) => (
                <button
                  key={p}
                  className={`fs__qdot ${p === qpage ? "fs__qdot--on" : ""}`}
                  aria-label={`Queue page ${p + 1}`}
                  onClick={() => setQpage(p)}
                />
              ))}
            </div>
          )}
          </>
          )}
        </aside>
      )}

      <div className="fs__center">
        {lyricsOn ? (
          line ? (
            <div className="fs__lyric" key={active}>
              {line}
            </div>
          ) : track ? (
            <div className="fs__lyric fs__lyric--title">{track.title}</div>
          ) : (
            <div className="fs__lyric fs__lyric--title">{bridge.productName}</div>
          )
        ) : null}
      </div>

      {covers.length > 1 && (
        <div className={`fs__covers ${lyricsOn ? "" : "fs__covers--big"}`}>
          {covers.map((c) =>
            c.on ? (
              /* iBaila center card: video/art inside, meta overlaid on scrim. */
              <div key={c.key} className="fs__cover fs__cover--on">
                <div className="fs__coverimg">
                  {videoUrl ? (
                    <FsVideo url={videoUrl} posMs={pos} playing={playing} cls="fs__cvid" />
                  ) : c.src ? (
                    <img src={c.src} alt="" />
                  ) : (
                    <div className="fs__meta-art" style={{ width: "100%", height: "100%" }} />
                  )}
                  <div className="fs__cscrim" />
                  <div className="fs__cvmeta">
                    <div className="fs__cvtitle">{c.title}</div>
                    <div className="fs__cvart">{c.artist}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div key={c.key} className="fs__cover">
                {c.src ? <img src={c.src} alt="" /> : <div className="fs__cover-img fs__meta-art" style={{ width: "100%", aspectRatio: "1", borderRadius: 12 }} />}
                <div className="fs__cname">{c.title}</div>
                <div className="fs__cart">{c.artist}</div>
              </div>
            )
          )}
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
          <button
            className={`fs__icon ${repeat !== "off" ? "fs__icon--on" : ""}`}
            aria-label={`Repeat: ${repeat}`}
            title={`Repeat: ${repeat}`}
            onClick={() => {
              const next = repeat === "off" ? "all" : repeat === "all" ? "one" : "off";
              void bridge.setRepeat(next).then((m) => setRepeat(m as "off" | "all" | "one"));
            }}
          >
            {repeat === "one" ? <RepeatOnce size={15} weight="fill" /> : <Repeat size={15} weight={repeat === "all" ? "fill" : "regular"} />}
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
            className={`fs__icon ${fav ? "fs__icon--on fs__icon--fav" : ""}`}
            aria-label={fav ? "Unlike" : "Like"}
            title={fav ? "Unlike" : "Like"}
            onClick={toggleFav}
          >
            <Heart size={15} weight={fav ? "fill" : "regular"} />
          </button>
          <button
            className={`fs__icon ${lyricsOn ? "fs__icon--on" : ""}`}
            aria-label="Toggle lyrics"
            title="Lyrics / thumbnails"
            onClick={() => setLyricsOn((v) => !v)}
          >
            <TextT size={15} />
          </button>
          <button
            className={`fs__icon ${queueOpen ? "fs__icon--on" : ""}`}
            aria-label="Toggle queue panel"
            title="Continue Playing panel"
            onClick={() => setQueueOpen((v) => !v)}
          >
            <Queue size={15} />
          </button>
          <span className="fs__vol">
            <button
              className={`fs__icon ${vol === 0 ? "fs__icon--on" : ""}`}
              aria-label="Volume"
              title="Volume"
              onClick={() => setVolOpen((v) => !v)}
            >
              {vol === 0 ? <SpeakerX size={15} /> : <SpeakerHigh size={15} />}
            </button>
            {volOpen && (
              <span className="fs__volpop">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(vol * 100)}
                  aria-label="Volume"
                  onChange={(e) => {
                    const v = Number(e.target.value) / 100;
                    setVol(v);
                    void bridge.setVolume(v);
                  }}
                />
              </span>
            )}
          </span>
          <span className="fs__vol">
            <button
              className={`fs__icon ${moreOpen ? "fs__icon--on" : ""}`}
              aria-label="More actions"
              title="More"
              onClick={() => setMoreOpen((v) => !v)}
            >
              <DotsThree size={17} weight="bold" />
            </button>
            {moreOpen && (
              <span className="fs__volpop fs__morepop">
                <button className="fs__morebtn" onClick={() => { setShare(true); setMoreOpen(false); }}>
                  <Export size={13} /> Share
                </button>
                <button className="fs__morebtn" onClick={() => { void bridge.setSleepTimer(30); setMoreOpen(false); }}>
                  <Moon size={13} /> Sleep 30 min
                </button>
                <button className="fs__morebtn" onClick={() => nav("/settings")}>
                  <GearSix size={13} /> Settings
                </button>
                <button
                  className="fs__morebtn"
                  onClick={() => void bridge.toggleFullscreen().then(() => nav("/"))}
                >
                  <CornersIn size={13} /> Exit fullscreen
                </button>
              </span>
            )}
          </span>
        </div>
      </div>
      {share && (
        <ShareCard track={track} artUrl={art} posMs={pos} onClose={() => setShare(false)} />
      )}
    </div>
  );
}
