/** Small self-contained pieces of the Browse page: artwork tiles,
    generated covers, the seek cluster and the demo backdrop — plus
    the usePosMs hook they share. Extracted from Browse.tsx so the
    page file only carries view logic. */
import { useEffect, useState } from "react";
import { artSrc, bridge, subscribe, type NowPlaying } from "../../bridge";
import { formatTime } from "../../lib";
import { useT } from "../../i18n";
import { MusicNote } from "@phosphor-icons/react";
import { VideoBackdrop } from "../../VideoBackdrop";

/** Artwork tile that resolves file:// refs to loadable URLs. */
export function Art({ url, icon }: { url?: string; icon?: React.ReactNode }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    setSrc("");
    if (!url) return;
    let live = true;
    void artSrc(url).then((s) => {
      if (live) setSrc(s);
    });
    return () => {
      live = false;
    };
  }, [url]);
  if (src)
    return (
      <img className="brw__art" src={src} alt="" loading="lazy" decoding="async" />
    );
  return (
    <span className="brw__art brw__art--ph" aria-hidden>
      {icon ?? <MusicNote />}
    </span>
  );
}

export const hueOf = (s: string) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};

/** Generated cover for art-less playlists: a two-tone gradient tile
    with the initial — reads like a blurred cover, not a dead square. */
export function GenCover({ name }: { name: string }) {
  const h = hueOf(name);
  return (
    <span
      className="brw__art brw__art--gen"
      style={{
        background: `linear-gradient(135deg, hsl(${h} 42% 34%), hsl(${(h + 70) % 360} 38% 16%))`,
      }}
      aria-hidden
    >
      {name.trim().charAt(0).toUpperCase() || "♪"}
    </span>
  );
}

/* The engine emits now-playing every tick; the page only needs
   track/status/source changes, so the per-tick positionMs stream
   lives inside the two components that display it — otherwise the
   whole Browse tree would re-render on every tick. */
export function usePosMs() {
  const [pos, setPos] = useState(0);
  useEffect(
    () =>
      subscribe<NowPlaying>("now-playing", (n) =>
        setPos(n.positionMs ?? 0),
      ),
    [],
  );
  return pos;
}

export function SeekCluster({
  durationMs,
  hasTrack,
}: {
  durationMs: number | undefined;
  hasTrack: boolean;
}) {
  const t = useT();
  const pos = usePosMs();
  const progress = durationMs ? Math.min(1, pos / durationMs) : 0;
  return (
    <>
      <span className="brw__time">{hasTrack ? formatTime(pos) : "0:00"}</span>
      <button
        className="brw__seek"
        aria-label={t("brw.seek")}
        onClick={(e) => {
          if (!durationMs) return;
          const r = e.currentTarget.getBoundingClientRect();
          void bridge.seek(
            Math.round(((e.clientX - r.left) / r.width) * durationMs),
          );
        }}
      >
        <i style={{ width: `${progress * 100}%` }} />
      </button>
      <span className="brw__time">
        {durationMs ? formatTime(durationMs) : "0:00"}
      </span>
    </>
  );
}

export function SyncBackdrop(props: {
  url: string;
  playing: boolean;
  cls: string;
  readyCls: string;
}) {
  const pos = usePosMs();
  return <VideoBackdrop {...props} posMs={pos} audible />;
}
