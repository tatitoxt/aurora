import { useT } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { VideoBackdrop } from "../VideoBackdrop";
import {
  bridge,
  subscribe,
  DEFAULT_SETTINGS,
  type NowPlaying,
  type Settings,
  type QueueState,
  type LrcLine,
} from "../bridge";
import {
  Monitor,
  PushPin,
  SkipBack,
  SkipForward,
  Pause,
  Play,
  X,
  Heart,
  ListBullets,
  MusicNote,
  Image,
  Subtitles,
} from "@phosphor-icons/react";
import { LineLyrics } from "../Lyrics";
import { activeLyricIndex } from "../lib";
import { lyricOffsetFor, subscribeLyroff } from "../lyroff";
import {
  favEntryFor,
  favKeyFor,
  favKeys,
  loadFavs,
  subscribeFavs,
  toggleFav,
  type FavEntry,
} from "../favs";

function fmt(ms: number | undefined) {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The HUD is a single picture-in-picture surface: clock on top, a square
 * that swaps between the artwork and the videoclip (lyrics can overlay
 * either), title + hairline progress, and the transport row. The player
 * window hides while the HUD is up — never both at once. */
export default function Hud() {
  const t = useT();
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [queue, setQueue] = useState<QueueState>({ items: [], currentIndex: null });
  const [art, setArt] = useState("");
  const [artMap, setArtMap] = useState<Record<string, string>>({});
  const [favs, setFavs] = useState<FavEntry[]>(loadFavs);
  const [queueOpen, setQueueOpen] = useState(false);
  const [mediaMode, setMediaMode] = useState<"art" | "video">(
    () => (localStorage.getItem("noctbeat.hudmedia") as "art" | "video") || "art",
  );
  const [lyricsOn, setLyricsOn] = useState(
    () => localStorage.getItem("noctbeat.hudlyrics") !== "0",
  );
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [lyrics, setLyrics] = useState<LrcLine[] | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const videoReq = useRef(0);

  // PiP clock — small, filled, above the thumbnail.
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    bridge.getNowPlaying().then(setNp);
    bridge.getSettings().then(setSettings);
    bridge.getQueue().then(setQueue);
    const offNp = subscribe<NowPlaying>("now-playing", setNp);
    const offS = subscribe<Settings>("settings", setSettings);
    const offQ = subscribe<QueueState>("queue", setQueue);
    const offFavs = subscribeFavs(() => setFavs(loadFavs()));
    return () => {
      offNp();
      offS();
      offQ();
      offFavs();
    };
  }, []);

  const track = np?.track ?? null;
  const trackKey = track?.id ?? null;
  const artworkUrl = track?.artworkUrl ?? null;
  const [lyroffTick, setLyroffTick] = useState(0);
  useEffect(() => subscribeLyroff(() => setLyroffTick((n) => n + 1)), []);
  void lyroffTick;
  useEffect(() => {
    if (artworkUrl) void bridge.artSrc(artworkUrl).then(setArt);
    else setArt("");
  }, [artworkUrl]);
  useEffect(() => {
    void bridge.getLyrics().then(setLyrics);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackKey]);
  useEffect(() => {
    setVideoUrl(null);
    // Only the video mode resolves the clip; art mode never spins yt-dlp.
    if (mediaMode !== "video" || !trackKey || !track) return;
    const req = ++videoReq.current;
    bridge.resolveVideo(track.artist, track.title).then((u) => {
      if (videoReq.current === req && u) setVideoUrl(u);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaMode, trackKey]);
  useEffect(() => {
    const urls = [...new Set(queue.items.map((i) => i.track.artworkUrl).filter(Boolean))];
    void Promise.all(urls.map((u) => bridge.artSrc(u).catch(() => ""))).then((srcs) =>
      setArtMap(Object.fromEntries(urls.map((u, i) => [u, srcs[i]]))),
    );
  }, [queue.items]);

  const pos = np?.positionMs ?? 0;
  const dur = track?.durationMs ?? 1;
  const playing = np?.status === "playing";
  const active = lyrics ? activeLyricIndex(lyrics, pos + lyricOffsetFor(np)) : -1;
  const canSeek = np?.source === "local" || np?.source === "demo";
  const scrubTo = (el: HTMLElement, clientX: number) => {
    if (!canSeek || !track?.durationMs) return;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    void bridge.seek(Math.floor(frac * track.durationMs));
  };
  // Click AND drag to scrub; pointer capture keeps scrubbing outside the bar.
  const seekBar = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!canSeek || e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      scrubTo(e.currentTarget, e.clientX);
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.buttons & 1) scrubTo(e.currentTarget, e.clientX);
    },
  };
  const pinned = settings.hudAlwaysOnTop;
  const fav = favKeys(favs).has(favKeyFor(np));
  const onToggleFav = () => {
    const entry = favEntryFor(np);
    if (entry) setFavs((prev) => toggleFav(prev, entry));
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, .hud__progress, .hud__list")) return;
    void bridge.hudStartDrag();
  };

  // Closing the HUD hands the screen back to the player window (the Rust
  // side shows it again — the two surfaces never coexist).
  const close = () =>
    void bridge
      .getSettings()
      .then((fresh) => bridge.updateSettings({ ...fresh, hudEnabled: false }));

  const swapMedia = () => {
    const next = mediaMode === "art" ? "video" : "art";
    setMediaMode(next);
    localStorage.setItem("noctbeat.hudmedia", next);
  };
  const toggleLyrics = () => {
    setLyricsOn((v) => {
      localStorage.setItem("noctbeat.hudlyrics", v ? "0" : "1");
      return !v;
    });
  };

  return (
    <div className="hud hud--focus" onMouseDown={onMouseDown}>
      <div className="hud__focus">
        <div className="hud__clock">
          {clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
        <div className="hud__focusart">
          {mediaMode === "video" && videoUrl ? (
            <VideoBackdrop url={videoUrl} posMs={pos} playing={playing} />
          ) : art ? (
            <img src={art} alt="" />
          ) : (
            <MusicNote size={40} weight="thin" />
          )}
          {lyricsOn ? (
            <div className="hud__lyrover">
              {lyrics && lyrics.length > 0 ? (
                <LineLyrics lines={lyrics} active={active} />
              ) : null}
            </div>
          ) : null}
          {queueOpen && queue.items.length > 0 ? (
            <div className="hud__list hud__list--overlay">
              {queue.items.map((it, i) => (
                <button
                  key={it.path + i}
                  className={`hud__qrow ${i === queue.currentIndex ? "hud__qrow--on" : ""}`}
                  onClick={() => void bridge.playQueueIndex(i)}
                >
                  {it.track.artworkUrl && artMap[it.track.artworkUrl] ? (
                    <img className="hud__qthumb" src={artMap[it.track.artworkUrl]} alt="" />
                  ) : (
                    <span className="hud__qthumb hud__qthumb--empty" />
                  )}
                  <span className="hud__qtxt">
                    <span className="hud__qtitle">{it.track.title}</span>
                    <span className="hud__qsub">{it.track.artist}</span>
                  </span>
                  <span className="hud__qdur">{fmt(it.track.durationMs)}</span>
                </button>
              ))}
            </div>
          ) : null}
          <button
            className="hud__artswap"
            aria-label={t("hud.swapArt")}
            title={t("hud.swapArt")}
            onClick={swapMedia}
          >
            {mediaMode === "art" ? <Monitor size={13} /> : <Image size={13} />}
          </button>
          <button
            className={`hud__lyrswap ${lyricsOn ? "on" : ""}`}
            aria-label={t("hud.lyrics")}
            title={t("hud.lyrics")}
            onClick={toggleLyrics}
          >
            <Subtitles size={13} weight={lyricsOn ? "fill" : "regular"} />
          </button>
        </div>
        <div className="hud__focustitle">{track?.title ?? "Nothing playing"}</div>
        <div className="hud__focussub">{track ? track.artist : ""}</div>
        <div
          className="hud__progress"
          style={{ cursor: canSeek ? "pointer" : "default" }}
          {...seekBar}
        >
          <div className="hud__progress-fill" style={{ width: `${(pos / dur) * 100}%` }} />
        </div>
        <div className="hud__pill">
          <button
            className={`hctl ${queueOpen ? "hctl--on" : ""}`}
            aria-label={t("lib.queue")}
            title={t("lib.queue")}
            onClick={() => setQueueOpen((v) => !v)}
          >
            <ListBullets size={15} />
          </button>
          <button className="hctl" aria-label={t("fs.prev")} onClick={() => bridge.mediaControl("previous")}>
            <SkipBack weight="fill" size={15} />
          </button>
          <button
            className="hctl hctl--play"
            aria-label={playing ? t("fs.pauseBtn") : t("fs.playBtn")}
            onClick={() => bridge.mediaControl("play-pause")}
          >
            {playing ? <Pause weight="fill" size={17} /> : <Play weight="fill" size={17} />}
          </button>
          <button className="hctl" aria-label={t("fs.next")} onClick={() => bridge.mediaControl("next")}>
            <SkipForward weight="fill" size={15} />
          </button>
        </div>
        <div className="hud__focusrow">
          <button
            className={`hctl ${fav ? "hctl--on" : ""}`}
            aria-label={fav ? "Unlike" : "Like"}
            title={fav ? t("hud.unlike") : t("hud.like")}
            onClick={onToggleFav}
            disabled={!track}
          >
            <Heart weight={fav ? "fill" : "regular"} size={14} />
          </button>
          <button
            className={`hctl ${pinned ? "hctl--on" : ""}`}
            aria-label={pinned ? "Unpin" : "Pin"}
            title={pinned ? t("hud.unpin") : t("hud.pin")}
            onClick={() => void bridge.setHudPinned(!pinned)}
          >
            <PushPin weight={pinned ? "fill" : "regular"} size={14} />
          </button>
          <button className="hctl" aria-label={t("hud.openPlayer")} title={t("hud.openPlayer")} onClick={() => void bridge.showPlayer()}>
            <Monitor size={14} />
          </button>
          <button className="hctl" aria-label={t("hud.hide")} title={t("hud.hide")} onClick={close}>
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
