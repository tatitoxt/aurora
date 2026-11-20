import { useEffect, useState } from "react";
import {
  bridge,
  subscribe,
  DEFAULT_SETTINGS,
  type NowPlaying,
  type Settings,
} from "../bridge";

export default function Hud() {
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [art, setArt] = useState("");

  useEffect(() => {
    bridge.getNowPlaying().then(setNp);
    bridge.getSettings().then(setSettings);
    const offNp = subscribe<NowPlaying>("now-playing", setNp);
    const offS = subscribe<Settings>("settings", setSettings);
    return () => {
      offNp();
      offS();
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
        <div className="hud__sub">{track ? `${track.artist}` : "—"}</div>
        <div className="hud__progress">
          <div className="hud__progress-fill" style={{ width: `${(pos / dur) * 100}%` }} />
        </div>
      </div>
      <div className="hud__controls">
        <button className="hctl" aria-label="Previous" onClick={() => bridge.mediaControl("previous")}>
          <svg viewBox="0 0 24 24"><path d="M6 4h2v16H6zM20 4v16L9.5 12z" /></svg>
        </button>
        <button
          className="hctl hctl--play"
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => bridge.mediaControl("play-pause")}
        >
          {playing ? (
            <svg viewBox="0 0 24 24"><path d="M7 4h4v16H7zM13 4h4v16h-4z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24"><path d="M8 4l12 8-12 8z" /></svg>
          )}
        </button>
        <button className="hctl" aria-label="Next" onClick={() => bridge.mediaControl("next")}>
          <svg viewBox="0 0 24 24"><path d="M16 4h2v16h-2zM4 4v16l10.5-8z" /></svg>
        </button>
      </div>
      <div className="hud__side">
        <button
          className={`hctl ${pinned ? "hctl--on" : ""}`}
          aria-label={pinned ? "Unpin from top" : "Keep on top"}
          title={pinned ? "Unpin (let it go behind other windows)" : "Keep on top"}
          onClick={() => void bridge.setHudPinned(!pinned)}
        >
          <svg viewBox="0 0 24 24">
            <path d="M14 3l7 7-3 1-4.5 7.5L12 15l-5 5-1-4-4-1 7.5-4.5L11 6z" />
          </svg>
        </button>
        <button className="hctl" aria-label="Open player" title="Open player" onClick={() => void bridge.showPlayer()}>
          <svg viewBox="0 0 24 24"><path d="M4 4h16v12H4z" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M9 20h6" stroke="currentColor" strokeWidth="2" /></svg>
        </button>
        <button className="hctl" aria-label="Hide HUD" title="Hide HUD" onClick={close}>
          <svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" strokeWidth="2" /></svg>
        </button>
      </div>
    </div>
  );
}
