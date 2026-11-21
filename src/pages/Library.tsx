import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  bridge,
  type NowPlaying,
  type PlaylistFile,
  type QueueState,
  type RemoteTrack,
} from "../bridge";
import { subscribe } from "../bridge";
import {
  listable,
  loadFavs,
  remoteParts,
  replayFor,
  subscribeFavs,
  toQueueItem,
  type FavEntry,
} from "../favs";
import { formatTime } from "../lib";
import { PencilSimple, Trash } from "@phosphor-icons/react";

const SOURCES = [
  { id: "youtube", label: "YouTube" },
  { id: "soundcloud", label: "SoundCloud" },
];

export default function Library() {
  const [queue, setQueue] = useState<QueueState>({ items: [], currentIndex: null });
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [error, setError] = useState("");

  const [ytReady, setYtReady] = useState(false);
  const [source, setSource] = useState("youtube");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RemoteTrack[]>([]);
  const [searching, setSearching] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [importNote, setImportNote] = useState("");
  const [plUrl, setPlUrl] = useState("");
  const [importingUrl, setImportingUrl] = useState(false);
  const [playlists, setPlaylists] = useState<PlaylistFile[]>([]);
  const [favs, setFavs] = useState<FavEntry[]>(loadFavs);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);

  const refresh = () => bridge.getQueue().then(setQueue).catch(() => {});
  const refreshPlaylists = () =>
    bridge.listPlaylists().then(setPlaylists).catch(() => {});

  useEffect(() => {
    refresh();
    refreshPlaylists();
    void bridge.providerStatus().then(setYtReady);
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
  // Local likes replay as one queue so next/prev flows through the list;
  // provider likes replay the stream directly (as tapping a search
  // result); likes of external players replay via a provider search.
  const playLiked = (entry: FavEntry) => {
    setError("");
    const replay = replayFor(entry);
    if (!replay) return;
    if (replay.kind === "provider") {
      setDownloading(entry.key);
      bridge
        .providerPlay(replay.track)
        .then(() => refresh())
        .catch((e) => setError(String(e)))
        .finally(() => setDownloading(null));
      return;
    }
    if (replay.kind === "external") {
      setDownloading(entry.key);
      bridge
        .providerSearch(source, replay.query)
        .then((rs) => {
          const top = rs[0];
          return top
            ? bridge.providerPlay(top)
            : Promise.reject("No matches found");
        })
        .then(() => refresh())
        .catch((e) => setError(String(e)))
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

  const search = () => {
    if (!query.trim()) return;
    setSearching(true);
    setError("");
    bridge
      .providerSearch(source, query.trim())
      .then(setResults)
      .catch((e) => setError(String(e)))
      .finally(() => setSearching(false));
  };

  const playRemote = (t: RemoteTrack) => {
    setDownloading(t.id);
    setError("");
    bridge
      .providerPlay(t)
      .then(() => refresh())
      .catch((e) => setError(String(e)))
      .finally(() => setDownloading(null));
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

  const importUrl = () => {
    const url = plUrl.trim();
    if (!url) return;
    setError("");
    setImportNote("");
    setImportingUrl(true);
    void bridge
      .importPlaylistUrl(url)
      .then((res) => {
        setPlUrl("");
        setImportNote(`"${res.title}" · ${res.imported} tracks queued`);
        refresh();
      })
      .catch((e) => setError(String(e)))
      .finally(() => setImportingUrl(false));
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
    bridge
      .deletePlaylist(p.path)
      .then(refreshPlaylists)
      .catch((e) => setError(String(e)));
  };

  const playing = np?.status === "playing";

  return (
    <div className="glass">
      <div className="settings">
        <div className="row">
          <h1>Library</h1>
          <span style={{ display: "flex", gap: 12 }}>
            <Link to="/albums" className="wordmark" style={{ textDecoration: "none" }}>
              Albums
            </Link>
            <Link to="/" className="wordmark" style={{ textDecoration: "none" }}>
              Back
            </Link>
          </span>
        </div>

        <div className="row">
          <span>Stream</span>
          <div className="seg">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                className={source === s.id ? "on" : ""}
                onClick={() => setSource(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <input
            type="text"
            placeholder="Search tracks…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
          />
          <button onClick={search} disabled={searching}>
            {searching ? "…" : "Go"}
          </button>
        </div>
        {!ytReady && (
          <span className="field">
            Streaming needs <code style={{whiteSpace:"nowrap"}}>yt-dlp</code> installed (brew or pip).
          </span>
        )}
        <div className="lib">
          {results.map((t) => (
            <button
              key={`${t.source}:${t.id}`}
              className="lib__row"
              onClick={() => playRemote(t)}
              disabled={downloading !== null}
            >
              <span className="lib__title">
                {downloading === t.id ? "⤓ " : ""}
                {t.title}
              </span>
              <span className="lib__sub">{t.artist}</span>
              <span className="lib__dur">{t.durationMs ? formatTime(t.durationMs) : ""}</span>
            </button>
          ))}
        </div>

        <div className="row">
          <span>{queue.items.length} tracks</span>
          <div className="seg">
            <button onClick={rescan}>Rescan</button>
            <button onClick={importPlaylist}>Import</button>
            <button
              onClick={() => setSaveOpen((v) => !v)}
              disabled={queue.items.length === 0}
            >
              Save
            </button>
            <button onClick={() => void bridge.clearQueue().then(refresh)}>Clear</button>
          </div>
        </div>
        {saveOpen && (
          <div className="row">
            <input
              type="text"
              placeholder="Playlist name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && savePlaylist()}
            />
            <button onClick={savePlaylist} disabled={saving}>
              {saving ? "…" : "Save"}
            </button>
          </div>
        )}
        {ytReady && (
          <div className="row">
            <input
              type="text"
              placeholder="Playlist URL (YouTube, SoundCloud…)"
              value={plUrl}
              onChange={(e) => setPlUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && importUrl()}
            />
            <button onClick={importUrl} disabled={importingUrl || !plUrl.trim()}>
              {importingUrl ? "…" : "Add"}
            </button>
          </div>
        )}
        {importNote && <span className="field">{importNote}</span>}
        {error && <span className="license-bad">{error}</span>}
        {queue.items.length === 0 && !error && (
          <span className="field">Set a music folder in settings, then press Rescan.</span>
        )}
        <div className="lib">
          {queue.items.map((item, i) => {
            const current = queue.currentIndex === i;
            return (
              <button
                key={item.path}
                className={`lib__row ${current ? "lib__row--current" : ""}`}
                onClick={() => void bridge.playQueueIndex(i).then(refresh)}
              >
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
                  {current && playing ? "▸ " : ""}
                  {item.track.durationMs ? formatTime(item.track.durationMs) : ""}
                </span>
              </button>
            );
          })}
        </div>
        {liked.length > 0 && (
          <>
            <div className="row">
              <span>Liked</span>
            </div>
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
                    <span className="lib__title">
                      {downloading === e.key ? "⤓ " : "♥ "}
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
        {playlists.length > 0 && (
          <>
            <div className="row">
              <span>Playlists</span>
            </div>
            <div className="lib">
              {playlists.map((p) => (
                <div
                  key={p.path}
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
                      title="Rename"
                      onClick={() => setRenaming(p.path)}
                    >
                      <PencilSimple size={11} />
                    </button>
                    <button
                      className="lib__act"
                      title="Delete"
                      onClick={() => deletePlaylist(p)}
                    >
                      <Trash size={11} />
                    </button>
                    <span aria-hidden="true">⤓</span>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
