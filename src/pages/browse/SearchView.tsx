import { useT } from "../../i18n";
import SearchPanel from "../../SearchPanel";
import { Playlist, X } from "@phosphor-icons/react";
import { CATEGORIES, RECENT_SEARCHES_KEY } from "./types";
import type { PlaylistFile } from "../../bridge";

/** Search view: filter chips, recent searches, the provider-backed
    SearchPanel with a playlist aside, and the "Browse all" category
    grid on the empty state. */
export default function SearchView({
  q,
  setQ,
  sFilter,
  setSFilter,
  recentSearches,
  setRecentSearches,
  connected,
  refresh,
  pushSearch,
  openPlaylist,
  playlists,
  goArtist,
}: {
  q: string;
  setQ: (s: string) => void;
  sFilter: "all" | "songs" | "artists" | "playlists";
  setSFilter: (f: "all" | "songs" | "artists" | "playlists") => void;
  recentSearches: string[];
  setRecentSearches: (s: string[]) => void;
  connected: Set<string | null>;
  refresh: () => void;
  pushSearch: (s: string) => void;
  openPlaylist: (p: PlaylistFile) => void;
  playlists: PlaylistFile[];
  goArtist: (name: string) => void;
}) {
  const t = useT();
  return (
<div className="brw__search">
  {q.trim() !== "" && (
    <span className="brw__chips seg seg--ghost">
      {(["all", "songs", "artists", "playlists"] as const).map((f) => (
        <button
          key={f}
          className={sFilter === f ? "on" : ""}
          onClick={() => setSFilter(f)}
        >
          {f === "all"
            ? t("brw.all")
            : f === "songs"
              ? t("srch.songs")
              : f === "artists"
                ? t("srch.artists")
                : t("lib.playlists")}
        </button>
      ))}
    </span>
  )}
  {q.trim() === "" && recentSearches.length > 0 && (
    <div className="brw__rsearch">
      <span className="brw__kick">{t("brw.recentSearches")}</span>
      <div className="brw__rchips">
        {recentSearches.map((s) => (
          <button
            key={s}
            className="brw__rchip"
            title={s}
            onClick={() => setQ(s)}
          >
            {s}
          </button>
        ))}
        <button
          className="brw__rchip"
          title={t("lib.clear")}
          aria-label={t("lib.clear")}
          onClick={() => {
            setRecentSearches([]);
            try {
              localStorage.removeItem(RECENT_SEARCHES_KEY);
            } catch {}
          }}
        >
          <X />
        </button>
      </div>
    </div>
  )}
  <SearchPanel
    src="auto"
    label={(id) => id}
    connected={connected}
    onPlayed={() => {
      refresh();
      pushSearch(q);
    }}
    query={q}
    onQuery={setQ}
    songLimit={6}
    onArtist={goArtist}
    filter={sFilter === "playlists" ? "none" : sFilter}
    aside={
      (sFilter === "all" || sFilter === "playlists") &&
      playlists.length > 0 ? (
        <>
          <span className="srch__h">{t("lib.playlists")}</span>
          <div className="srch__pllist">
            {playlists
              .filter((p) =>
                p.name
                  .toLowerCase()
                  .includes(q.trim().toLowerCase()),
              )
              .map((p) => (
              <button
                key={p.path}
                className="srch__pl"
                title={p.name}
                onClick={() => openPlaylist(p)}
              >
                <Playlist />
                <span>{p.name}</span>
              </button>
            ))}
          </div>
        </>
      ) : undefined
    }
  />
  {/* "Browse all" category grid under the search field, the
      same order Spotify uses on its empty search page. */}
  {q.trim() === "" && (
    <>
      <span className="brw__kick">{t("brw.browseAll")}</span>
      <div className="brw__cats">
        {CATEGORIES.map((c) => (
          <button
            key={c.k}
            className="brw__cat"
            style={{
              background: `linear-gradient(135deg, hsl(${c.hue} 62% 46%), hsl(${c.hue} 68% 27%))`,
            }}
            /* A stale chip filter would hide the catalog
               results this tile asks for. */
            onClick={() => {
              setQ(c.q);
              setSFilter("all");
            }}
            title={c.q}
          >
            <span className="brw__catname">{t(c.k)}</span>
          </button>
        ))}
      </div>
    </>
  )}
</div>
);
}
