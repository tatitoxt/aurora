import { useT } from "../i18n";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  bridge,
  type NowPlaying,
  type PlaylistFile,
  type PlaylistTrack,
  type QueueItem,
  type QueueState,
} from "../bridge";
import { subscribe } from "../bridge";
import {
  favKeys,
  listable,
  loadFavs,
  remoteParts,
  replayFor,
  subscribeFavs,
  toggleFav,
  toQueueItem,
  type FavEntry,
} from "../favs";
import { formatTime } from "../lib";
import {
  Heart,
  ListBullets,
  Playlist,
  MagnifyingGlass,
  MusicNote,
  PencilSimple,
  Plus,
  Trash,
  X,
} from "@phosphor-icons/react";
import { artSrc } from "../bridge";
import ArtBackdrop from "../ArtBackdrop";

/** 32px rounded row cover: real artwork when the file has art, else a
 * soft glass disc with an icon. */
function LibThumb({ url, icon }: { url?: string; icon?: React.ReactNode }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    setSrc("");
    if (!url) return;
    let live = true;
    void artSrc(url).then((s) => {
      if (live) setSrc(s);
    });
    return () => {
      live = false;
    };
  }, [url]);
  if (src) return <img className="lib__thumb" src={src} alt="" />;
  return (
    <span className="lib__thumb lib__thumb--ph" aria-hidden>
      {icon ?? <MusicNote />}
    </span>
  );
}

/** Provider tabs tried, in order, to replay a liked song. */
const TAB_ORDER = ["spotify", "youtube", "soundcloud", "apple", "tidal", "amazon"];

