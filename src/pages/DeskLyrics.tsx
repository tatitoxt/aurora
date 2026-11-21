import { useEffect, useState } from "react";
import { bridge, subscribe, type LrcLine, type NowPlaying } from "../bridge";
import { KaraokeLyric } from "../Lyrics";
import { activeLyricIndex } from "../lib";
import { X } from "@phosphor-icons/react";

/** Floating desktop lyrics overlay: the karaoke line on a small glass chip,
 * always on top, draggable anywhere like the HUD. */
export default function DeskLyrics() {
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [lyrics, setLyrics] = useState<LrcLine[] | null>(null);

  useEffect(() => {
    bridge.getNowPlaying().then(setNp);
    return subscribe<NowPlaying>("now-playing", setNp);
  }, []);

  const trackId = np?.track?.id ?? "";
  useEffect(() => {
    setLyrics(null);
    if (trackId) void bridge.getLyrics().then(setLyrics);
  }, [trackId]);

  const pos = np?.positionMs ?? 0;
  const active = lyrics ? activeLyricIndex(lyrics, pos) : -1;
  const line = active >= 0 ? lyrics![active] : null;
  const nextLine = lyrics && active >= 0 ? (lyrics[active + 1] ?? null) : null;

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    void bridge.deskLyricsStartDrag();
  };

  const close = () =>
    void bridge
      .getSettings()
      .then((s) => bridge.updateSettings({ ...s, deskLyricsEnabled: false }));

  return (
    <div className="dlyrics" onMouseDown={onMouseDown}>
      <button className="dlyrics__close" aria-label="Close lyrics overlay" onClick={close}>
        <X weight="bold" size={13} />
      </button>
      {line ? (
        <KaraokeLyric line={line} nextLine={nextLine} posMs={pos} />
      ) : (
        <div className="dlyrics__idle">
          {np?.track ? `${np.track.artist} · ${np.track.title}` : bridge.productName}
        </div>
      )}
    </div>
  );
}
