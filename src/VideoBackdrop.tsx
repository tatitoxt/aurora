import { useEffect, useRef, useState } from "react";

/** Music-video backdrop for karaoke mode: plays the resolved stream muted and
 * blurred behind the lyrics, kept in sync with the track position. When the
 * resolved URL is a YouTube embed (browser preview only — the desktop app
 * resolves direct streams), it renders an iframe driven over postMessage so
 * the real videoclip plays with audio. */
export function VideoBackdrop({
  url,
  posMs,
  playing,
  cls = "kbg__video",
  readyCls = "kbg__video--ready",
}: {
  url: string;
  posMs: number;
  playing: boolean;
  /** Element class set — defaults match the karaoke backdrop styles; the
   * stage passes its own ("fs__video"/"fs__cvid"). */
  cls?: string;
  readyCls?: string;
}) {
  const isEmbed = /youtube(-nocookie)?\.com\/embed\//.test(url);
  if (isEmbed)
    return <EmbedBackdrop url={url} posMs={posMs} playing={playing} cls={cls} readyCls={readyCls} />;
  return <FileBackdrop url={url} posMs={posMs} playing={playing} cls={cls} readyCls={readyCls} />;
}

function FileBackdrop({
  url,
  posMs,
  playing,
  cls,
  readyCls,
}: {
  url: string;
  posMs: number;
  playing: boolean;
  cls: string;
  readyCls: string;
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
    const vt = v.duration;
    if (!vt) return;
    // The element loops, so a clip shorter than the song wraps with it.
    const target = posMs / 1000 < vt ? posMs / 1000 : (posMs / 1000) % vt;
    if (Math.abs(v.currentTime - target) > 0.6) v.currentTime = target;
  }, [posMs, ready]);

  return (
    <video
      ref={ref}
      className={`${cls} ${ready ? readyCls : ""}`}
      src={url}
      muted
      playsInline
      /* if the clip is shorter than the song it replays instead of
       * freezing on the last frame (demo clips are a few seconds). */
      loop
      onCanPlay={() => setReady(true)}
    />
  );
}

function EmbedBackdrop({
  url,
  posMs,
  playing,
  cls,
  readyCls,
}: {
  url: string;
  posMs: number;
  playing: boolean;
  cls: string;
  readyCls: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  // Track where the embed should be: posMs ticks with the track, and we only
  // re-seek when it jumps (a real scrub), not on every poll.
  const sync = useRef({ pos: 0, at: 0 });
  const unmuted = useRef(false);
  const [loaded, setLoaded] = useState(false);

  const cmd = (func: string, args: unknown[] = []) =>
    ref.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      "*",
    );

  useEffect(() => {
    if (!loaded) return;
    sync.current = { pos: posMs, at: Date.now() };
    if (!playing) {
      cmd("pauseVideo");
      return;
    }
    // The YouTube player ignores commands until its API is up — retry a few
    // times after the iframe loads so the clip actually starts on its own.
    const kick = () => {
      if (!unmuted.current) {
        cmd("unMute");
        cmd("setVolume", [80]);
        unmuted.current = true;
      }
      cmd("playVideo");
    };
    kick();
    const timers = [600, 1400, 2400, 3600].map((ms) => setTimeout(kick, ms));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, url, loaded]);

  useEffect(() => {
    const expected = sync.current.pos + (playing ? Date.now() - sync.current.at : 0);
    if (Math.abs(posMs - expected) > 800) {
      cmd("seekTo", [posMs / 1000, true]);
      sync.current = { pos: posMs, at: Date.now() };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posMs]);

  return (
    <iframe
      ref={ref}
      className={`${cls} ${readyCls} kbg__embed`}
      /* autoplay muted: always allowed, so the videoclip is moving as soon
       * as it loads; we unMute via the API once the player is up. */
      src={`${url}&autoplay=1&mute=1`}
      onLoad={() => setLoaded(true)}
      title="Videoclip"
      allow="autoplay; encrypted-media; picture-in-picture"
      allowFullScreen={false}
      /* The iframe must not eat the stage's clicks (seek, covers, pill). */
      style={{ pointerEvents: "none", border: "none" }}
    />
  );
}
