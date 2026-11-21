import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  bridge,
  subscribe,
  DEFAULT_SETTINGS,
  type NowPlaying,
  type LrcLine,
  type Settings,
} from "../bridge";
import {
  ArrowsOut,
  Command,
  Export,
  GearSix,
  Image,
  FilmStrip,
  MicrophoneStage,
  Pause,
  Play,
  Queue,
  SkipBack,
  SkipForward,
} from "@phosphor-icons/react";
import { KaraokeLyric, LineLyrics } from "../Lyrics";
import { openPalette } from "../Palette";
import ShareCard, { SHARE_EVENT } from "../ShareCard";
import { activeLyricIndex, formatTime } from "../lib";
import { lyricOffsetFor, subscribeLyroff } from "../lyroff";
import { useT } from "../i18n";
import { StickerLayer } from "../Stickers";
import AmbientBg from "../AmbientBg";
import { VideoBackdrop } from "../VideoBackdrop";

const PREV = <SkipBack weight="fill" size={18} />;
const NEXT = <SkipForward weight="fill" size={18} />;
const PAUSE = <Pause weight="fill" size={20} />;
const PLAY = <Play weight="fill" size={20} />;


export default function Player() {
  const t = useT();
  const go = useNavigate();
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [lyrics, setLyrics] = useState<LrcLine[] | null>(null);
  const [lyroffTick, setLyroffTick] = useState(0);
  useEffect(() => subscribeLyroff(() => setLyroffTick((t) => t + 1)), []);
  void lyroffTick;
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [art, setArt] = useState<string>("");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [share, setShare] = useState(false);
  const [view, setView] = useState<"art" | "video" | "lyrics">("art");
  const trackId = useRef<string | null>(null);

  useEffect(() => {
    bridge.getNowPlaying().then(setNp);
    bridge.getSettings().then(setSettings);
    const off = subscribe<NowPlaying>("now-playing", setNp);
    const offS = subscribe<Settings>("settings", setSettings);
    const onShare = () => setShare(true);
    window.addEventListener(SHARE_EVENT, onShare);
    return () => {
      off();
      offS();
      window.removeEventListener(SHARE_EVENT, onShare);
    };
  }, []);

  const track = np?.track ?? null;
  useEffect(() => {
    if (!track) {
      trackId.current = null;
      setArt("");
      setLyrics(null);
      return;
    }
    if (track.id !== trackId.current) {
      trackId.current = track.id;
      bridge.getLyrics().then(setLyrics);
      if (track.artworkUrl) void bridge.artSrc(track.artworkUrl).then(setArt);
      else setArt("");
    }
  }, [track]);

  // Resolve the music video once per track when the backdrop pref is on —
  // karaoke uses it behind the lyrics; the card layout shows it where the
  // cover art sits. Falls back to artwork on any failure.
  // Dep is track?.id, not track: the now-playing poll emits a new object
  // every ~200ms and would restart the yt-dlp resolve on every tick.
  const wantVideo = settings.videoBackdrop || view === "video";
  const trackKey = track?.id ?? null;
  useEffect(() => {
    setVideoUrl(null);
    if (!wantVideo || !track) return;
    let stale = false;
    bridge.resolveVideo(track.artist, track.title).then((u) => {
      if (!stale && u) setVideoUrl(u);
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantVideo, trackKey]);

  const pos = np?.positionMs ?? 0;
  const dur = track?.durationMs ?? 1;
  const lyricPos = pos + lyricOffsetFor(np);
  const active = lyrics ? activeLyricIndex(lyrics, lyricPos) : -1;
  const playing = np?.status === "playing";
  const karaoke = settings.lyricsMode === "karaoke";

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (np?.source !== "local") return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - r.left) / r.width;
    if (track?.durationMs) void bridge.seek(Math.floor(frac * track.durationMs));
  };

  const controls = (
    <div className="player__controls">
      <button className="ctl" aria-label="Previous" onClick={() => bridge.mediaControl("previous")}>
        {PREV}
      </button>
      <button
        className="ctl ctl--play"
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => bridge.mediaControl("play-pause")}
      >
        {playing ? PAUSE : PLAY}
      </button>
      <button className="ctl" aria-label="Next" onClick={() => bridge.mediaControl("next")}>
        {NEXT}
      </button>
    </div>
  );

  const progress = (
    <div>
      <div
        className="player__progress"
        role="slider"
        aria-label="Seek"
        style={{ cursor: np?.source === "local" ? "pointer" : "default" }}
        onClick={seek}
      >
        <div className="player__progress-fill" style={{ width: `${(pos / dur) * 100}%` }} />
      </div>
      <div className="player__times">
        <span>{formatTime(pos)}</span>
        <span>{track ? formatTime(dur) : "-:--"}</span>
      </div>
    </div>
  );

  const nav = (
    <div className="pnav">
      <Link to="/library" className="pnav__btn" aria-label={t("nav.library")} title={t("nav.library")}>
        <Queue size={15} />
      </Link>
      <Link to="/settings" className="pnav__btn" aria-label={t("nav.settings")} title={t("nav.settings")}>
        <GearSix size={15} />
      </Link>
      <span className="pnav__sep" />
      <button className="pnav__btn" aria-label={t("nav.share")} title={t("nav.share")} onClick={() => setShare(true)}>
        <Export size={14} />
      </button>
      <button className="pnav__btn" aria-label={t("nav.commands")} title={t("nav.commands")} onClick={openPalette}>
        <Command size={14} />
      </button>
      <button
        className="pnav__btn"
        aria-label="Toggle fullscreen"
        title={t("player.fullscreen")}
        onClick={() =>
          void bridge.toggleFullscreen().then((on) => {
            if (on) go("/fullscreen");
          })
        }
      >
        <ArrowsOut size={14} />
      </button>
    </div>
  );

  const shareCard = share && (
    <ShareCard track={track} artUrl={art} posMs={pos} onClose={() => setShare(false)} />
  );

  if (karaoke) {
    return (
      <div className="glass glass--bare">
        <StickerLayer />
        <div className="kbg">
          {art ? <img src={art} alt="" /> : null}
          {videoUrl ? <VideoBackdrop url={videoUrl} posMs={pos} playing={playing} /> : null}
          <div className="kbg__veil" />
          {settings.ambientBg && !videoUrl && <AmbientBg />}
        </div>
        <div className="player player--karaoke">
          <div className="kcenter">
            {lyrics && active >= 0 ? (
              <KaraokeLyric
                line={lyrics[active]}
                nextLine={lyrics[active + 1] ?? null}
                posMs={lyricPos}
              />
            ) : (
              <div className="karaoke__idle">{track ? track.title : bridge.productName}</div>
            )}
          </div>
          {/* iBaila karaoke: one floating transport bar — controls left,
              art + meta + hairline progress. */}
          <div className="kbar">
            <button className="ctl" aria-label="Previous" onClick={() => bridge.mediaControl("previous")}>{PREV}</button>
            <button className="ctl ctl--play ctl--play-sm" aria-label={playing ? "Pause" : "Play"} onClick={() => bridge.mediaControl("play-pause")}>
              {playing ? <Pause weight="fill" size={16} /> : <Play weight="fill" size={16} />}
            </button>
            <button className="ctl" aria-label="Next" onClick={() => bridge.mediaControl("next")}>{NEXT}</button>
            {art ? <img className="kbar__art" src={art} alt="" /> : <div className="kbar__art kbar__art--ph" />}
            <span className="kbar__txt">
              <span className="kbar__title">{track?.title ?? "Nothing playing"}</span>
              <span className="kbar__sub">{track ? `${track.artist} — ${track.album}` : ""}</span>
              <span
                className="kbar__prog"
                role="slider"
                aria-label="Seek"
                style={{ cursor: np?.source === "local" ? "pointer" : "default" }}
                onClick={(e) => {
                  if (np?.source !== "local" || !track?.durationMs) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  const frac = (e.clientX - r.left) / r.width;
                  void bridge.seek(Math.floor(frac * track.durationMs));
                }}
              >
                <span className="kbar__fill" style={{ transform: `scaleX(${track?.durationMs ? Math.min(1, pos / track.durationMs) : 0})` }} />
              </span>
            </span>
          </div>
          {nav}
        </div>
        {shareCard}
      </div>
    );
  }

  const showVideo = view === "video" && videoUrl;
  const showBigLyrics = view === "lyrics";
  return (
    <div className="glass">
      <div className="player">
        <div className="player__modes">
          <button
            className={view === "art" ? "on" : ""}
            aria-label="Cover art"
            onClick={() => setView("art")}
          >
            <Image size={13} />
          </button>
          <button
            className={view === "video" ? "on" : ""}
            aria-label="Music video"
            onClick={() => setView("video")}
          >
            <FilmStrip size={13} />
          </button>
          <button
            className={view === "lyrics" ? "on" : ""}
            aria-label="Lyrics"
            onClick={() => setView("lyrics")}
          >
            <MicrophoneStage size={13} />
          </button>
        </div>
        <div className={`player__art ${showBigLyrics ? "player__art--lyrics" : ""}`}>
          {showBigLyrics ? (
            <div className="player__lyrfill">
              {lyrics && lyrics.length > 0 ? (
                <LineLyrics lines={lyrics} active={active} />
              ) : (
                <span className="karaoke__idle">{track?.title ?? "—"}</span>
              )}
            </div>
          ) : (
            <>
              {art ? <img src={art} alt={track?.album ?? ""} /> : null}
              {showVideo ? (
                <VideoBackdrop url={videoUrl} posMs={pos} playing={playing} />
              ) : null}
            </>
          )}
        </div>
        <div className="player__meta">
          <div className="player__title">{track?.title ?? "Nothing playing"}</div>
          <div className="player__sub">
            {track ? `${track.artist} · ${track.album}` : t("player.startMusic")}
          </div>
        </div>
        {progress}
        {controls}
        {nav}
      </div>
      {shareCard}
      <StickerLayer />
    </div>
  );
}
