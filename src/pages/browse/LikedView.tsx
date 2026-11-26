import { useT } from "../../i18n";
import { bridge, type PlaylistFile } from "../../bridge";
import { formatTime } from "../../lib";
import { Art } from "./bits";
import { Heart, MagnifyingGlass, Plus, Shuffle, X } from "@phosphor-icons/react";
import type { FavEntry } from "../../favs";

/** Liked-songs view: hero play button, shuffle + find tools, and the
    rows with per-track "add to playlist" popovers. */
export default function LikedView({
  liked,
  playLiked,
  shuffleLiked,
  plQuery,
  setPlQuery,
  likedShown,
  listLimit,
  navRow,
  playlists,
  addTo,
  setAddTo,
  flash,
  fail,
  listEndRef,
}: {
  liked: FavEntry[];
  playLiked: (e: FavEntry) => void;
  shuffleLiked: () => void;
  plQuery: string;
  setPlQuery: (s: string) => void;
  likedShown: FavEntry[];
  listLimit: number;
  navRow: (e: React.KeyboardEvent, dir: 1 | -1) => void;
  playlists: PlaylistFile[];
  addTo: { key: string; x: number; y: number } | null;
  setAddTo: (a: { key: string; x: number; y: number } | null) => void;
  flash: (msg: string) => void;
  fail: (e: unknown) => void;
  listEndRef: React.RefObject<HTMLDivElement>;
}) {
  const t = useT();
  return (
<>
  <button className="lib__hero" onClick={() => liked[0] && playLiked(liked[0])}>
    <span className="lib__heroicon">
      <Heart weight="fill" />
    </span>
    <span className="lib__herotxt">
      <span className="lib__herotitle">{t("lib.liked")}</span>
      <span className="lib__herosub">
        {liked.length} {liked.length === 1 ? t("lib.track") : t("lib.tracks")}
      </span>
    </span>
    <span className="lib__heroplay" aria-hidden>
      ▶
    </span>
  </button>
  {liked.length > 0 && (
    <div className="brw__qtools">
      <span className="seg seg--ghost">
        <button
          onClick={shuffleLiked}
          title={t("fs.shuffle")}
        >
          <Shuffle /> {t("fs.shuffle")}
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
  )}
  {liked.length === 0 && <span className="brw__empty">{t("lib.likedEmpty")}</span>}
  <div className="lib">
    {likedShown.slice(0, listLimit).map((e) => (
      <div
        key={e.key}
        className="lib__row"
        role="button"
        tabIndex={0}
        draggable={!e.trackId.startsWith("remote:")}
        onDragStart={(ev) => {
          ev.dataTransfer.setData("application/x-noctbeat-track", e.trackId);
          ev.dataTransfer.effectAllowed = "copy";
        }}
        onClick={() => playLiked(e)}
        onKeyDown={(ev) => {
          if (ev.key === "ArrowDown") return navRow(ev, 1);
          if (ev.key === "ArrowUp") return navRow(ev, -1);
          if (
            (ev.key === "Enter" || ev.key === " ") &&
            ev.target === ev.currentTarget
          ) {
            ev.preventDefault();
            playLiked(e);
          }
        }}
      >
        <Art url={e.artworkUrl} icon={<Heart weight="fill" />} />
        <span className="lib__title">{e.title}</span>
        <span className="lib__sub">{e.artist}</span>
        <span className="lib__dur">
          {e.durationMs ? formatTime(e.durationMs) : ""}
        </span>
        {playlists.length > 0 && (
          <span className="lib__pluswrap">
            <button
              className="lib__rm"
              title={t("lib.addToPlaylist")}
              aria-label={t("lib.addToPlaylist")}
              onClick={(ev) => {
                ev.stopPropagation();
                const r = ev.currentTarget.getBoundingClientRect();
                setAddTo(
                  addTo?.key === e.key
                    ? null
                    : { key: e.key, x: r.left, y: r.bottom + 6 },
                );
              }}
            >
              <Plus />
            </button>
            {addTo?.key === e.key && (
              <span
                className="brw__plmenu"
                style={{
                  left: Math.max(
                    8,
                    Math.min(addTo.x, window.innerWidth - 176),
                  ),
                  top: Math.min(addTo.y, window.innerHeight - 60),
                }}
                onClick={(ev) => ev.stopPropagation()}
              >
                {playlists.map((p) => (
                  <button
                    key={p.path}
                    title={p.name}
                    onClick={() => {
                      setAddTo(null);
                      void bridge
                        .playlistAddTracks(p.path, [e.trackId])
                        .then((n) => {
                          if (n > 0) flash(p.name);
                        })
                        .catch(fail);
                    }}
                  >
                    {p.name}
                  </button>
                ))}
              </span>
            )}
          </span>
        )}
      </div>
    ))}
  </div>
  {likedShown.length > listLimit && (
    <div ref={listEndRef} aria-hidden />
  )}
</>
);
}
