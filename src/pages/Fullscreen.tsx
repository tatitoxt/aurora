import { useEffect, useMemo, useRef, useState } from "react";
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
  favEntryFor,
  favKeyFor,
  favKeys,
  loadFavs,
  subscribeFavs,
  toggleFav,
  type FavEntry,
} from "../favs";
import {
  CaretDown,
  CaretUp,
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
  Plus,
  TextT,
  YoutubeLogo,
  SoundcloudLogo,
  X,
  SpotifyLogo,
  AppleLogo,
  AmazonLogo,
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import ShareCard from "../ShareCard";

const PROVIDERS = [
  { id: "youtube", label: "YouTube Music", icon: YoutubeLogo, live: true },
  { id: "soundcloud", label: "SoundCloud", icon: SoundcloudLogo, live: true },
  { id: "spotify", label: "Spotify", icon: SpotifyLogo, live: false },
  { id: "apple", label: "Apple Music", icon: AppleLogo, live: false },
  { id: "amazon", label: "Amazon Music", icon: AmazonLogo, live: false },
] as const;

const FS_STYLES = [
  { id: "albums", label: "Albums" },
  { id: "arc", label: "Arc" },
  { id: "pearl", label: "Pearl" },
  { id: "studio", label: "Studio" },
  { id: "spotlight", label: "Spotlight" },
  { id: "vision", label: "Vision" },
  { id: "dial", label: "Dial" },
  { id: "tile", label: "Tile" },
  { id: "showcase", label: "Showcase" },
] as const;

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
  const [speed, setSpeed] = useState(1.0);
  const [lyricsOn, setLyricsOn] = useState(true);
  const [streamReady, setStreamReady] = useState(false);
  const [searchSrc, setSearchSrc] = useState("youtube");
  const [searchQ, setSearchQ] = useState("");
  const [searchRes, setSearchRes] = useState<RemoteTrack[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [provOpen, setProvOpen] = useState(false);
  const [fsStyle, setFsStyle] = useState(
    () => localStorage.getItem("noctbeat.fsstyle") ?? "albums"
  );
  const [qpage, setQpage] = useState(0);
  const [favs, setFavs] = useState<FavEntry[]>(loadFavs);
  useEffect(() => subscribeFavs(() => setFavs(loadFavs())), []);
  const favSet = useMemo(() => favKeys(favs), [favs]);

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
  const panelShown = queue.items.length > 0 || streamReady;
  const qpages = Math.ceil(queue.items.length / 8);
  const qp = Math.min(qpage, Math.max(0, qpages - 1));
  const favKey = favKeyFor(np);
  const fav = favKey !== "" && favSet.has(favKey);
  const onToggleFav = () => {
    const entry = favEntryFor(np);
    if (entry) setFavs((prev) => toggleFav(prev, entry));
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
      side: i < ci ? "l" : i > ci ? "r" : "",
    }));

  const pickStyle = (s: string) => {
    setFsStyle(s);
    localStorage.setItem("noctbeat.fsstyle", s);
    setMoreOpen(false);
  };
  // Deduped albums for the spotlight/vision album rows.
  const albums: { album: string; artist: string; artworkUrl: string }[] = [];
  for (const it of queue.items) {
    if (!albums.some((a) => a.album === it.track.album)) {
      albums.push({
        album: it.track.album,
        artist: it.track.artist,
        artworkUrl: it.track.artworkUrl,
      });
    }
  }

  const hh = String(now.getHours() % 12 || 12);
  const mm = String(now.getMinutes()).padStart(2, "0");
  const date = now.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  return (
    <div className={`fs fs--${fsStyle}`}>
      <div className="fs__bg">
        {videoUrl ? (
          <FsVideo url={videoUrl} posMs={pos} playing={playing} />
        ) : fsStyle === "tile" && art ? (
          <img className="fs__tilebg" src={art} alt="" />
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
      <div className="fs__grain" aria-hidden="true" />

      <div className="fs__clockwrap">
        <div className="fs__date">{date}</div>
        <div className="fs__clock">
          {hh}
          <span className="fs__colon">:</span>
          {mm}
        </div>
      </div>

      {panelShown && (
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
          {queue.items.length > 0 && (
          <div className="fs__qlist">
            {queue.items.slice(qp * 8, qp * 8 + 8).map((it, i) => {
              const idx = qp * 8 + i;
              const current = idx === queue.currentIndex;
              return (
              <div
                key={it.path + idx}
                className={`fs__qrow ${current ? "fs__qrow--on" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => void bridge.playQueueIndex(idx)}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && e.key === "Enter")
                    void bridge.playQueueIndex(idx);
                }}
              >
                <div className="fs__qbody">
                  <QueueThumb track={it.track} />
                  <span className="fs__qtxt">
                    <span className="fs__qtitle">{it.track.title}</span>
                    <span className="fs__qsub">{it.track.artist}</span>
                  </span>
                  <span className="fs__qctl" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="fs__qctlbtn"
                      title="Move up"
                      disabled={idx === 0}
                      onClick={() => void bridge.queueMove(idx, idx - 1)}
                    >
                      <CaretUp size={11} />
                    </button>
                    <button
                      className="fs__qctlbtn"
                      title="Move down"
                      disabled={idx === queue.items.length - 1}
                      onClick={() => void bridge.queueMove(idx, idx + 1)}
                    >
                      <CaretDown size={11} />
                    </button>
                    <button
                      className="fs__qctlbtn"
                      title={current ? "Playing — can't remove" : "Remove from queue"}
                      disabled={current}
                      onClick={() => void bridge.queueRemove(idx)}
                    >
                      <X size={11} />
                    </button>
                  </span>
                  <span className="fs__qnum">{idx + 1}</span>
                  <span className="fs__qdur">
                    {it.track.durationMs ? formatTime(it.track.durationMs) : ""}
                  </span>
                  {current && playing && (
                    <span className="fs__eq" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                </div>
              </div>
              );
            })}
          </div>
          )}
          {queue.items.length > 8 && (
            <div className="fs__qdots">
              {Array.from({ length: Math.ceil(queue.items.length / 8) }, (_, p) => (
                <button
                  key={p}
                  className={`fs__qdot ${p === qp ? "fs__qdot--on" : ""}`}
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

      <div className={`fs__center ${panelShown && queueOpen ? "fs__center--panel" : ""}`}>
        {lyricsOn && !["spotlight", "vision", "dial", "tile", "showcase"].includes(fsStyle) ? (
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

      {fsStyle === "spotlight" && (
        <div className="fs__spot">
          <div className="fs__spotmain">
            <div className="fs__npcard">
              <span className="fs__npkick">Now Playing</span>
              <span className="fs__nptitle">{track?.title ?? "Nothing playing"}</span>
              <span className="fs__npsub">
                {track ? `${track.artist} · ${track.album}` : ""}
              </span>
              <span className="fs__npactions">
                <button
                  className="fs__nppause"
                  onClick={() => void bridge.mediaControl("play-pause")}
                >
                  {playing ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}
                  {playing ? "Pause" : "Play"}
                </button>
                <button
                  className={`fs__icon ${fav ? "fs__icon--on fs__icon--fav" : ""}`}
                  aria-label={fav ? "Unlike" : "Like"}
                  onClick={onToggleFav}
                >
                  <Heart size={14} weight={fav ? "fill" : "regular"} />
                </button>
              </span>
            </div>
            <div className="fs__spotart">
              {videoUrl ? (
                <FsVideo url={videoUrl} posMs={pos} playing={playing} cls="fs__cvid" />
              ) : art ? (
                <img src={art} alt="" />
              ) : null}
            </div>
          </div>
          {albums.length > 0 && (
            <div className="fs__albums">
              <span className="fs__alhead">Albums</span>
              <span className="fs__alrow">
                {albums.slice(0, 5).map((a) => (
                  <span key={a.album} className="fs__al">
                    {artMap[a.artworkUrl] ? (
                      <img src={artMap[a.artworkUrl]} alt="" />
                    ) : (
                      <span className="fs__meta-art" style={{ width: "100%", aspectRatio: "1", borderRadius: 10, display: "block" }} />
                    )}
                    <span className="fs__alname">{a.album}</span>
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>
      )}

      {fsStyle === "dial" && (
        <div className="fs__dial">
          <div className={`fs__disc ${playing ? "fs__disc--spin" : ""}`}>
            <svg className="fs__ring" viewBox="0 0 100 100" aria-hidden="true">
              <circle className="fs__ringbg" cx="50" cy="50" r="46" />
              <circle
                className="fs__ringfill"
                cx="50" cy="50" r="46"
                style={{ strokeDashoffset: 289 - 289 * (dur ? Math.min(1, pos / dur) : 0) }}
              />
            </svg>
            {art ? (
              <img className="fs__discart" src={art} alt="" />
            ) : (
              <div className="fs__discart fs__meta-art" />
            )}
            <span className="fs__discdot" />
          </div>
          <div className="fs__dialmeta">
            <span className="fs__dialtitle">{track?.title ?? "Nothing playing"}</span>
            <span className="fs__dialsub">{track ? `${track.artist} · ${track.album}` : ""}</span>
          </div>
          <div className="fs__orbit" aria-hidden="true">
            {covers
              .filter((c) => !c.on)
              .map((c, idx, arr) => {
                const angle = arr.length > 1 ? 15 + (idx * 150) / (arr.length - 1) : 90;
                return (
                  <span
                    key={c.key}
                    className="fs__orbititem"
                    style={{
                      transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(-30vh) rotate(${-angle}deg)`,
                    }}
                  >
                    {c.src ? (
                      <img src={c.src} alt="" />
                    ) : (
                      <span className="fs__meta-art" style={{ display: "block", width: "100%", aspectRatio: "1", borderRadius: 10 }} />
                    )}
                  </span>
                );
              })}
          </div>
        </div>
      )}

      {fsStyle === "vision" && (
        <div className="fs__vis">
          <div className="fs__visartist">
            <span className="fs__npkick">Artist</span>
            <span className="fs__nptitle">{track?.artist ?? "—"}</span>
            <span className="fs__npsub">
              {track ? `Playing “${track.title}”` : ""}
            </span>
            <span className="fs__npactions">
              <button
                className="fs__nppause"
                onClick={() => void bridge.mediaControl("play-pause")}
              >
                {playing ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}
                {playing ? "Pause" : "Play"}
              </button>
              <button
                className={`fs__icon ${fav ? "fs__icon--on fs__icon--fav" : ""}`}
                aria-label={fav ? "Unlike" : "Like"}
                onClick={onToggleFav}
              >
                <Heart size={14} weight={fav ? "fill" : "regular"} />
              </button>
            </span>
            <span className="fs__viscols">
              <span className="fs__viscol">
                <span className="fs__alhead">Popular</span>
                {queue.items.slice(0, 4).map((it, i) => (
                  <button
                    key={it.path + i}
                    className="fs__vrow"
                    onClick={() => void bridge.playQueueIndex(i)}
                  >
                    <span className="fs__qnum">{i + 1}</span>
                    <span className="fs__provrow">
                      <span className="fs__provtitle">{it.track.title}</span>
                      <span className="fs__provsub">{it.track.artist}</span>
                    </span>
                    <span className="fs__qdur">
                      {it.track.durationMs ? formatTime(it.track.durationMs) : ""}
                    </span>
                  </button>
                ))}
              </span>
              <span className="fs__viscol">
                <span className="fs__alhead">Albums</span>
                {albums.slice(0, 4).map((a) => (
                  <span key={a.album} className="fs__vrow">
                    {artMap[a.artworkUrl] ? (
                      <img className="fs__qthumb" src={artMap[a.artworkUrl]} alt="" />
                    ) : (
                      <span className="fs__qthumb fs__meta-art" />
                    )}
                    <span className="fs__provrow">
                      <span className="fs__provtitle">{a.album}</span>
                      <span className="fs__provsub">{a.artist}</span>
                    </span>
                  </span>
                ))}
              </span>
            </span>
          </div>
          <div className="fs__visnp">
            <span className="fs__npkick">Now Playing</span>
            {art ? <img className="fs__visart" src={art} alt="" /> : null}
            <span className="fs__nptitle">{track?.title ?? ""}</span>
            <span className="fs__npsub">{track?.artist ?? ""}</span>
            <span className="fs__vishair">
              <span className="fs__time">{formatTime(pos)}</span>
              <span className="fs__hair" style={{ flex: 1 }}>
                <span
                  className="fs__hairfill"
                  style={{ transform: `scaleX(${dur ? Math.min(1, pos / dur) : 0})`, display: "block", position: "absolute", inset: 0, transformOrigin: "left" }}
                />
              </span>
              <span className="fs__time">{formatTime(dur)}</span>
            </span>
          </div>
        </div>
      )}

      {!["spotlight", "vision", "dial", "tile", "showcase"].includes(fsStyle) && covers.length > 1 && (
        <div className={`fs__covers ${lyricsOn ? "" : "fs__covers--big"} ${panelShown && queueOpen ? "fs__covers--panel" : ""}`}>
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
              <div key={c.key} className={`fs__cover fs__cover--${c.side}`}>
                {c.src ? <img src={c.src} alt="" /> : <div className="fs__cover-img fs__meta-art" style={{ width: "100%", aspectRatio: "1", borderRadius: 12 }} />}
                <div className="fs__cname">{c.title}</div>
                <div className="fs__cart">{c.artist}</div>
              </div>
            )
          )}
        </div>
      )}

      <div className="fs__bottom">
        <div className="fs__pill">
              <span className="fs__vol">
                <button
                  className={`fs__icon ${provOpen ? "fs__icon--on" : ""}`}
                  aria-label="Music provider"
                  title="Music provider"
                  onClick={() => setProvOpen((v) => !v)}
                >
                  {searchSrc === "youtube" ? (
                    <YoutubeLogo size={16} weight="fill" />
                  ) : (
                    <SoundcloudLogo size={16} weight="fill" />
                  )}
                </button>
                {provOpen && (
                  <span className="fs__volpop fs__morepop fs__provpop">
                    {PROVIDERS.map((p) => (
                      <button
                        key={p.id}
                        className={`fs__morebtn ${searchSrc === p.id ? "fs__morebtn--on" : ""}`}
                        disabled={!p.live}
                        onClick={() => setSearchSrc(p.id)}
                      >
                        <p.icon size={14} weight="fill" /> {p.label}
                        {!p.live && <span className="fs__soon">Soon</span>}
                      </button>
                    ))}
                    <input
                      className="fs__provq"
                      value={searchQ}
                      placeholder={`Search ${PROVIDERS.find((p) => p.id === searchSrc)?.label ?? ""}…`}
                      onChange={(e) => setSearchQ(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" || !searchQ.trim() || searching) return;
                        setSearching(true);
                        setSearchErr("");
                        void bridge
                          .providerSearch(searchSrc, searchQ.trim())
                          .then(setSearchRes)
                          .catch((err) => setSearchErr(String(err)))
                          .finally(() => setSearching(false));
                      }}
                    />
                    {!streamReady && (
                      <span className="fs__proverr">
                        Streaming needs yt-dlp — install it to search providers.
                      </span>
                    )}
                    {searchErr && <span className="fs__proverr">{searchErr}</span>}
                    {searchRes.length > 0 && (
                      <span className="fs__provres">
                        {searchRes.map((t) => (
                          <button
                            key={`${t.source}:${t.id}`}
                            className="fs__morebtn"
                            onClick={() => {
                              setSearchErr("");
                              void bridge
                                .providerPlay(t)
                                .then(() => {
                                  setProvOpen(false);
                                  setSearchRes([]);
                                  setSearchQ("");
                                })
                                .catch((err) => setSearchErr(String(err)));
                            }}
                          >
                            <span className="fs__provrow">
                              <span className="fs__provtitle">{t.title}</span>
                              <span className="fs__provsub">{t.artist}</span>
                            </span>
                            <span
                              role="button"
                              tabIndex={0}
                              className="fs__provadd"
                              title="Add to queue"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSearchErr("");
                                void bridge
                                  .providerEnqueue(t)
                                  .then(() => setSearchRes([]))
                                  .catch((err) => setSearchErr(String(err)));
                              }}
                              onKeyDown={(e) => {
                                if (e.key !== "Enter" && e.key !== " ") return;
                                e.preventDefault();
                                e.stopPropagation();
                                setSearchErr("");
                                void bridge
                                  .providerEnqueue(t)
                                  .then(() => setSearchRes([]))
                                  .catch((err) => setSearchErr(String(err)));
                              }}
                            >
                              <Plus size={13} />
                            </span>
                          </button>
                        ))}
                      </span>
                    )}
                  </span>
                )}
              </span>
              <span className="fs__srcsep" />
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
          <div className="fs__metacol">
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
            {lyricsOn && (fsStyle === "tile" || fsStyle === "showcase") && line && (
              <div className="fs__cardlyric">{line}</div>
            )}
            <div
              className={`fs__hair ${np?.source === "local" && dur ? "" : "fs__hair--off"}`}
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
                className="fs__hairfill"
                style={{ transform: `scaleX(${dur ? Math.min(1, pos / dur) : 0})` }}
              />
            </div>
          </div>
          <button
            className={`fs__icon ${fav ? "fs__icon--on fs__icon--fav" : ""}`}
            aria-label={fav ? "Unlike" : "Like"}
            title={fav ? "Unlike" : "Like"}
            onClick={onToggleFav}
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
                <span className="fs__stylehead">Speed</span>
                {([
                  ["Slowed", 0.8],
                  ["Normal", 1.0],
                  ["Nightcore", 1.25],
                ] as Array<[string, number]>).map(([label, v]) => (
                  <button
                    key={label}
                    className={`fs__morebtn ${speed === v ? "fs__morebtn--on" : ""}`}
                    onClick={() => { setSpeed(v); void bridge.setSpeed(v); }}
                  >
                    {label} {v}×
                  </button>
                ))}
                <button className="fs__morebtn" onClick={() => nav("/settings")}>
                  <GearSix size={13} /> Settings
                </button>
                <button
                  className="fs__morebtn"
                  onClick={() => void bridge.toggleFullscreen().then(() => nav("/"))}
                >
                  <CornersIn size={13} /> Exit fullscreen
                </button>
                <span className="fs__stylehead">Style</span>
                {FS_STYLES.map((s) => (
                  <button
                    key={s.id}
                    className={`fs__morebtn ${fsStyle === s.id ? "fs__morebtn--on" : ""}`}
                    onClick={() => pickStyle(s.id)}
                  >
                    {s.label}
                  </button>
                ))}
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
