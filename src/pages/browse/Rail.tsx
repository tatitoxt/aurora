import { useT } from "../../i18n";
import { bridge, type PlaylistFile, type PlaylistTrack, type QueueState } from "../../bridge";
import {
  Broadcast,
  Heart,
  House,
  ListBullets,
  MagnifyingGlass,
  Playlist,
  Plus,
} from "@phosphor-icons/react";
import type { Dispatch, SetStateAction } from "react";
import type { CtxState, DlgState, View } from "./types";
import type { FavEntry } from "../../favs";

/** Left rail: brand + inline search, primary nav (Home/Liked/Up
    next/Services), and the playlist list with create button,
    right-click menu and drag-drop track targets. */
export default function Rail({
  view,
  q,
  setQ,
  go,
  railSearchRef,
  liked,
  queue,
  playlists,
  openPlaylist,
  plDrop,
  setPlDrop,
  setCtx,
  setDlg,
  setDlgName,
  setPlTracks,
  flash,
  fail,
}: {
  view: View;
  q: string;
  setQ: (s: string) => void;
  go: (v: View) => void;
  railSearchRef: React.RefObject<HTMLInputElement>;
  liked: FavEntry[];
  queue: QueueState;
  playlists: PlaylistFile[];
  openPlaylist: (p: PlaylistFile) => void;
  plDrop: string | null;
  setPlDrop: Dispatch<SetStateAction<string | null>>;
  setCtx: Dispatch<SetStateAction<CtxState>>;
  setDlg: Dispatch<SetStateAction<DlgState>>;
  setDlgName: (s: string) => void;
  setPlTracks: (ts: PlaylistTrack[]) => void;
  flash: (msg: string) => void;
  fail: (e: unknown) => void;
}) {
  const t = useT();
  return (
    <aside className="brw__rail">
  <span className="brw__top">
    <span className="brw__brand" title={bridge.productName}>
      <img className="brw__logo" src="/noctbeat-mark.svg" alt={bridge.productName} />
    </span>
    <label
      className={`brw__railsearch ${view === "search" ? "on" : ""}`}
      /* Click or typing switches to Search — plain keyboard
         focus must not, or tabbing past the rail would jump
         the user into SearchPanel's autofocused input. The
         same click also opens Search when the input is
         collapsed to just an icon in narrow windows. */
      onClick={() => go("search")}
    >
      <MagnifyingGlass weight={view === "search" ? "fill" : "regular"} />
      <input
        ref={railSearchRef}
        value={q}
        placeholder={t("fs.searchSongs")}
        aria-label={t("brw.search")}
        onKeyDown={(e) => {
          if (e.key === "Escape" && q) {
            e.stopPropagation();
            setQ("");
          }
        }}
        onChange={(e) => {
          setQ(e.target.value);
          /* During IME composition the interim events would yank
             focus to SearchPanel mid-composition — only switch
             once the text is committed. */
          if (!(e.nativeEvent as InputEvent).isComposing) go("search");
        }}
        /* Committing the same interim text fires no onChange —
           open Search when the composition ends instead. A
           canceled composition ends with empty data and must
           not switch the view. */
        onCompositionEnd={(e) => {
          if (e.data !== "") go("search");
        }}
      />
    </label>
  </span>
  <button
    className={`brw__nav ${view === "home" ? "on" : ""}`}
    onClick={() => go("home")}
  >
    <House weight={view === "home" ? "fill" : "regular"} />
    <span>{t("brw.home")}</span>
  </button>
  <button
    className={`brw__nav ${view === "liked" ? "on" : ""}`}
    onClick={() => go("liked")}
  >
    <Heart weight={view === "liked" ? "fill" : "regular"} />
    <span>{t("lib.liked")}</span>
    {liked.length > 0 && <em>{liked.length}</em>}
  </button>
  <button
    className={`brw__nav ${view === "queue" ? "on" : ""}`}
    onClick={() => go("queue")}
  >
    <ListBullets weight={view === "queue" ? "fill" : "regular"} />
    <span>{t("fs.upNext")}</span>
    {queue.items.length > 0 && <em>{queue.items.length}</em>}
  </button>
  <button
    className={`brw__nav ${view === "services" ? "on" : ""}`}
    onClick={() => go("services")}
  >
    <Broadcast weight={view === "services" ? "fill" : "regular"} />
    <span>{t("sources.heading")}</span>
  </button>

  <span className="brw__railhead">
    {t("lib.playlists")}
    <button
      className="brw__railadd"
      title={t("lib.newPlaylist")}
      aria-label={t("lib.newPlaylist")}
      onClick={() => {
        setDlgName(t("lib.newPlaylist"));
        setDlg({ kind: "create" });
      }}
    >
      <Plus />
    </button>
  </span>
  <div className="brw__pllist">
    {playlists.map((p) => (
      <button
        key={p.path}
        className={`brw__nav brw__nav--pl ${view === `pl:${p.path}` ? "on" : ""} ${plDrop === p.path ? "brw__nav--drop" : ""}`}
        onClick={() => openPlaylist(p)}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtx({
            x: e.clientX,
            y: e.clientY,
            kind: "railpl",
            index: 0,
            path: p.path,
            name: p.name,
          });
        }}
        onDragOver={(e) => {
          if (
            e.dataTransfer.types.includes("application/x-noctbeat-track")
          ) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setPlDrop(p.path);
          }
        }}
        onDragLeave={() => setPlDrop((d) => (d === p.path ? null : d))}
        onDrop={(e) => {
          e.preventDefault();
          setPlDrop(null);
          const tp = e.dataTransfer.getData("application/x-noctbeat-track");
          /* Streams and remote: refs aren't files — the backend would
             skip them silently, so don't pretend the drop did anything. */
          if (!tp || /^(remote:|https?:)/i.test(tp)) return;
          void bridge
            .playlistAddTracks(p.path, [tp])
            .then((n) => {
              if (n > 0) flash(p.name);
              if (view === `pl:${p.path}`)
                return bridge.playlistTracks(p.path).then(setPlTracks);
            })
            .catch(fail);
        }}
      >
        <Playlist />
        <span>{p.name}</span>
      </button>
    ))}
    {playlists.length === 0 && (
      <span className="brw__railempty">{t("lib.playlistsEmpty")}</span>
    )}
  </div>
    </aside>
  );
}
