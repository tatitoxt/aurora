import { useEffect, useRef, useState } from "react";

/** Music-video backdrop for karaoke mode: plays the resolved stream muted and
 * blurred behind the lyrics, kept in sync with the track position. */
export function VideoBackdrop({
  url,
  posMs,
  playing,
}: {
  url: string;
  posMs: number;
  playing: boolean;
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
      className={`kbg__video ${ready ? "kbg__video--ready" : ""}`}
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
