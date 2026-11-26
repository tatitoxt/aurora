import { useEffect } from "react";
import { useT } from "../../i18n";
import type { CatalogSong } from "../../bridge";
import { formatTime } from "../../lib";
import { Art } from "./bits";
import { stopPreview, togglePreview, usePreviewing } from "./previewer";
import { Play } from "@phosphor-icons/react";

/** Catalog album page inside Browse: release header, track rows and
    30-second previews. Catalog playback opens the connected provider. */
export default function AlbumView({
  artist,
  album,
  songs,
  loading,
  playExternal,
  goArtist,
}: {
  artist: string;
  album: string;
  songs: CatalogSong[];
  loading: boolean;
  playExternal: (query: string) => void;
  goArtist: (name: string) => void;
}) {
  const t = useT();
  const previewing = usePreviewing();
  useEffect(() => () => stopPreview(), []);
  const totalMs = songs.reduce((n, s) => n + (s.durationMs ?? 0), 0);
  const first = songs[0];

  return (
    <div className="brw__section">
      <div className="brw__arhead brw__alhead">
        <Art url={first?.artworkUrl} />
        <span className="brw__almeta">
          <small>{t("lib.albums")}</small>
          <span className="brw__arname">{album}</span>
          <button className="brw__alartist" onClick={() => goArtist(artist)} title={artist}>
            {artist}
          </button>
          {songs.length > 0 && (
            <small>
              {songs.length} {t("lib.tracks")}
              {totalMs > 0 ? ` · ${formatTime(totalMs)}` : ""}
            </small>
          )}
        </span>
        {first && (
          <button
            className="brw__arplay"
            title={t("brw.playAll")}
            aria-label={t("brw.playAll")}
            onClick={() => playExternal(`${first.title} ${first.artist}`)}
          >
            <Play weight="fill" />
          </button>
        )}
      </div>
      {loading && <span className="brw__empty">{t("srch.loading")}</span>}
      {!loading && songs.length === 0 && <span className="brw__empty">{t("brw.noTracks")}</span>}
      {songs.length > 0 && (
        <div className="lib lib--playlist">
          {songs.map((s, i) => (
            <button
              className="lib__row"
              key={`${s.title}-${i}`}
              title={`${s.title} — ${s.artist}`}
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
              <span className="lib__sub">{s.artist}</span>
              <span className="lib__dur">{s.durationMs ? formatTime(s.durationMs) : ""}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