export default function Library() {
  const t = useT();
  const [queue, setQueue] = useState<QueueState>({ items: [], currentIndex: null });
  const [tab, setTab] = useState<"queue" | "liked" | "playlists">("queue");
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [error, setError] = useState("");

  const [downloading, setDownloading] = useState<string | null>(null);
  const [importNote, setImportNote] = useState("");
  const [playlists, setPlaylists] = useState<PlaylistFile[]>([]);
  const [favs, setFavs] = useState<FavEntry[]>(loadFavs);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [editingPl, setEditingPl] = useState<string | null>(null);
  const [plTracks, setPlTracks] = useState<PlaylistTrack[]>([]);

  const refresh = () => bridge.getQueue().then(setQueue).catch(() => {});
  const refreshPlaylists = () =>
    bridge.listPlaylists().then(setPlaylists).catch(() => {});

  useEffect(() => {
    refresh();
    refreshPlaylists();
    const off = subscribe<NowPlaying>("now-playing", () => refresh());
    const offNp = subscribe<NowPlaying>("now-playing", setNp);
    const offFavs = subscribeFavs(() => setFavs(loadFavs()));
    return () => {
      off();
      offNp();
      offFavs();
    };
  }, []);

  const liked = listable(favs);
  const favSet = favKeys(favs);
  const likeQueued = (item: QueueItem) =>
    setFavs((prev) =>
      toggleFav(prev, {
        key: `local:${item.track.id}`,
        trackId: item.track.id,
        playerSource: "local",
        title: item.track.title,
        artist: item.track.artist,
        artworkUrl: item.track.artworkUrl ?? "",
        durationMs: item.track.durationMs,
      }),
    );
  // Local likes replay as one queue so next/prev flows through the list;
  // everything else plays in the user's connected provider tab.
  const playLiked = (entry: FavEntry) => {
    setError("");
    const replay = replayFor(entry);
    if (!replay) return;
    if (replay.kind === "external") {
      setDownloading(entry.key);
      bridge
        .getExtStatus()
        .then((st) => {
          const prov = TAB_ORDER.find((p) => st?.providers?.includes(p));
          return prov ? bridge.extPlay(prov, replay.query) : false;
        })
        .then((ok) => (ok ? refresh() : Promise.reject()))
        .catch(() => setError(t("lib.openTab")))
        .finally(() => setDownloading(null));
      return;
    }
    const locals = liked
      .filter((e) => replayFor(e)?.kind === "local")
      .map(toQueueItem);
    const index = locals.findIndex((i) => i.path === entry.trackId);
    if (index < 0) return;
    bridge
      .playItems(locals, index)
      .then(() => refresh())
      .catch((e) => setError(String(e)));
  };

  const rescan = () => {
    setError("");
    bridge
      .scanLibrary()
      .then((items) => setQueue({ items, currentIndex: null }))
      .catch((e) => setError(String(e)));
  };

  const importPlaylist = () => {
    setError("");
    setImportNote("");
    void bridge
      .pickPlaylist()
      .then((path) => (path ? bridge.importPlaylist(path) : null))
      .then((res) => {
        if (!res) return;
        refresh();
        const parts = [`${res.imported} tracks added`];
        if (res.remote > 0) parts.push(`${res.remote} online entries skipped`);
        if (res.missing > 0) parts.push(`${res.missing} files not found`);
        setImportNote(parts.join(" · "));
      })
      .catch((e) => setError(String(e)));
  };

  const savePlaylist = () => {
    setError("");
    setImportNote("");
    setSaving(true);
    void bridge
      .exportPlaylist(saveName.trim() || "playlist")
      .then((res) => {
        setSaveOpen(false);
        setSaveName("");
        const parts = [
          `Saved ${res.exported} tracks to ${res.path.split("/").pop()}`,
        ];
        if (res.skippedRemote > 0)
          parts.push(`${res.skippedRemote} online tracks skipped`);
        setImportNote(parts.join(" · "));
        refreshPlaylists();
      })
      .catch((e) => setError(String(e)))
      .finally(() => setSaving(false));
  };

  const importPlaylistFile = (path: string) => {
    setError("");
    setImportNote("");
    void bridge
      .importPlaylist(path)
      .then((res) => {
        refresh();
        const parts = [`${res.imported} tracks added`];
        if (res.remote > 0) parts.push(`${res.remote} online entries skipped`);
        if (res.missing > 0) parts.push(`${res.missing} files not found`);
        setImportNote(parts.join(" · "));
      })
      .catch((e) => setError(String(e)));
  };

  const commitRename = (p: PlaylistFile, name: string) => {
    setRenaming(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === p.name) return;
    bridge
      .renamePlaylist(p.path, trimmed)
      .then(refreshPlaylists)
      .catch((e) => setError(String(e)));
  };

  const deletePlaylist = (p: PlaylistFile) => {
    if (!window.confirm(`Delete "${p.name}"? The file is removed from your music folder.`)) {
      return;
    }
    if (editingPl === p.path) setEditingPl(null);
    bridge
      .deletePlaylist(p.path)
      .then(refreshPlaylists)
      .catch((e) => setError(String(e)));
  };

  const openPlaylist = (p: PlaylistFile) => {
    setError("");
    if (editingPl === p.path) {
      setEditingPl(null);
      return;
    }
    setEditingPl(p.path);
    setPlTracks([]);
    bridge
      .playlistTracks(p.path)
      .then(setPlTracks)
      .catch((e) => setError(String(e)));
  };

  const removePlTrack = (p: PlaylistFile, index: number) => {
    setError("");
    // Drop the row optimistically: a second removal before the refresh
    // must index into the list after this deletion, matching the file.
    setPlTracks((ts) => ts.filter((_, i) => i !== index));
    bridge
      .playlistRemoveTrack(p.path, index)
      .then(() => bridge.playlistTracks(p.path))
      .then(setPlTracks)
      .catch((e) => {
        setError(String(e));
        // Restore truth if the write failed.
        bridge
          .playlistTracks(p.path)
          .then(setPlTracks)
          .catch(() => {});
      });
  };

  const addToPlaylist = (p: PlaylistFile, paths: string[]) => {
    setError("");
    setImportNote("");
    bridge
      .playlistAddTracks(p.path, paths)
      .then((n) => {
        setImportNote(`${n} track${n === 1 ? "" : "s"} added to “${p.name}”`);
        return bridge.playlistTracks(p.path);
      })
      .then(setPlTracks)
      .catch((e) => setError(String(e)));
  };

  const playing = np?.status === "playing";
  const playingPath =
    queue.currentIndex != null ? queue.items[queue.currentIndex]?.path : null;
  const playingLocal =
    playingPath && !playingPath.startsWith("remote:") ? playingPath : null;
  const localQueuePaths = queue.items
    .map((i) => i.path)
    .filter((p) => !p.startsWith("remote:"));

  return (
    <div className="glass">
      <ArtBackdrop />
      <div className="settings settings--lib">
        <div className="pagehead" style={{ padding: "0 0 4px" }}>
          <div className="pagehead__top">
            <span />
            <span className="pagehead__links">
              <Link to="/albums" className="pagehead__link">
                {t("lib.albums")}
              </Link>
              <Link to="/" className="pagehead__link">
                {t("nav.back")}
              </Link>
            </span>
          </div>
          <h1 className="pagehead__name">{t("lib.title")}</h1>
          <span className="pagehead__meta">
            {queue.items.length} {queue.items.length === 1 ? t("lib.track") : t("lib.tracks")}
            {playlists.length > 0 && ` · ${playlists.length} ${playlists.length === 1 ? t("lib.playlistLower") : t("lib.playlistsLower")}`}
            {liked.length > 0 && ` · ${liked.length} ${t("lib.liked").toLowerCase()}`}
          </span>
        </div>

        <div className="libtabs" role="tablist" aria-label={t("lib.title")}>
          {(
            [
              ["queue", t("lib.queue"), queue.items.length],
              ["liked", t("lib.liked"), liked.length],
              ["playlists", t("lib.playlists"), playlists.length],
            ] as const
          ).map(([id, label, n]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "on" : ""}
              onClick={() => setTab(id)}
            >
              {label}
              {n > 0 && <em>{n}</em>}
            </button>
          ))}
        </div>

        {importNote && <span className="note">{importNote}</span>}
        {error && <span className="license-bad">{error}</span>}

        {tab === "queue" && (
          <>
        <div className="lib__toolbar" data-libsec="queue">
          <span className="lib__kicker">{t("fs.upNext")}</span>
          <div className="seg seg--ghost">
            <button onClick={rescan}>{t("lib.rescan")}</button>
            <button onClick={importPlaylist}>{t("lib.import")}</button>
            <button
              onClick={() => setSaveOpen((v) => !v)}
              disabled={queue.items.length === 0}
            >
              {t("lib.save")}
            </button>
            <button onClick={() => void bridge.clearQueue().then(refresh)}>{t("lib.clear")}</button>
          </div>
        </div>
        {saveOpen && (
          <div className="inrow">
            <Playlist />
            <input
              type="text"
              placeholder={t("lib.playlistName")}
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && savePlaylist()}
            />
            <button onClick={savePlaylist} disabled={saving}>
              {saving ? "…" : t("lib.save")}
            </button>
          </div>
        )}
        {queue.items.length === 0 && !error && (
          <span className="note">{t("lib.setFolder")}</span>
        )}
        <div className="lib">
          {queue.items.map((item, i) => {
            const current = queue.currentIndex === i;
            return (
              <button
                key={item.path}
                className={`lib__row lib__row--num ${current ? "lib__row--current" : ""}`}
                onClick={() => void bridge.playQueueIndex(i).then(refresh)}
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
                <LibThumb url={item.track.artworkUrl} />
                <span className="lib__title">{item.track.title}</span>
                <span className="lib__sub">
                  <Link
                    to={`/artist/${encodeURIComponent(item.track.artist)}`}
                    className="lib__artist"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {item.track.artist}
                  </Link>
                </span>
                <span className="lib__dur">
                  <span
                    role="button"
                    tabIndex={0}
                    className={`lib__act lib__heart ${favSet.has(`local:${item.track.id}`) ? "lib__heart--on" : ""}`}
                    aria-label={favSet.has(`local:${item.track.id}`) ? t("fs.unlike") : t("fs.like")}
                    title={favSet.has(`local:${item.track.id}`) ? t("fs.unlike") : t("fs.like")}
                    onClick={(e) => {
                      e.stopPropagation();
                      likeQueued(item);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      e.stopPropagation();
                      likeQueued(item);
                    }}
                  >
                    <Heart size={12} weight={favSet.has(`local:${item.track.id}`) ? "fill" : "regular"} />
                  </span>
                  {item.track.durationMs ? formatTime(item.track.durationMs) : ""}
                </span>
              </button>
            );
          })}
        </div>
          </>
        )}
        {tab === "liked" && liked.length === 0 && (
          <span className="note">{t("lib.likedEmpty")}</span>
        )}
        {tab === "liked" && liked.length > 0 && (
          <>
            <button
              className="lib__hero"
              data-libsec="liked"
              onClick={() => playLiked(liked[0])}
            >
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
            <div className="lib">
              {liked.map((e) => {
                const replay = replayFor(e);
                const remote = remoteParts(e.trackId);
                return (
                  <button
                    key={e.key}
                    className="lib__row"
                    onClick={() => playLiked(e)}
                    disabled={downloading !== null}
                  >
                    <LibThumb icon={<Heart weight="fill" />} />
                    <span className="lib__title">
                      {downloading === e.key ? "⤓ " : ""}
                      {e.title}
                    </span>
                    <span className="lib__sub">
                      {e.artist}
                      {remote
                        ? ` · ${remote.source}`
                        : replay?.kind === "external"
                          ? " · via search"
                          : ""}
                    </span>
                    <span className="lib__dur">
                      {e.durationMs ? formatTime(e.durationMs) : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
        {tab === "playlists" && playlists.length === 0 && (
          <span className="note">{t("lib.playlistsEmpty")}</span>
        )}
        {tab === "playlists" && playlists.length > 0 && (
          <>
            <div className="lib__toolbar" data-libsec="playlists">
              <span className="lib__kicker">
                {t("lib.playlists")}
                <em className="lib__count">{playlists.length}</em>
              </span>
            </div>
            <div className="lib">
              {playlists.map((p) => (
                <div key={p.path}>
                  <div
                    className="lib__row"
                    role="button"
                    tabIndex={0}
                    onClick={() => importPlaylistFile(p.path)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && e.target === e.currentTarget) {
                        importPlaylistFile(p.path);
                      }
                    }}
                  >
                    <LibThumb icon={<Playlist />} />
                    {renaming === p.path ? (
                      <input
                        className="lib__rename"
                        defaultValue={p.name}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") commitRename(p, e.currentTarget.value);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        onBlur={() => setRenaming(null)}
                      />
                    ) : (
                      <span className="lib__title">{p.name}</span>
                    )}
                    <span className="lib__sub">playlist</span>
                    <span className="lib__dur" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="lib__act"
                        title={t("lib.editTracks")}
                        onClick={() => openPlaylist(p)}
                      >
                        <ListBullets size={11} />
                      </button>
                      <button
                        className="lib__act"
                        title={t("lib.rename")}
                        onClick={() => setRenaming(p.path)}
                      >
                        <PencilSimple size={11} />
                      </button>
                      <button
                        className="lib__act"
                        title={t("lib.delete")}
                        onClick={() => deletePlaylist(p)}
                      >
                        <Trash size={11} />
                      </button>
                      <span aria-hidden="true">⤓</span>
                    </span>
                  </div>
                  {editingPl === p.path && (
                    <div className="lib__tracks">
                      {plTracks.map((pt, i) => (
                        <div className="lib__trow" key={`${pt.path}-${i}`}>
                          <span className="lib__tidx">{i + 1}</span>
                          <span className="lib__title">
                            {pt.title || pt.path.split("/").pop()}
                          </span>
                          <span className="lib__tdur">
                            {pt.remote
                              ? "stream"
                              : pt.durationMs
                                ? formatTime(pt.durationMs)
                                : ""}
                          </span>
                          <span className="lib__tact">
                            <button
                              className="lib__act"
                              title={t("lib.removeFromPlaylist")}
                              onClick={() => removePlTrack(p, i)}
                            >
                              <X size={11} />
                            </button>
                          </span>
                        </div>
                      ))}
                      {plTracks.length === 0 && (
                        <div className="lib__sub">{t("lib.emptyPlaylist")}</div>
                      )}
                      <div className="lib__tactions">
                        {playingLocal && (
                          <button
                            className="lib__add"
                            onClick={() => addToPlaylist(p, [playingLocal])}
                          >
                            <Plus size={10} /> playing
                          </button>
                        )}
                        {localQueuePaths.length > 0 && (
                          <button
                            className="lib__add"
                            onClick={() => addToPlaylist(p, localQueuePaths)}
                          >
                            <Plus size={10} /> queue
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
