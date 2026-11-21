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
  Shuffle,
  Image,
} from "@phosphor-icons/react";
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

export default function Hud() {
  const t = useT();
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [queue, setQueue] = useState<QueueState>({ items: [], currentIndex: null });
  const [art, setArt] = useState("");
  const [artMap, setArtMap] = useState<Record<string, string>>({});
  const [favs, setFavs] = useState<FavEntry[]>(loadFavs);
  const [shuffleOn, setShuffleOn] = useState(false);
  const [mode, setMode] = useState<"list" | "focus">(
    () => (localStorage.getItem("noctbeat.hudmode") as "list" | "focus") || "list",
  );
  const [mediaMode, setMediaMode] = useState<"art" | "video">(
    () => (localStorage.getItem("noctbeat.hudmedia") as "art" | "video") || "art",
  );
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const videoReq = useRef(0);

  useEffect(() => {
    bridge.getNowPlaying().then(setNp);
    bridge.getSettings().then(setSettings);
    bridge.getQueue().then(setQueue);
    bridge.getShuffle().then(setShuffleOn);
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
  useEffect(() => {
    if (track?.artworkUrl) void bridge.artSrc(track.artworkUrl).then(setArt);
  }, [track]);
  const trackKey = track?.id ?? null;
  useEffect(() => {
    setVideoUrl(null);
    if (mediaMode !== "video" || !settings.videoBackdrop || !trackKey || !track) return;
    const req = ++videoReq.current;
    bridge.resolveVideo(track.artist, track.title).then((u) => {
      if (videoReq.current === req && u) setVideoUrl(u);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaMode, settings.videoBackdrop, trackKey]);
  useEffect(() => {
    const urls = [...new Set(queue.items.map((i) => i.track.artworkUrl).filter(Boolean))];
    void Promise.all(urls.map((u) => bridge.artSrc(u).catch(() => ""))).then((srcs) =>
      setArtMap(Object.fromEntries(urls.map((u, i) => [u, srcs[i]]))),
    );
  }, [queue.items]);

  const pos = np?.positionMs ?? 0;
  const dur = track?.durationMs ?? 1;
  const playing = np?.status === "playing";
  const pinned = settings.hudAlwaysOnTop;
  const fav = favKeys(favs).has(favKeyFor(np));
  const onToggleFav = () => {
    const entry = favEntryFor(np);
    if (entry) setFavs((prev) => toggleFav(prev, entry));
  };
  const toggleMode = () => {
    const next = mode === "list" ? "focus" : "list";
    setMode(next);
    localStorage.setItem("noctbeat.hudmode", next);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input")) return;
    void bridge.hudStartDrag();
  };

  const close = () =>
    void bridge
      .getSettings()
      .then((fresh) => bridge.updateSettings({ ...fresh, hudEnabled: false }));

  return (
    <div className={`hud hud--${mode}`} onMouseDown={onMouseDown}>
      {mode === "list" ? (
        <>
          <div className="hud__now">
            <div className="hud__art">
              {art ? <img src={art} alt="" /> : null}
              <div className={`hud__beat ${playing ? "on" : ""}`} />
            </div>
            <div className="hud__body">
              <div className="hud__title">{track?.title ?? "Nothing playing"}</div>
              <div className="hud__sub">{track ? track.artist : bridge.productName}</div>
              <div className="hud__progress">
                <div className="hud__progress-fill" style={{ width: `${(pos / dur) * 100}%` }} />
              </div>
            </div>
            <div className="hud__side">
              <button
                className={`hctl ${fav ? "hctl--on" : ""}`}
                aria-label={fav ? "Unlike" : "Like"}
                title={fav ? t("hud.unlike") : t("hud.like")}
                onClick={onToggleFav}
                disabled={!track}
              >
                <Heart weight={fav ? "fill" : "regular"} size={15} />
              </button>
              <button
                className={`hctl ${pinned ? "hctl--on" : ""}`}
                aria-label={pinned ? "Unpin from top" : "Keep on top"}
                title={pinned ? t("hud.unpin") : t("hud.pin")}
                onClick={() => void bridge.setHudPinned(!pinned)}
              >
                <PushPin weight={pinned ? "fill" : "regular"} size={15} />
              </button>
              <button className="hctl" aria-label="Open player" title="Open player" onClick={() => void bridge.showPlayer()}>
                <Monitor weight="regular" size={15} />
              </button>
              <button className="hctl" aria-label="Hide HUD" title="Hide HUD" onClick={close}>
                <X weight="regular" size={15} />
              </button>
            </div>
          </div>
          {queue.items.length > 0 && (
            <div className="hud__list">
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
          )}
          <div className="hud__pill">
            <button
              className={`hctl ${shuffleOn ? "hctl--on" : ""}`}
              aria-label="Shuffle"
              title="Shuffle"
              onClick={() =>
                void bridge.getShuffle().then((cur) =>
                  bridge.setShuffle(!cur).then(setShuffleOn),
                )
              }
            >
              <Shuffle size={14} />
            </button>
            <button className="hctl" aria-label="Previous" onClick={() => bridge.mediaControl("previous")}>
              <SkipBack weight="fill" size={15} />
            </button>
            <button
              className="hctl hctl--play"
              aria-label={playing ? "Pause" : "Play"}
              onClick={() => bridge.mediaControl("play-pause")}
            >
              {playing ? <Pause weight="fill" size={17} /> : <Play weight="fill" size={17} />}
            </button>
            <button className="hctl" aria-label="Next" onClick={() => bridge.mediaControl("next")}>
              <SkipForward weight="fill" size={15} />
            </button>
            <button
              className="hctl"
              aria-label="Now playing view"
              title="Now playing view"
              onClick={toggleMode}
            >
              <MusicNote size={15} />
            </button>
          </div>
        </>
      ) : (
        <div className="hud__focus">
          <div className="hud__focusart">
            {mediaMode === "video" && videoUrl ? (
              <VideoBackdrop url={videoUrl} posMs={pos} playing={playing} />
            ) : art ? (
              <img src={art} alt="" />
            ) : (
              <MusicNote size={40} weight="thin" />
            )}
            {settings.videoBackdrop && (
              <button
                className="hud__artswap"
                aria-label={mediaMode === "video" ? "Show artwork" : "Show video"}
                title={mediaMode === "video" ? "Show artwork" : "Show video"}
                onClick={() => {
                  const next = mediaMode === "video" ? "art" : "video";
                  setMediaMode(next);
                  localStorage.setItem("noctbeat.hudmedia", next);
                }}
              >
                {mediaMode === "video" ? <Image size={13} /> : <Monitor size={13} />}
              </button>
            )}
          </div>
          <div className="hud__focustitle">{track?.title ?? "Nothing playing"}</div>
          <div className="hud__focussub">{track ? track.artist : ""}</div>
          <div className="hud__progress">
            <div className="hud__progress-fill" style={{ width: `${(pos / dur) * 100}%` }} />
          </div>
          <div className="hud__pill">
            <button className="hctl" aria-label="Previous" onClick={() => bridge.mediaControl("previous")}>
              <SkipBack weight="fill" size={15} />
            </button>
            <button
              className="hctl hctl--play"
              aria-label={playing ? "Pause" : "Play"}
              onClick={() => bridge.mediaControl("play-pause")}
            >
              {playing ? <Pause weight="fill" size={17} /> : <Play weight="fill" size={17} />}
            </button>
            <button className="hctl" aria-label="Next" onClick={() => bridge.mediaControl("next")}>
              <SkipForward weight="fill" size={15} />
            </button>
            <button className="hctl" aria-label="Playlist view" title="Playlist view" onClick={toggleMode}>
              <ListBullets size={15} />
            </button>
          </div>
          <div className="hud__focusrow">
            <button
              className={`hctl ${fav ? "hctl--on" : ""}`}
              aria-label={fav ? "Unlike" : "Like"}
              onClick={onToggleFav}
              disabled={!track}
            >
              <Heart weight={fav ? "fill" : "regular"} size={14} />
            </button>
            <button
              className={`hctl ${pinned ? "hctl--on" : ""}`}
              aria-label={pinned ? "Unpin" : "Pin"}
              onClick={() => void bridge.setHudPinned(!pinned)}
            >
              <PushPin weight={pinned ? "fill" : "regular"} size={14} />
            </button>
            <button className="hctl" aria-label="Open player" onClick={() => void bridge.showPlayer()}>
              <Monitor size={14} />
            </button>
            <button className="hctl" aria-label="Hide HUD" onClick={close}>
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
