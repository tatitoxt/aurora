import { Fragment } from "react";
import { useT } from "../../i18n";
import { bridge, type CatalogSong, type QueueItem } from "../../bridge";
import { togglePreview, usePreviewing } from "./previewer";
import { formatTime } from "../../lib";
import { Art } from "./bits";
import { Heart, Play, User } from "@phosphor-icons/react";
import type { FavEntry } from "../../favs";

/** Artist page: header with art + play-all, your library rows for the
    artist, your liked songs by them, then the provider catalog
    grouped by album. */
export default function ArtistView({
  arName,
  arSongs,
  arLocal,
  arLiked,
  arGroups,
  arLoading,
  fail,
  playExternal,
  playLiked,
}: {
  arName: string;
  arSongs: CatalogSong[];
  arLocal: QueueItem[];
  arLiked: FavEntry[];
  arGroups: [string, CatalogSong[]][];
  arLoading: boolean;
  fail: (e: unknown) => void;
  playExternal: (query: string) => void;
  playLiked: (e: FavEntry, pool?: FavEntry[]) => void;
}) {
  const t = useT();
  const previewing = usePreviewing();
  return (
<div className="brw__section">
  <div className="brw__arhead">
    <Art
      url={arSongs[0]?.artworkUrl ?? arLocal[0]?.track.artworkUrl}
      icon={<User />}
    />
    <span className="brw__arname">{arName}</span>
    {(arLocal.length > 0 || arSongs.length > 0) && (
      <button
        className="brw__arplay"
        title={t("brw.playAll")}
        onClick={() => {
          if (arLocal.length > 0)
            void bridge.playItems(arLocal, 0).catch(fail);
          /* No remote-queue API exists — extPlay takes one
             query, so search the artist: the provider plays
             their top track rather than an arbitrary first
             catalog entry. */
          else if (arSongs.length > 0) playExternal(arName);
        }}
      >
        <Play weight="fill" />
      </button>
    )}
  </div>
  {arLoading && <span className="brw__empty">{t("srch.loading")}</span>}
  {!arLoading && arLocal.length === 0 && arSongs.length === 0 && (
    <span className="brw__empty">{t("brw.noTracks")}</span>
  )}
  {arLocal.length > 0 && (
    <>
      <span className="brw__kick">{t("brw.inLibrary")}</span>
    <div className="lib">
      {arLocal.map((it, i) => (
        <button
          className="lib__row"
          key={`${it.path}-${i}`}
          title={it.track.title}
          onClick={() => void bridge.playItems(arLocal, i).catch(fail)}
        >
          <span className="lib__idx">{i + 1}</span>
          <span className="lib__title">{it.track.title}</span>
          <span className="lib__sub">
            {it.track.album || it.track.artist}
          </span>
          <span className="lib__dur">
            {it.track.durationMs ? formatTime(it.track.durationMs) : ""}
          </span>
        </button>
      ))}
    </div>
    </>
  )}
  {arLiked.length > 0 && (
    <>
      <span className="brw__kick">{t("brw.inYourLiked")}</span>
      <div className="lib">
        {arLiked.slice(0, 5).map((e) => (
          <button
            className="lib__row"
            key={e.key}
            title={e.title}
            onClick={() => playLiked(e, arLiked)}
          >
            <Art url={e.artworkUrl} icon={<Heart weight="fill" />} />
            <span className="lib__title">{e.title}</span>
            <span className="lib__sub">{e.artist}</span>
            <span className="lib__dur">
              {e.durationMs ? formatTime(e.durationMs) : ""}
            </span>
          </button>
        ))}
      </div>
    </>
  )}
  {arSongs.length > 0 && (
    <>
      {arLocal.length > 0 && (
        <span className="brw__kick">{t("brw.fromCatalog")}</span>
      )}
    <div className="lib">
      {arGroups.map(([album, songs]) => (
        <Fragment key={album || "__singles"}>
          {/* Only label groups when albums actually exist —
              a flat list needs no header. */}
          {album !== "" && arGroups.length > 1 && (
            <div className="brw__kick brw__qsection">{album}</div>
          )}
          {songs.map((s, i) => (
            <button
              className="lib__row"
              key={`${s.title}-${album}-${i}`}
              title={s.title}
              onClick={() => playExternal(`${s.title} ${s.artist}`)}
            >
              <span className="lib__idx">
                {s.previewUrl ? (
                  <span
                    role="button"
                    tabIndex={0}
                    className={`brw__prevbtn ${previewing === s.previewUrl ? "on" : ""}`}
                    aria-label={t("brw.preview")}
                    title={t("brw.preview")}
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePreview(s.previewUrl!);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        togglePreview(s.previewUrl!);
                      }
                    }}
                  >
                    {previewing === s.previewUrl ? "❚❚" : "▶"}
                  </span>
                ) : (
                  i + 1
                )}
              </span>
              <span className="lib__title">{s.title}</span>
              <span className="lib__sub">{s.album || s.artist}</span>
              <span className="lib__dur">
                {s.durationMs ? formatTime(s.durationMs) : ""}
              </span>
            </button>
          ))}
        </Fragment>
      ))}
    </div>
    </>
  )}
</div>
);
}
