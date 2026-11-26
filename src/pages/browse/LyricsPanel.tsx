/** Right-hand lyrics panel: synced lines for the current track, auto
    scrolling to the active line. Subscribes to now-playing itself so
    the rest of Browse doesn't re-render per tick. */
import { useEffect, useRef, useState } from "react";
import { bridge, subscribe, type LrcLine, type NowPlaying } from "../../bridge";
import { useT } from "../../i18n";
import PremiumLock from "../../PremiumLock";
import { usePremiumStatus } from "../../premium";
import { X } from "@phosphor-icons/react";
import { activeLyricIndex } from "../../lib";
import { lyricOffsetFor } from "../../lyroff";

export default function LyricsPanel({ close }: { close: () => void }) {
  const t = useT();
  const premium = usePremiumStatus();
  const [lines, setLines] = useState<LrcLine[] | null>(null);
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [sig, setSig] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  /* Track changes re-pull the lyrics; plain position ticks only move
     the highlight. */
  useEffect(
    () =>
      subscribe<NowPlaying>("now-playing", (n) => {
        setNp(n);
        const s = `${n.track?.id}|${n.status}`;
        setSig((p) => (p === s ? p : s));
      }),
    [],
  );
  useEffect(() => {
    if (premium !== "premium") {
      setLines(null);
      return;
    }
    let live = true;
    void bridge
      .getLyrics()
      .then((l) => {
        if (live) setLines(l);
      })
      .catch(() => {
        if (live) setLines(null);
      });
    return () => {
      live = false;
    };
  }, [sig, premium]);

  const lyricPos = (np?.positionMs ?? 0) + lyricOffsetFor(np);
  const active = lines ? activeLyricIndex(lines, lyricPos) : -1;

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(".on");
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active]);

  return (
    <aside className="brw__lyrics" aria-label={t("brw.lyrics")}>
      <div className="brw__lyricshead">
        <b>{t("brw.lyrics")}</b>
        <button className="brw__icon" onClick={close} aria-label={t("brw.cancel")} title={t("brw.cancel")}>
          <X />
        </button>
      </div>
      <div className="brw__lyricslist" ref={listRef}>
        {premium === "free" ? (
          <PremiumLock compact />
        ) : premium === "loading" ? null : lines && lines.length > 0 ? (
          lines.map((l, i) => (
            <p key={i} className={i === active ? "on" : i < active ? "past" : ""}>
              {l.text || "♪"}
            </p>
          ))
        ) : (
          <p className="brw__lyricsempty">{t("brw.noLyrics")}</p>
        )}
      </div>
    </aside>
  );
}
