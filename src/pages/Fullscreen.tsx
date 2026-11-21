import { type CSSProperties } from "react";
import { useT } from "../i18n";
import { useLyricAnim } from "../lyricanim";
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
import { activeLyricIndex, adlibSegments, formatTime } from "../lib";
import {
  lyricOffsetFor,
  setLyricOffset,
  subscribeLyroff,
} from "../lyroff";
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
  CornersIn,
  Export,
  GearSix,
  LockSimple,
  LockSimpleOpen,
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
  Playlist,
  TextT,
  YoutubeLogo,
  SoundcloudLogo,
  SpotifyLogo,
  AppleLogo,
  AmazonLogo,
  TidalLogo,
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import ShareCard from "../ShareCard";
import AmbientBg from "../AmbientBg";

const PROVIDERS = [
  { id: "youtube", label: "YouTube Music", icon: YoutubeLogo, live: true },
  { id: "soundcloud", label: "SoundCloud", icon: SoundcloudLogo, live: true },
  { id: "spotify", label: "Spotify", icon: SpotifyLogo, live: false },
  { id: "apple", label: "Apple Music", icon: AppleLogo, live: false },
  { id: "tidal", label: "Tidal", icon: TidalLogo, live: false },
  { id: "amazon", label: "Amazon Music", icon: AmazonLogo, live: false },
] as const;

/** Provider host reported by the browser extension → friendly label + picker id. */
const EXT_HOSTS: [RegExp, string, string][] = [
  [/(music|www)\.youtube\.com/, "YouTube Music", "youtube"],
  [/open\.spotify\.com/, "Spotify", "spotify"],
  [/soundcloud\.com/, "SoundCloud", "soundcloud"],
  [/music\.apple\.com/, "Apple Music", "apple"],
  [/listen\.tidal\.com/, "Tidal", "tidal"],
  [/music\.amazon\./, "Amazon Music", "amazon"],
];
const extLabel = (host: string) =>
  EXT_HOSTS.find(([re]) => re.test(host))?.[1] ?? host;
