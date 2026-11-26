import { useT } from "../../i18n";
import { useNavigate } from "react-router-dom";
import { bridge, type NowPlaying } from "../../bridge";
import { Art, SeekCluster } from "./bits";
import {
  ArrowsOut,
  Heart,
  ListBullets,
  Microphone,
  Pause,
  Play,
  Repeat,
  RepeatOnce,
  Shuffle,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SpeakerSlash,
  SquaresFour,
} from "@phosphor-icons/react";
import { favEntryFor, toggleFav, type FavEntry } from "../../favs";
import type { Dispatch, SetStateAction } from "react";
import type { View } from "./types";

/** Bottom playbar: artwork + title/artist-link + like, transport with
    shuffle/repeat/seek, queue shortcut, volume with mute, live-view
    and fullscreen buttons. preMuteVol lives in Browse.tsx module
    scope (survives unmount) and is passed in. */
export default function Playbar({
  track,
  np,
  playing,
  isFav,
  setFavs,
  shuffle,
  setShuffle,
  repeat,
  setRepeat,
  vol,
  setVol,
  volLocal,
  view,
  go,
  preMuteVolRef,
  showLyrics,
  toggleLyrics,
}: {
  track: NowPlaying["track"] | null;
  np: NowPlaying | null;
  playing: boolean;
  isFav: boolean;
  setFavs: Dispatch<SetStateAction<FavEntry[]>>;
  shuffle: boolean;
  setShuffle: (b: boolean) => void;
  repeat: "off" | "all" | "one";
  setRepeat: (m: "off" | "all" | "one") => void;
  vol: number;
  setVol: (v: number) => void;
  volLocal: boolean;
  view: View;
  go: (v: View) => void;
  preMuteVolRef: { current: number };
  showLyrics: boolean;
  toggleLyrics: () => void;
}) {
  const t = useT();
  const nav = useNavigate();
  return (
    <footer className="brw__bar">
  {track ? (
    <>
      <Art url={track.artworkUrl} />
      <span className="brw__np">
        <span className="brw__npt">{track.title}</span>
        <button
          className="brw__npa brw__npa--link"
          title={t("brw.goToArtist")}
          onClick={() => go(`ar:${encodeURIComponent(track.artist)}`)}
        >
          {track.artist}
        </button>
      </span>
      <button
        className={`brw__icon ${isFav ? "on" : ""}`}
        aria-label={isFav ? t("fs.unlike") : t("fs.like")}
        title={isFav ? t("fs.unlike") : t("fs.like")}
        onClick={() => {
          const entry = favEntryFor(np);
          if (entry) setFavs((prev) => toggleFav(prev, entry));
        }}
      >
        <Heart size={15} weight={isFav ? "fill" : "regular"} />
      </button>
    </>
  ) : (
    <span className="brw__np" />
  )}
  <span className="brw__ctl">
    <button
      className={`brw__icon ${shuffle ? "on" : ""}`}
      aria-label={t("fs.shuffle")}
      title={t("fs.shuffle")}
      onClick={() =>
        void bridge.getShuffle().then((on) => {
          const next = !on;
          return bridge.setShuffle(next).then(() => setShuffle(next));
        })
      }
    >
      <Shuffle size={15} weight={shuffle ? "fill" : "regular"} />
    </button>
    <button
      className="brw__icon"
      aria-label={t("fs.prev")}
      title={t("fs.prev")}
      onClick={() => void bridge.mediaControl("previous")}
    >
      <SkipBack size={16} weight="fill" />
    </button>
    <button
      className="brw__icon brw__icon--play"
      aria-label={playing ? t("fs.pauseBtn") : t("fs.playBtn")}
      title={playing ? t("fs.pauseBtn") : t("fs.playBtn")}
      onClick={() => void bridge.mediaControl("play-pause")}
    >
      {playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
    </button>
    <button
      className="brw__icon"
      aria-label={t("fs.next")}
      title={t("fs.next")}
      onClick={() => void bridge.mediaControl("next")}
    >
      <SkipForward size={16} weight="fill" />
    </button>
    <button
      className={`brw__icon ${repeat !== "off" ? "on" : ""}`}
      aria-label={t(
        repeat === "off"
          ? "fs.repeatOff"
          : repeat === "all"
            ? "fs.repeatAll"
            : "fs.repeatOne",
      )}
      title={t(
        repeat === "off"
          ? "fs.repeatOff"
          : repeat === "all"
            ? "fs.repeatAll"
            : "fs.repeatOne",
      )}
      onClick={() =>
        void bridge.getRepeat().then((m) => {
          const next = m === "off" ? "all" : m === "all" ? "one" : "off";
          return bridge.setRepeat(next).then(() => setRepeat(next));
        })
      }
    >
      {repeat === "one" ? (
        <RepeatOnce size={15} weight="fill" />
      ) : (
        <Repeat size={15} weight={repeat === "all" ? "fill" : "regular"} />
      )}
    </button>
    <SeekCluster durationMs={track?.durationMs} hasTrack={!!track} />
  </span>
  <button
    className={`brw__icon brw__barextra ${showLyrics ? "on" : ""}`}
    onClick={toggleLyrics}
    aria-label={t("brw.lyrics")}
    title={t("brw.lyrics")}
  >
    <Microphone size={15} />
  </button>
  <button
    className={`brw__icon brw__barextra ${view === "queue" ? "on" : ""}`}
    aria-label={t("lib.queue")}
    title={t("lib.queue")}
    onClick={() => go("queue")}
  >
    <ListBullets size={15} />
  </button>
  <span
    className={`brw__volwrap ${volLocal ? "" : "brw__volwrap--off"}`}
    title={volLocal ? t("fs.volume") : t("brw.volLocalOnly")}
  >
    <button
      className={`brw__icon ${vol === 0 ? "" : "on"}`}
      disabled={!volLocal}
      aria-label={vol === 0 ? t("fs.unmute") : t("fs.mute")}
      title={volLocal ? (vol === 0 ? t("fs.unmute") : t("fs.mute")) : t("brw.volLocalOnly")}
      onClick={() => {
        const next = vol === 0 ? preMuteVolRef.current : 0;
        if (vol !== 0) preMuteVolRef.current = vol;
        setVol(next);
        void bridge.setVolume(next);
      }}
    >
      {vol === 0 ? <SpeakerSlash size={15} /> : <SpeakerHigh size={15} />}
    </button>
    <input
      className="brw__vol"
      type="range"
      min={0}
      max={1}
      step={0.01}
      value={vol}
      disabled={!volLocal}
      aria-label={t("fs.volume")}
      onChange={(e) => {
        const v = Number(e.target.value);
        setVol(v);
        void bridge.setVolume(v);
      }}
    />
  </span>
  <button
    className="brw__icon brw__icon--live"
    aria-label={t("brw.liveView")}
    title={t("brw.liveView")}
    onClick={() => nav("/")}
  >
    <SquaresFour size={15} />
    <span>{t("brw.liveView")}</span>
  </button>
  <button
    className="brw__icon brw__barextra"
    aria-label={t("nav.fullscreen")}
    title={t("nav.fullscreen")}
    /* Browser preview can't go fullscreen — take them to the
       live stage instead so the button is never dead. */
    onClick={() =>
      bridge.isTauri() ? void bridge.toggleFullscreen() : nav("/")
    }
  >
    <ArrowsOut size={15} />
  </button>
    </footer>
  );
}
