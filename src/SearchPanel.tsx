import { useEffect, useMemo, useState, type ReactNode } from "react";
import { bridge, type CatalogSong } from "./bridge";
import { togglePreview, usePreviewing } from "./pages/browse/previewer";
import { useT } from "./i18n";
import { artistCards, formatTime } from "./lib";

/** Tab providers tried, in order, when the picker is on Automatic. */
const AUTO_ORDER = [
  "spotify",
  "youtube",
  "soundcloud",
  "apple",
  "tidal",
  "amazon",
];

/**
 * Spotify-style search: catalog metadata (top result, artists, songs)
 * shows instantly; the pick plays in the user's connected provider tab
 * through the Noctbeat Bridge extension.
 */
export default function SearchPanel({
  src,
  label,
  connected,
  onPlayed,
  query,
  onQuery,
  aside,
  songLimit,
  onArtist,
  filter = "all",
}: {
  src: string;
  label: (id: string) => string;
  connected: Set<string | null>;
  onPlayed: () => void;
  /** Controlled query (e.g. a persistent rail search bar owns it). */
  query?: string;
  onQuery?: (q: string) => void;
  /** Extra content for the right column on wide layouts (e.g. playlists). */
  aside?: ReactNode;
  /** Cap the songs block (Spotify's short "Songs" list); artist pages show all. */
  songLimit?: number;
  /** Route artist clicks externally (e.g. Browse pushes its own artist
      view onto the history stack) instead of the internal sub-page. */
  onArtist?: (name: string) => void;
  /** Spotify-style section filter for the caller's filter chips. */
  filter?: "all" | "songs" | "artists" | "none";
}) {
  const t = useT();
  const previewing = usePreviewing();
  const [qLocal, setQLocal] = useState("");
  const q = query ?? qLocal;
  const setQ = onQuery ?? setQLocal;
  const [songs, setSongs] = useState<CatalogSong[]>([]);
  const [artist, setArtist] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    const term = q.trim();
    setArtist(null);
    if (!term) {
      setSongs([]);
      setErr("");
      setNote("");
      return;
    }
    let live = true;
    const id = setTimeout(() => {
      setLoading(true);
      void bridge
        .catalogSearch(term)
        .then((r) => live && (setSongs(r), setErr("")))
        .catch((e) => live && setErr(String(e)))
        .finally(() => live && setLoading(false));
    }, 300);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [q]);

  const artists = useMemo(() => artistCards(songs), [songs]);

  // An artist page lists that artist's own catalog, not just this query's hits.
  const openArtist = (name: string) => {
    if (onArtist) {
      onArtist(name);
      return;
    }
    setArtist(name);
    void bridge
      .catalogSearch(name)
      .then((r) =>
        setSongs((prev) => {
          const seen = new Set(prev.map((s) => `${s.title}:${s.artist}`));
          return [
            ...prev,
            ...r.filter((s) => !seen.has(`${s.title}:${s.artist}`)),
          ];
        }),
      )
      .catch(() => {});
  };

  const term = q.trim().toLowerCase();
  const topArtist = artists.find(([n]) => n.toLowerCase() === term);
  const shown = artist
    ? songs.filter((s) => s.artist.toLowerCase().includes(artist.toLowerCase()))
    : songs;
  const top = shown[0];
  const listed = !artist && songLimit ? shown.slice(0, songLimit) : shown;

  const target =
    src === "auto"
      ? (AUTO_ORDER.find((p) => connected.has(p)) ?? "youtube")
      : src;

  const play = (s: CatalogSong) => {
    setErr("");
    setNote("");
    const query = `${s.title} ${s.artist}`;
    if (connected.has(target)) {
      void bridge
        .extPlay(target, query)
        .then((ok) =>
          ok
            ? (setNote(t("fs.playingInTab", { src: label(target) })),
              onPlayed())
            : setErr(t("fs.noTab", { src: label(target) })),
        )
        .catch((e) => setErr(String(e)));
      return;
    }
    setErr(t("fs.noTab", { src: label(target) }));
  };

  return (
    <div className="srch">
      <input
        className="fs__provq"
        autoFocus
        value={q}
        placeholder={t("fs.searchSongs")}
        onChange={(e) => setQ(e.target.value)}
        /* Enter plays the top song only when songs are on screen —
           the Artists/Playlists filters hide them. */
        onKeyDown={(e) =>
          e.key === "Enter" &&
          top &&
          filter !== "artists" &&
          filter !== "none" &&
          play(top)
        }
      />
      {err && <span className="fs__proverr">{err}</span>}
      {note && !err && <span className="fs__extlive">● {note}</span>}
      {loading && songs.length === 0 && (
        <span className="srch__note">{t("srch.loading")}</span>
      )}
      {!loading && term && songs.length === 0 && !err && (
        <span className="srch__note">{t("srch.empty")}</span>
      )}
      {shown.length > 0 && (
        <div className="srch__body">
          {filter === "all" && !artist && <span className="srch__h">{t("srch.top")}</span>}
          {filter !== "all" || artist ? null : topArtist ? (
            <button
              className="srch__top"
              title={topArtist[0]}
              onClick={() => openArtist(topArtist[0])}
            >
              <img
                className="srch__topart srch__topart--round"
                src={topArtist[1]}
                alt=""
              />
              <span className="srch__toptitle">{topArtist[0]}</span>
              <span className="srch__tag">{t("srch.artist")}</span>
            </button>
          ) : (
            <button
              className="srch__top"
              title={`${top.title} — ${top.artist}`}
              onClick={() => play(top)}
            >
              <img className="srch__topart" src={top.artworkUrl} alt="" />
              <span className="srch__toptitle">{top.title}</span>
              <span className="srch__sub">
                <span className="srch__tag">{t("srch.song")}</span> {top.artist}
              </span>
            </button>
          )}
          {!artist &&
            (filter === "artists" ? artists.length > 0 : artists.length > 1) &&
            filter !== "songs" &&
            filter !== "none" && (
            <>
              <span className="srch__h">{t("srch.artists")}</span>
              <div className="srch__artists">
                {artists.map(([name, art]) => (
                  <button
                    key={name}
                    className="srch__artist"
                    title={name}
                    onClick={() => openArtist(name)}
                  >
                    <img src={art} alt="" />
                    <span>{name}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {filter !== "artists" && filter !== "none" && (
            <>
          <span className="srch__h">
            {artist ? (
              <button
                className="srch__back"
                title={t("srch.allResults")}
                onClick={() => setArtist(null)}
              >
                ‹ {artist}
              </button>
            ) : (
              t("srch.songs")
            )}
          </span>
          <div className="srch__songs">
            {listed.map((s, i) => (
              <div
                key={`${s.title}:${s.artist}:${i}`}
                className="srch__row"
                role="button"
                tabIndex={0}
                title={`${s.title} — ${s.artist}`}
                onClick={() => play(s)}
                onKeyDown={(e) => e.key === "Enter" && play(s)}
              >
                {s.previewUrl ? (
                  <span
                    role="button"
                    tabIndex={0}
                    className={`srch__prevwrap ${previewing === s.previewUrl ? "on" : ""}`}
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
                    <img src={s.artworkUrl} alt="" />
                    <span className="srch__previcon" aria-hidden>
                      {previewing === s.previewUrl ? "❚❚" : "▶"}
                    </span>
                  </span>
                ) : (
                  <img src={s.artworkUrl} alt="" />
                )}
                <span className="srch__meta">
                  <span className="srch__title">{s.title}</span>
                  <span className="srch__sub">{s.artist}</span>
                </span>
                <span className="srch__dur">
                  {s.durationMs ? formatTime(s.durationMs) : ""}
                </span>
              </div>
            ))}
          </div>
            </>
          )}
          {aside && <div className="srch__aside">{aside}</div>}
        </div>
      )}
    </div>
  );
}
