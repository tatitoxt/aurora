import { useEffect, useMemo, useState, type ReactNode } from "react";
import { bridge, type CatalogSong } from "./bridge";
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
}) {
  const t = useT();
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
        onKeyDown={(e) => e.key === "Enter" && top && play(top)}
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
          {!artist && <span className="srch__h">{t("srch.top")}</span>}
          {artist ? null : topArtist ? (
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
          {!artist && artists.length > 1 && (
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
            {shown.map((s, i) => (
              <div
                key={`${s.title}:${s.artist}:${i}`}
                className="srch__row"
                role="button"
                tabIndex={0}
                title={`${s.title} — ${s.artist}`}
                onClick={() => play(s)}
                onKeyDown={(e) => e.key === "Enter" && play(s)}
              >
                <img src={s.artworkUrl} alt="" />
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
          {aside && <div className="srch__aside">{aside}</div>}
        </div>
      )}
    </div>
  );
}