/** provider id of the currently live extension tab, if it maps to a picker row */
const extProviderId = (host: string | null | undefined) =>
  (host && EXT_HOSTS.find(([re]) => re.test(host))?.[2]) ?? null;

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
  const t = useT();
  const lanim = useLyricAnim();
  const nav = useNavigate();
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [lyrics, setLyrics] = useState<LrcLine[] | null>(null);
  const [queue, setQueue] = useState<QueueState>({ items: [], currentIndex: null });
  const [art, setArt] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [shuffle, setShuffle] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [repeat, setRepeat] = useState<"off" | "all" | "one">("off");
  const [vol, setVol] = useState(1);
  const [volOpen, setVolOpen] = useState(false);
  const [share, setShare] = useState(false);
  const [speed, setSpeed] = useState(1.0);
  const [lyricsOn, setLyricsOn] = useState(true);
  const [timingOpen, setTimingOpen] = useState(false);
  const [streamReady, setStreamReady] = useState(false);
  const [searchSrc, setSearchSrc] = useState("youtube");
  const [ext, setExt] = useState<{ tabs: number; provider: string | null } | null>(null);
  const [searchQ, setSearchQ] = useState("");
  const [searchRes, setSearchRes] = useState<RemoteTrack[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [provOpen, setProvOpen] = useState(false);
  const [fsStyle, setFsStyle] = useState(
    () => localStorage.getItem("noctbeat.fsstyle") ?? "albums"
  );
  const [coverScale, setCoverScale] = useState(() => {
    const v = parseFloat(localStorage.getItem("noctbeat.fscss") ?? "100");
    return Number.isFinite(v) ? Math.min(160, Math.max(60, v)) : 100;
  });
  const [clockScale, setClockScale] = useState(() => {
    const v = parseFloat(localStorage.getItem("noctbeat.fsclocksc") ?? "100");
    return Number.isFinite(v) ? Math.min(160, Math.max(60, v)) : 100;
  });
  const [lyricScale, setLyricScale] = useState(() => {
    const v = parseFloat(localStorage.getItem("noctbeat.fslyrsc") ?? "100");
    return Number.isFinite(v) ? Math.min(160, Math.max(60, v)) : 100;
  });
  const [scaleLock, setScaleLock] = useState(
    () => localStorage.getItem("noctbeat.fslock") === "1"
  );
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

  /* Refresh the bridge state each time the picker opens — tabs can
     connect or go quiet while fullscreen stays mounted. */
  useEffect(() => {
    if (!provOpen) return;
    bridge
      .getExtStatus()
      .then(setExt)
      .catch(() => {});
  }, [provOpen]);

  const track = np?.track ?? null;
  const pos = np?.positionMs ?? 0;
  const dur = track?.durationMs ?? 0;
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
        // Buttons (incl. role=button lyrics) own Space themselves.
        if (t?.closest("button, [role='button']")) return;
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

  const [lyroffTick, setLyroffTick] = useState(0);
  useEffect(() => subscribeLyroff(() => setLyroffTick((t) => t + 1)), []);
  void lyroffTick;
  const lyroff = lyricOffsetFor(np);
  const active = lyrics ? activeLyricIndex(lyrics, pos + lyroff) : -1;

  // Close the timing editor when the playing track changes — its nudges
  // would otherwise save to the new track instead of the edited one.
  const timingKey = np?.track ? `${np.source}:${np.track.id}` : "";
  const prevTimingKey = useRef(timingKey);
  useEffect(() => {
    if (prevTimingKey.current !== timingKey) {
      prevTimingKey.current = timingKey;
      setTimingOpen(false);
    }
  }, [timingKey]);
  const playing = np?.status === "playing";
  const line = lyrics && active >= 0 ? lyrics[active].text : null;
  const lineTokens = line ? adlibSegments(line) : null;

  // Cover carousel: a window of queue items centered on the current one.
  const ci = queue.currentIndex ?? 0;
  const covers = queue.items
    .map((it, i) => ({ it, i }))
    .map(({ it, i }) => ({
      key: it.path + i,
      i,
      src: artMap[it.track.artworkUrl],
      title: it.track.title,
      artist: it.track.artist,
      on: i === ci,
      side: i < ci ? "l" : i > ci ? "r" : "",
    }));

  /* Scroll the carousel so the playing cover stays centered; clicking a
     side cover jumps the queue to that index. */
  const coversRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    coversRef.current
      ?.querySelector(".fs__cover--on")
      ?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [ci, queue.items.length]);

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
    <div
      className={`fs fs--${fsStyle}`}
      style={{
        "--cscale": coverScale / 100,
        "--clksc": clockScale / 100,
        "--lyrsc": lyricScale / 100,
      } as CSSProperties}
    >
      <div className="fs__bg">
        {videoUrl ? (
          <FsVideo url={videoUrl} posMs={pos} playing={playing} />
        ) : fsStyle === "tile" && art ? (
          <img className="fs__tilebg" src={art} alt="" />
        ) : wall.length > 1 ? (
          <div className="fs__wall">
            {(wall.length < 24
              ? Array.from({ length: Math.ceil(24 / wall.length) }, () => wall).flat()
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
        {settings.ambientBg && !videoUrl && <AmbientBg />}
      </div>
      <div className="fs__grain" aria-hidden="true" />

      <div className="fs__clockwrap">
        <div className="fs__date">{date}</div>
        <div className="fs__clock">
          {hh}
          <span className="fs__colon"><i /><i /></span>
          {mm}
        </div>
      </div>


      <div className="fs__center">
        {lyricsOn && !["spotlight", "vision", "dial", "tile", "showcase"].includes(fsStyle) ? (
          line ? (
            <div className="fs__lyrics">
              {active > 0 && (
                <div className="fs__lyrctx fs__lyrctx--up" key={`p${active}`}>
                  {adlibSegments(lyrics![active - 1].text).map((s) => s.text).join("")}
                </div>
              )}
              <div
                className={`fs__lyric ${lanim}`}
                key={active}
                role="button"
                tabIndex={0}
                onClick={() => setTimingOpen((v) => !v)}
                onContextMenu={(e) => { e.preventDefault(); setTimingOpen((v) => !v); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setTimingOpen((v) => !v); } }}
              >
                {lineTokens!.map((s, i) =>
                  s.adlib ? (
                    <span key={i} className="adlib fsword" style={{ "--i": i } as CSSProperties}>
                      {s.text}
                    </span>
                  ) : (
                    <span key={i} className="fsword" style={{ "--i": i } as CSSProperties}>
                      {s.text}
                    </span>
                  ),
                )}
              </div>
              {lyrics && active + 1 < lyrics.length && (
                <div className="fs__lyrctx fs__lyrctx--dn" key={`n${active}`}>
                  {adlibSegments(lyrics[active + 1].text).map((s) => s.text).join("")}
                </div>
              )}
            </div>
          ) : track ? (
            <div className="fs__lyric fs__lyric--title">{track.title}</div>
          ) : (
            <div className="fs__lyric fs__lyric--title">{bridge.productName}</div>
          )
        ) : null}
        {timingOpen && (
          <span className="fs__timing">
            {([-200, -50, 50, 200] as number[]).map((d) => (
              <button
                key={d}
                className="fs__morebtn"
                onClick={() => setLyricOffset(np, lyroff + d)}
              >
                {d > 0 ? `+${d}` : d}ms
              </button>
            ))}
            <button
              className="fs__morebtn"
              onClick={() => { setLyricOffset(np, 0); setTimingOpen(false); }}
            >
              Reset{lyroff !== 0 ? ` (${lyroff > 0 ? "+" : ""}${lyroff}ms)` : ""}
            </button>
          </span>
        )}
      </div>

      {fsStyle === "spotlight" && (
        <div className="fs__spot">
          <div className="fs__spotmain">
            <div className="fs__npcard">
              <span className="fs__npkick">{t("fs.nowPlaying")}</span>
              <span className="fs__nptitle">{track?.title ?? t("fs.nothingPlaying")}</span>
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
          <div className="fs__halo">
            <svg className="fs__hring" viewBox="0 0 100 100" aria-hidden="true">
              <rect className="fs__hringbg" x="4" y="4" width="92" height="92" rx="26" pathLength="100" />
              <rect
                className="fs__hringfill"
                x="4" y="4" width="92" height="92" rx="26" pathLength="100"
                style={{ strokeDashoffset: 100 - 100 * (dur ? Math.min(1, pos / dur) : 0) }}
              />
            </svg>
            {videoUrl ? (
              <FsVideo url={videoUrl} posMs={pos} playing={playing} cls="fs__haloart" />
            ) : art ? (
              <img className="fs__haloart" src={art} alt="" />
            ) : (
              <div className="fs__haloart fs__meta-art" />
            )}
          </div>
          <div className="fs__dialmeta">
            <span className="fs__dialtitle">{track?.title ?? t("fs.nothingPlaying")}</span>
            <span className="fs__dialsub">{track ? `${track.artist} · ${track.album}` : ""}</span>
          </div>
          <div className="fs__dialstrip">
            {covers
              .filter((c) => !c.on)
              .map((c, idx) => (
                <button
                  key={c.key}
                  className="fs__striptumb"
                  style={{ "--i": idx } as CSSProperties}
                  onClick={() => void bridge.playQueueIndex(c.i)}
                  title={c.title}
                >
                  {c.src ? (
                    <img src={c.src} alt="" />
                  ) : (
                    <span className="fs__meta-art" style={{ display: "block", width: "100%", aspectRatio: "1", borderRadius: 10 }} />
                  )}
                </button>
              ))}
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
            <span className="fs__npkick">{t("fs.nowPlaying")}</span>
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
        <div
          ref={coversRef}
          className={`fs__covers ${lyricsOn ? "" : "fs__covers--big"}`}
          onWheel={(e) => {
            // horizontal scroll on any wheel axis; pure browsing — no track change
            const el = coversRef.current;
            if (el) el.scrollLeft += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
          }}
          onPointerDown={(e) => {
            const el = coversRef.current;
            if (!el) return;
            e.preventDefault(); // stop native image/text dragging
            const sx = e.clientX, sl = el.scrollLeft;
            let moved = false;
            const move = (ev: PointerEvent) => {
              const dx = ev.clientX - sx;
              if (Math.abs(dx) > 6) moved = true;
              el.scrollLeft = sl - dx;
            };
            const end = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", end);
              window.removeEventListener("pointercancel", end);
              // A real drag must not count as a click on the cover under it.
              if (moved) {
                const cap = (ce: Event) => { ce.stopPropagation(); ce.preventDefault(); };
                el.addEventListener("click", cap, { capture: true, once: true });
                window.setTimeout(() => el.removeEventListener("click", cap, { capture: true }), 400);
              }
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", end);
            window.addEventListener("pointercancel", end);
          }}
        >
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
              <button
                key={c.key}
                className={`fs__cover fs__cover--${c.side}`}
                style={{ "--i": Math.min(Math.abs(c.i - ci), 4) } as CSSProperties}
                onClick={() => void bridge.playQueueIndex(c.i)}
                title={`${c.title} — ${c.artist}`}
              >
                {c.src ? <img src={c.src} alt="" /> : <div className="fs__cover-img fs__meta-art" style={{ width: "100%", aspectRatio: "1", borderRadius: 12 }} />}
                <div className="fs__cname">{c.title}</div>
                <div className="fs__cart">{c.artist}</div>
              </button>
            )
          )}
        </div>
      )}

      {fsStyle === "studio" && queue.items.length > 0 && (
        <div className="fs__studioq">
          <span className="fs__alhead">{t("fs.upNext")}</span>
          {queue.items.map((it, i) => (
            <button
              key={it.path + i}
              className={`fs__vrow ${i === queue.currentIndex ? "fs__vrow--on" : ""}`}
              onClick={() => void bridge.playQueueIndex(i)}
            >
              <span className="fs__qnum">{i + 1}</span>
              {artMap[it.track.artworkUrl] ? (
                <img className="fs__qthumb" src={artMap[it.track.artworkUrl]} alt="" />
              ) : (
                <span className="fs__qthumb fs__meta-art" />
              )}
              <span className="fs__provrow">
                <span className="fs__provtitle">{it.track.title}</span>
                <span className="fs__provsub">{it.track.artist}</span>
              </span>
              <span className="fs__qdur">
                {it.track.durationMs ? formatTime(it.track.durationMs) : ""}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="fs__bottom">
        <div className="fs__pill">
              <span className="fs__vol">
                <button
                  className={`fs__icon ${provOpen ? "fs__icon--on" : ""}`}
                  aria-label={t("fs.provider")}
                  title={t("fs.provider")}
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
                    {ext && ext.tabs > 0 ? (
                      <span className="fs__extlive">
                        Browser bridge · {ext.provider ? extLabel(ext.provider) : "connected"} ●
                        live
                      </span>
                    ) : (
                      <span className="fs__extlive fs__extlive--off">
                        {t("fs.extHint")}
                        <br />
                        {t("fs.extStep1")}
                        <br />
                        {bridge.isTauri() ? (
                          t("fs.extStep2")
                        ) : (
                          <a href="noctbeat-bridge.zip" download className="fs__extdl">
                            ↓ {t("fs.extDownload")}
                          </a>
                        )}
                      </span>
                    )}
                    {PROVIDERS.map((p) => {
                      const viaExt = !p.live && p.id === extProviderId(ext?.provider);
                      return (
                        <button
                          key={p.id}
                          className={`fs__morebtn ${searchSrc === p.id ? "fs__morebtn--on" : ""}`}
                          disabled={!p.live}
                          onClick={() => setSearchSrc(p.id)}
                        >
                          <p.icon size={14} weight="fill" /> {p.label}
                          {viaExt ? (
                            <span className="fs__soon fs__soon--live">●</span>
                          ) : (
                            !p.live && <span className="fs__soon">Soon</span>
                          )}
                        </button>
                      );
                    })}
                    <input
                      className="fs__provq"
                      value={searchQ}
                      placeholder={t("fs.search", { src: PROVIDERS.find((p) => p.id === searchSrc)?.label ?? "" })}
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
                        {searchRes.map((trk) => (
                          <button
                            key={`${trk.source}:${trk.id}`}
                            className="fs__morebtn"
                            onClick={() => {
                              setSearchErr("");
                              void bridge
                                .providerPlay(trk)
                                .then(() => {
                                  setProvOpen(false);
                                  setSearchRes([]);
                                  setSearchQ("");
                                })
                                .catch((err) => setSearchErr(String(err)));
                            }}
                          >
                            <span className="fs__provrow">
                              <span className="fs__provtitle">{trk.title}</span>
                              <span className="fs__provsub">{trk.artist}</span>
                            </span>
                            <span
                              role="button"
                              tabIndex={0}
                              className="fs__provadd"
                              title={t("fs.addToQueue")}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSearchErr("");
                                void bridge
                                  .providerEnqueue(trk)
                                  .then(() => setSearchRes([]))
                                  .catch((err) => setSearchErr(String(err)));
                              }}
                              onKeyDown={(e) => {
                                if (e.key !== "Enter" && e.key !== " ") return;
                                e.preventDefault();
                                e.stopPropagation();
                                setSearchErr("");
                                void bridge
                                  .providerEnqueue(trk)
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
            title={t("fs.shuffle")}
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
            title={t("fs.repeat", { mode: repeat })}
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
                <div className="fs__mtitle">{track?.title ?? t("fs.nothingPlaying")}</div>
                <div className="fs__msub">
                  {track ? `${track.artist} · ${track.album}` : t("fs.startMusic")}
                </div>
              </div>
            </div>
            {lyricsOn && (fsStyle === "tile" || fsStyle === "showcase") && line && (
              <div
                className="fs__cardlyric"
                role="button"
                tabIndex={0}
                onClick={() => setTimingOpen((v) => !v)}
                onContextMenu={(e) => { e.preventDefault(); setTimingOpen((v) => !v); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setTimingOpen((v) => !v); } }}
              >
                {lineTokens!.map((s, i) =>
                  s.adlib ? (
                    <span key={i} className="adlib">
                      {s.text}
                    </span>
                  ) : (
                    s.text
                  ),
                )}
              </div>
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
            title={fav ? t("fs.unlike") : t("fs.like")}
            onClick={onToggleFav}
          >
            <Heart size={15} weight={fav ? "fill" : "regular"} />
          </button>
          <button
            className={`fs__icon ${lyricsOn ? "fs__icon--on" : ""}`}
            aria-label={t("fs.lyricsToggle")}
            title={t("fs.lyricsToggle")}
            onClick={() => setLyricsOn((v) => !v)}
          >
            <TextT size={15} />
          </button>
          <span className="fs__vol">
            <button
              className={`fs__icon ${vol === 0 ? "fs__icon--on" : ""}`}
              aria-label="Volume"
              title={t("fs.volume")}
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
              aria-label={t("fs.more")}
              title={t("fs.more")}
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
                <button className="fs__morebtn" onClick={() => nav("/library")}>
                  <Playlist size={13} /> {t("nav.library")}
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
                <span className="fs__stylehead">{t("fs.size")}</span>
                <span className="fs__sizerow">
                  <input
                    type="range" min={60} max={160} step={5}
                    className="fs__sizeslider"
                    value={coverScale}
                    disabled={scaleLock}
                    aria-label={t("fs.size")}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setCoverScale(v);
                      localStorage.setItem("noctbeat.fscss", String(v));
                    }}
                  />
                  <button
                    className={`fs__icon fs__sizelock ${scaleLock ? "fs__icon--on" : ""}`}
                    aria-label={scaleLock ? t("fs.unlockSize") : t("fs.lockSize")}
                    title={scaleLock ? t("fs.unlockSize") : t("fs.lockSize")}
                    onClick={() => {
                      setScaleLock((v) => {
                        localStorage.setItem("noctbeat.fslock", v ? "0" : "1");
                        return !v;
                      });
                    }}
                  >
                    {scaleLock ? <LockSimple size={13} /> : <LockSimpleOpen size={13} />}
                  </button>
                </span>
                <span className="fs__sizerow">
                  <input
                    type="range" min={60} max={160} step={5}
                    className="fs__sizeslider"
                    value={clockScale}
                    disabled={scaleLock}
                    aria-label={t("fs.clockSize")}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setClockScale(v);
                      localStorage.setItem("noctbeat.fsclocksc", String(v));
                    }}
                  />
                </span>
                <span className="fs__sizerow">
                  <input
                    type="range" min={60} max={160} step={5}
                    className="fs__sizeslider"
                    value={lyricScale}
                    disabled={scaleLock}
                    aria-label={t("fs.lyricSize")}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setLyricScale(v);
                      localStorage.setItem("noctbeat.fslyrsc", String(v));
                    }}
                  />
                </span>
                <span className="fs__stylehead">{t("fs.soundFx")}</span>
                {([
                  ["Off", "off"],
                  ["Reverb", "reverb"],
                  ["8D Audio", "8d"],
                  ["Echo", "echo"],
                ] as Array<[string, string]>).map(([label, m]) => (
                  <button
                    key={m}
                    className={`fs__morebtn ${settings.soundFx === m ? "fs__morebtn--on" : ""}`}
                    onClick={() => void bridge.setFx(m)}
                  >
                    {label}
                  </button>
                ))}
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
