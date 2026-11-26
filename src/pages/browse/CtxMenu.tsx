import { useT } from "../../i18n";
import {
  bridge,
  type PlaylistFile,
  type PlaylistTrack,
  type QueueState,
} from "../../bridge";
import type { CtxState, DlgState, View } from "./types";
import type { Dispatch, SetStateAction } from "react";
import { pickImageFile, fileToCoverDataUrl, setPlaylistCover, playlistCover } from "./covers";

/** Right-click context menu for playlist rows, queue rows, rail
    playlists and the add-to-playlist picker. */
export default function CtxMenu({
  ctx,
  setCtx,
  playlists,
  plTracks,
  queue,
  sel,
  go,
  playPlTrack,
  removePlTrack,
  removeSelected,
  setDlg,
  setDlgName,
  flash,
  fail,
  deletePlaylistNow,
}: {
  ctx: NonNullable<CtxState>;
  setCtx: Dispatch<SetStateAction<CtxState>>;
  playlists: PlaylistFile[];
  plTracks: PlaylistTrack[];
  queue: QueueState;
  sel: Set<number>;
  go: (v: View) => void;
  playPlTrack: (i: number) => void;
  removePlTrack: (i: number) => void;
  removeSelected: () => void;
  setDlg: Dispatch<SetStateAction<DlgState>>;
  setDlgName: (s: string) => void;
  flash: (msg: string) => void;
  fail: (e: unknown) => void;
  deletePlaylistNow: (path: string, name: string) => void;
}) {
  const t = useT();
  return (
  <span
    className="brw__ctx"
    style={{
      left: Math.max(8, Math.min(ctx.x, window.innerWidth - 184)),
      top: Math.max(8, Math.min(ctx.y, window.innerHeight - 24)),
      maxHeight: window.innerHeight - 32,
      overflowY: "auto",
    }}
  >
    {ctx.kind === "pladd" &&
      playlists
        .filter((p) => /\.m3u8?$/i.test(p.path))
        .map((p) => (
          <button
            key={p.path}
            title={p.name}
            onClick={() => {
              const tp = ctx.path;
              setCtx(null);
              if (!tp) return;
              void bridge
                .playlistAddTracks(p.path, [tp])
                .then((n) => {
                  if (n > 0) flash(p.name);
                })
                .catch(fail);
            }}
          >
            {p.name}
          </button>
        ))}
    {ctx.kind !== "railpl" && ctx.kind !== "pladd" && (
      <button
        onClick={() => {
          setCtx(null);
          if (ctx.kind === "pl") playPlTrack(ctx.index);
          else void bridge.playQueueIndex(ctx.index);
        }}
      >
        {t("brw.play")}
      </button>
    )}
    {ctx.kind === "railpl" && (
      <>
        <button
          onClick={() => {
            setCtx(null);
            setDlgName(ctx.name ?? "");
            setDlg({
              kind: "rename",
              path: ctx.path ?? "",
              name: ctx.name ?? "",
            });
          }}
        >
          {t("lib.rename")}
        </button>
        <button
          onClick={() => {
            setCtx(null);
            const path = ctx.path ?? "";
            void pickImageFile().then(async (f) => {
              if (!f) return;
              try {
                setPlaylistCover(path, await fileToCoverDataUrl(f));
              } catch {
                fail(new Error("unreadable image"));
              }
            });
          }}
        >
          {t("lib.setCover")}
        </button>
        {ctx.path && playlistCover(ctx.path) && (
          <button
            onClick={() => {
              setCtx(null);
              setPlaylistCover(ctx.path ?? "", null);
            }}
          >
            {t("lib.removeCover")}
          </button>
        )}
                <button
          onClick={() => {
            setCtx(null);
            deletePlaylistNow(ctx.path ?? "", ctx.name ?? "");
          }}
        >
          {t("lib.delete")}
        </button>
      </>
    )}
    {ctx.kind === "pl" && plTracks[ctx.index]?.artist && (
        <button
          onClick={() => {
            setCtx(null);
            go(`ar:${encodeURIComponent(plTracks[ctx.index].artist)}`);
          }}
        >
          {t("brw.goToArtist")}
        </button>
      )}
    {ctx.kind === "pl" && (
      <button
        onClick={() => {
          setCtx(null);
          /* A selected row's Remove honors the selection —
             deleting just the clicked row would silently drop
             the user's multi-select intent. */
          if (sel.size > 1 && sel.has(ctx.index)) removeSelected();
          else removePlTrack(ctx.index);
        }}
      >
        {t("lib.removeFromPlaylist")}
      </button>
    )}
    {/* Only m3u destinations accept writes, and streams
        can't be copied into a file playlist — offer the item
        only when both ends can actually work. */}
    {(ctx.kind === "pl" || ctx.kind === "queue") &&
      playlists.some((p) => /\.m3u8?$/i.test(p.path)) &&
      !(ctx.kind === "pl"
        ? plTracks[ctx.index]?.remote
        : /^(remote:|https?:)/i.test(
            queue.items[ctx.index]?.path ?? "",
          )) && (
        <button
          onClick={() =>
            setCtx({
              x: ctx.x,
              y: ctx.y,
              kind: "pladd",
              index: ctx.index,
              path:
                ctx.kind === "pl"
                  ? plTracks[ctx.index]?.path
                  : queue.items[ctx.index]?.path,
            })
          }
        >
          {t("lib.addToPlaylist")}…
        </button>
      )}
    {ctx.kind === "queue" &&
      queue.items[ctx.index]?.track.artist && (
        <button
          onClick={() => {
            setCtx(null);
            go(
              `ar:${encodeURIComponent(queue.items[ctx.index].track.artist)}`,
            );
          }}
        >
          {t("brw.goToArtist")}
        </button>
      )}
    {ctx.kind === "queue" && queue.currentIndex !== ctx.index && (
      <button
        onClick={() => {
          setCtx(null);
          void bridge.queueRemove(ctx.index).catch(fail);
        }}
      >
        {t("fs.removeFromQueue")}
      </button>
    )}
  </span>
);
}
