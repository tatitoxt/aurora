import { Fragment, type Dispatch, type SetStateAction } from "react";
import { useT } from "../../i18n";
import { bridge, type QueueState } from "../../bridge";
import { formatTime } from "../../lib";
import { Art } from "./bits";
import { X } from "@phosphor-icons/react";

/** Up-next queue: save/clear tools, rows with drag-reorder,
    right-click menu hooks, and the now-playing/next-in-queue section
    markers. */
export default function QueueView({
  queue,
  playing,
  queueLeftMs,
  navRow,
  dragIdx,
  setDragIdx,
  dropIdx,
  setDropIdx,
  setCtx,
  setDlgName,
  setDlg,
  fail,
}: {
  queue: QueueState;
  playing: boolean;
  queueLeftMs: number;
  navRow: (e: React.KeyboardEvent, dir: 1 | -1) => void;
  dragIdx: number | null;
  setDragIdx: (i: number | null) => void;
  dropIdx: number | null;
  setDropIdx: Dispatch<SetStateAction<number | null>>;
  setCtx: (c: { x: number; y: number; kind: "queue"; index: number } | null) => void;
  setDlgName: (s: string) => void;
  setDlg: (d: { kind: "save" } | null) => void;
  fail: (e: unknown) => void;
}) {
  const t = useT();
  return (
<>
  {queue.items.length > 0 && (
    <div className="brw__qtools">
      <span className="seg seg--ghost">
        <button
          title={t("lib.save")}
          onClick={() => {
            setDlgName("");
            setDlg({ kind: "save" });
          }}
        >
          {t("lib.save")}
        </button>
        <button onClick={() => void bridge.clearQueue().catch(fail)}>
          {t("lib.clear")}
        </button>
      </span>
      <span className="brw__qstat">
        {queue.items.length}{" "}
        {queue.items.length === 1 ? t("lib.track") : t("lib.tracks")} ·{" "}
        {formatTime(queueLeftMs)}
      </span>
    </div>
  )}
  <div className="lib">
    {queue.items.map((item, i) => {
      const current = queue.currentIndex === i;
      const ci = queue.currentIndex ?? -1;
      return (
        <Fragment key={item.path}>
          {current && (
            <div className="brw__kick brw__qsection">
              {t("fs.nowPlaying")}
            </div>
          )}
          {i === ci + 1 && (
            <div className="brw__kick brw__qsection">
              {t("brw.nextInQueue")}
            </div>
          )}
          <div
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") return navRow(e, 1);
            if (e.key === "ArrowUp") return navRow(e, -1);
            if (
              (e.key === "Enter" || e.key === " ") &&
              e.target === e.currentTarget
            ) {
              e.preventDefault();
              void bridge.playQueueIndex(i);
            }
          }}
          className={[
            "lib__row",
            "lib__row--num",
            current ? "lib__row--current" : "",
            dragIdx === i ? "lib__row--dragging" : "",
            dropIdx === i && dragIdx !== i ? "lib__row--dropover" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          draggable
          onDragStart={(e) => {
            /* Also published for rail-playlist drops. */
            e.dataTransfer.setData("application/x-noctbeat-track", item.path);
            e.dataTransfer.effectAllowed = "copyMove";
            setDragIdx(i);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDropIdx(i);
          }}
          onDragLeave={() => setDropIdx((d) => (d === i ? null : d))}
          onDrop={(e) => {
            e.preventDefault();
            if (dragIdx !== null && dragIdx !== i) {
              void bridge.queueMove(dragIdx, i).catch(fail);
            }
            setDragIdx(null);
            setDropIdx(null);
          }}
          onDragEnd={() => {
            setDragIdx(null);
            setDropIdx(null);
          }}
          onClick={() => void bridge.playQueueIndex(i)}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtx({ x: e.clientX, y: e.clientY, kind: "queue", index: i });
          }}
        >
          <span className="lib__idx">
            {current && playing ? (
              <span className="lib__eq" aria-hidden>
                <i />
                <i />
                <i />
              </span>
            ) : (
              i + 1
            )}
          </span>
          <Art url={item.track.artworkUrl} />
          <span className="lib__title">{item.track.title}</span>
          <span className="lib__sub">{item.track.artist}</span>
          <span className="lib__dur">
            {item.track.durationMs ? formatTime(item.track.durationMs) : ""}
          </span>
          <button
            className="lib__rm"
            aria-label={current ? t("fs.playingCantRemove") : t("fs.removeFromQueue")}
            title={current ? t("fs.playingCantRemove") : t("fs.removeFromQueue")}
            onClick={(e) => {
              e.stopPropagation();
              if (!current) void bridge.queueRemove(i).catch(fail);
            }}
          >
            <X size={13} />
          </button>
        </div>
        </Fragment>
      );
    })}
    {queue.items.length === 0 && (
      <span className="brw__empty">{t("lib.queueEmpty")}</span>
    )}
  </div>
</>
);
}
