import { useEffect, useState } from "react";
import {
  bridge,
  subscribe,
  DEFAULT_SETTINGS,
  type NowPlaying,
  type Settings,
} from "../bridge";
import { Monitor, PushPin, SkipBack, SkipForward, Pause, Play, X, Heart } from "@phosphor-icons/react";
import {
  favEntryFor,
  favKeyFor,
  favKeys,
  loadFavs,
  subscribeFavs,
  toggleFav,
  type FavEntry,
} from "../favs";

export default function Hud() {
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [art, setArt] = useState("");
  const [favs, setFavs] = useState<FavEntry[]>(loadFavs);

  useEffect(() => {
    bridge.getNowPlaying().then(setNp);
    bridge.getSettings().then(setSettings);
    const offNp = subscribe<NowPlaying>("now-playing", setNp);
    const offS = subscribe<Settings>("settings", setSettings);
    const offFavs = subscribeFavs(() => setFavs(loadFavs()));
    return () => {
      offNp();
      offS();
      offFavs();
    };
  }, []);

  const track = np?.track ?? null;
  useEffect(() => {
    if (track?.artworkUrl) void bridge.artSrc(track.artworkUrl).then(setArt);
  }, [track]);

  const pos = np?.positionMs ?? 0;
  const dur = track?.durationMs ?? 1;
  const playing = np?.status === "playing";
  const pinned = settings.hudAlwaysOnTop;
  const fav = favKeys(favs).has(favKeyFor(np));
  const onToggleFav = () => {
    const entry = favEntryFor(np);
    if (entry) setFavs((prev) => toggleFav(prev, entry));
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    void bridge.hudStartDrag();
  };

  const close = () =>
    void bridge
      .getSettings()
      .then((fresh) => bridge.updateSettings({ ...fresh, hudEnabled: false }));

  return (
    <div className="hud" onMouseDown={onMouseDown}>
      <div className="hud__art">
        {art ? <img src={art} alt="" /> : null}
        <div className={`hud__beat ${np?.status === "playing" ? "on" : ""}`} />
      </div>
      <div className="hud__body">
        <div className="hud__title">{track?.title ?? "Nothing playing"}</div>
        <div className="hud__sub">{track ? `${track.artist}` : bridge.productName}</div>
        <div className="hud__progress">
          <div className="hud__progress-fill" style={{ width: `${(pos / dur) * 100}%` }} />
        </div>
      </div>
      <div className="hud__controls">
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
      </div>
      <div className="hud__side">
        <button
          className={`hctl ${fav ? "hctl--on" : ""}`}
          aria-label={fav ? "Unlike" : "Like"}
          title={fav ? "Unlike" : "Like"}
          onClick={onToggleFav}
          disabled={!track}
        >
          <Heart weight={fav ? "fill" : "regular"} size={15} />
        </button>
        <button
          className={`hctl ${pinned ? "hctl--on" : ""}`}
          aria-label={pinned ? "Unpin from top" : "Keep on top"}
          title={pinned ? "Unpin (let it go behind other windows)" : "Keep on top"}
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
  );
}
