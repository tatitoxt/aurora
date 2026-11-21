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
    const target = Math.min(posMs / 1000, v.duration || Infinity);
    if (Math.abs(v.currentTime - target) > 0.6) v.currentTime = target;
  }, [posMs, ready]);

  return (
    <video
      ref={ref}
      className={`kbg__video ${ready ? "kbg__video--ready" : ""}`}
      src={url}
      muted
      playsInline
      onCanPlay={() => setReady(true)}
    />
  );
}
