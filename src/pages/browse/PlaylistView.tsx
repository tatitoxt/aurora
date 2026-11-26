import { useT } from "../../i18n";
import {
  bridge,
  type PlaylistFile,
  type PlaylistTrack,
} from "../../bridge";
import { formatTime } from "../../lib";
import { Art, GenCover } from "./bits";
import { usePlaylistCovers } from "./covers";
import {
  CaretDown,
  CaretUp,
  CaretUpDown,
  Clock,
  MagnifyingGlass,
  PencilSimple,
  Play,
  Playlist,
  Shuffle,
  Trash,
  X,
} from "@phosphor-icons/react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { CtxState, DlgState, View } from "./types";

type Sel = Set<number>;

/** Playlist detail view: header with art + actions + find box,
    sortable column head, rows with multi-select/drag-reorder, and the
    selection action bar. */
export default function PlaylistView({
  view,
  plArt,
  plName,
  plTracks,
  setPlTracks,
  plLoading,
  playlists,
  plQuery,
  setPlQuery,
  plSort,
  toggleSort,
  plShown,
  isNow,
  playing,
  sel,
  setSel,
  selAnchor,
  dragIdx,
  setDragIdx,
  dropIdx,
  setDropIdx,
  navRow,
  removeSelected,
  playPlTrack,
  removePlTrack,
  listLimit,
  listEndRef,
  setCtx,
  setDlg,
  deletePlaylistNow,
  setDlgName,
  setShuffle,
  playPlaylist,
  fail,
}: {
  view: View;
  plArt: string | undefined;
  plName: string;
  plTracks: PlaylistTrack[];
  setPlTracks: Dispatch<SetStateAction<PlaylistTrack[]>>;
  plLoading: boolean;
  playlists: PlaylistFile[];
  plQuery: string;
  setPlQuery: (s: string) => void;
  plSort: { key: "title" | "artist" | "duration" | null; dir: 1 | -1 };
  toggleSort: (key: "title" | "artist" | "duration") => void;
  plShown: { t: PlaylistTrack; i: number }[];
  isNow: (pt: PlaylistTrack) => boolean;
  playing: boolean;
  sel: Sel;
  setSel: Dispatch<SetStateAction<Sel>>;
  selAnchor: MutableRefObject<number | null>;
  dragIdx: number | null;
  setDragIdx: (i: number | null) => void;
  dropIdx: number | null;
  setDropIdx: Dispatch<SetStateAction<number | null>>;
  navRow: (e: React.KeyboardEvent, dir: 1 | -1) => void;
  removeSelected: () => void;
  playPlTrack: (i: number) => void;
  removePlTrack: (i: number) => void;
  listLimit: number;
  listEndRef: React.RefObject<HTMLDivElement>;
  setCtx: Dispatch<SetStateAction<CtxState>>;
  setDlg: Dispatch<SetStateAction<DlgState>>;
  deletePlaylistNow: (path: string, name: string) => void;
  setDlgName: (s: string) => void;
  setShuffle: (b: boolean) => void;
  playPlaylist: (p: PlaylistFile, shuffled?: boolean) => void;
  fail: (e: unknown) => void;
}) {
  const t = useT();
  const covers = usePlaylistCovers();
  const plPath = view.startsWith("pl:") ? view.slice(3) : "";
  const cover = plPath ? covers[plPath] : undefined;
  return (
<>
  <div className="brw__plhead">
    <span className="brw__plart">
      {cover ? (
        <img className="brw__art" src={cover} alt="" />
      ) : plArt ? (
        <Art url={plArt} icon={<Playlist />} />
      ) : (
        <GenCover name={plName} />
      )}
    </span>
    <span className="brw__plmeta">
      <span className="brw__plt">{plName}</span>
      <span className="brw__pls">
        {plTracks.length} {plTracks.length === 1 ? t("lib.track") : t("lib.tracks")}
        {plTracks.some((pt) => pt.durationMs > 0) && (
          <>
            {" · "}
            {formatTime(
              plTracks.reduce((ms, pt) => ms + pt.durationMs, 0),
            )}
            {/* '+' flags a subtotal: some rows report no length. */}
            {plTracks.some((pt) => pt.durationMs === 0) ? "+" : ""}
          </>
        )}
      </span>
    </span>
    <span className="seg seg--ghost">
      <button
        title={t("fs.shuffle")}
        onClick={() => {
          const p = playlists.find((x) => `pl:${x.path}` === view);
          if (!p) return;
          void bridge
            .setShuffle(true)
            .then(() => {
              setShuffle(true);
              playPlaylist(p, true);
            })
            .catch(fail);
        }}
      >
        <Shuffle /> {t("fs.shuffle")}
      </button>
      <button
        onClick={() => {
          const p = playlists.find((x) => `pl:${x.path}` === view);
          if (p) playPlaylist(p);
        }}
      >
        <Play weight="fill" /> {t("brw.playAll")}
      </button>
      <button
        title={t("lib.rename")}
        onClick={() => {
          const p = playlists.find((x) => `pl:${x.path}` === view);
          if (!p) return;
          setDlgName(p.name);
          setDlg({ kind: "rename", path: p.path, name: p.name });
        }}
      >
        <PencilSimple /> {t("lib.rename")}
      </button>
      <button
        title={t("lib.delete")}
        onClick={() => {
          const p = playlists.find((x) => `pl:${x.path}` === view);
          if (!p) return;
          deletePlaylistNow(p.path, p.name);
        }}
      >
        <Trash /> {t("lib.delete")}
      </button>
      <label className="brw__plfind" title={t("brw.findInPlaylist")}>
        <MagnifyingGlass />
        <input
          value={plQuery}
          placeholder={t("brw.findInPlaylist")}
          onChange={(e) => setPlQuery(e.target.value)}
        />
        {plQuery && (
          <button
            title={t("lib.clear")}
            aria-label={t("lib.clear")}
            onClick={() => setPlQuery("")}
          >
            <X />
          </button>
        )}
      </label>
    </span>
  </div>
  {plLoading && <span className="brw__empty">{t("srch.loading")}</span>}
  {plTracks.length > 0 && (
    <div className="brw__colhead" aria-hidden>
      <span>#</span>
      <button
        className={plSort.key === "title" ? "on" : ""}
        onClick={() => toggleSort("title")}
        title={t("brw.colTitle")}
      >
        {t("brw.colTitle")}
        {plSort.key === "title" ? (
          plSort.dir === 1 ? (
            <CaretUp />
          ) : (
            <CaretDown />
          )
        ) : (
          <CaretUpDown />
        )}
      </button>
      <button
        className={plSort.key === "artist" ? "on" : ""}
        onClick={() => toggleSort("artist")}
        title={t("srch.artist")}
      >
        {t("srch.artist")}
        {plSort.key === "artist" ? (
          plSort.dir === 1 ? (
            <CaretUp />
          ) : (
            <CaretDown />
          )
        ) : (
          <CaretUpDown />
        )}
      </button>
      <button
        className={`brw__coldur ${plSort.key === "duration" ? "on" : ""}`}
        onClick={() => toggleSort("duration")}
        title={t("brw.colDuration")}
      >
        <Clock />
        {plSort.key === "duration" ? (
          plSort.dir === 1 ? (
            <CaretUp />
          ) : (
            <CaretDown />
          )
        ) : (
          <CaretUpDown />
        )}
      </button>
    </div>
  )}
  <div className={sel.size > 0 ? "lib lib--selpad" : "lib"}>
    {plShown.slice(0, listLimit).map(({ t: pt, i }, di) => {
      const current = isNow(pt);
      return (
      <div
        className={[
          "lib__row",
          current ? "lib__row--current" : "",
          sel.has(i) ? "lib__row--sel" : "",
          dragIdx === i ? "lib__row--dragging" : "",
          dropIdx === i && dragIdx !== i ? "lib__row--dropover" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        role="button"
        tabIndex={0}
        key={`${pt.path}-${i}`}
        title={pt.title || pt.path.split("/").pop()}
        /* Sorted/filtered rows don't map to file indices —
           Spotify locks manual reorder the same way. */
        draggable={!plQuery.trim() && !plSort.key}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-noctbeat-track", pt.path);
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
          const p = playlists.find((x) => `pl:${x.path}` === view);
          if (p && dragIdx !== null && dragIdx !== i) {
            const from = dragIdx;
            /* A move renumbers the file — drop the
               selection instead of pointing it at the
               wrong tracks. */
            setSel(new Set());
            selAnchor.current = null;
            setPlTracks((ts) => {
              const n = [...ts];
              const [m] = n.splice(from, 1);
              n.splice(i, 0, m);
              return n;
            });
            void bridge
              .playlistMoveTrack(p.path, from, i)
              .catch((err) => {
                fail(err);
                return bridge
                  .playlistTracks(p.path)
                  .then(setPlTracks)
                  .catch(() => {});
              });
          }
          setDragIdx(null);
          setDropIdx(null);
        }}
        onDragEnd={() => {
          setDragIdx(null);
          setDropIdx(null);
        }}
        onClick={(e) => {
          /* Spotify-style multi-select: Shift = range from the
             last picked row, Cmd/Ctrl toggles one row. A plain
             click still plays the track. */
          if (e.shiftKey || e.metaKey || e.ctrlKey) {
            /* Ranges span display order — under a filter or
               sort, picking a visible run must not rope in
               the hidden tracks between them in the file. */
            setSel((s) => {
              const n = new Set(s);
              if (e.shiftKey && selAnchor.current !== null) {
                const a = Math.min(selAnchor.current, di);
                const b = Math.max(selAnchor.current, di);
                for (let k = a; k <= b; k++) {
                  const row = plShown[k];
                  if (row) n.add(row.i);
                }
              } else if (n.has(i)) n.delete(i);
              else n.add(i);
              return n;
            });
            selAnchor.current = di;
            return;
          }
          /* Spotify semantics: plain click selects the row, double
             click plays. Reproducing on single click meant the first
             click after a ctrl+click selection spree fired playback. */
          setSel(new Set([i]));
          selAnchor.current = di;
        }}
        onDoubleClick={(e) => {
          if (e.shiftKey || e.metaKey || e.ctrlKey) return;
          setSel(new Set());
          playPlTrack(i);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtx({ x: e.clientX, y: e.clientY, kind: "pl", index: i });
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") return navRow(e, 1);
          if (e.key === "ArrowUp") return navRow(e, -1);
          if (
            (e.key === "Delete" || e.key === "Backspace") &&
            sel.size > 0
          ) {
            e.preventDefault();
            removeSelected();
            return;
          }
          if (
            (e.key === "Enter" || e.key === " ") &&
            e.target === e.currentTarget
          ) {
            e.preventDefault();
            playPlTrack(i);
          }
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
        <span className="lib__title">{pt.title || pt.path.split("/").pop()}</span>
        <span className="lib__sub">{pt.artist}</span>
        <span className="lib__dur">
          {pt.remote ? "stream" : pt.durationMs ? formatTime(pt.durationMs) : ""}
        </span>
        <button
          className="lib__rm"
          title={t("lib.removeFromPlaylist")}
          aria-label={t("lib.removeFromPlaylist")}
          onClick={(e) => {
            e.stopPropagation();
            removePlTrack(i);
          }}
        >
          <X />
        </button>
      </div>
      );
    })}
  </div>
  {plShown.length > listLimit && (
    <div ref={listEndRef} aria-hidden />
  )}
  {sel.size > 0 && (
    <div className="brw__selbar">
      <b>{sel.size}</b>
      <button
        className="brw__selbtn"
        onClick={removeSelected}
        title={t("lib.removeFromPlaylist")}
      >
        <Trash /> {t("lib.removeFromPlaylist")}
      </button>
      <button
        className="brw__selbtn"
        onClick={() => setSel(new Set())}
        title={t("brw.cancel")}
      >
        {t("brw.cancel")}
      </button>
    </div>
  )}
</>
);
}
