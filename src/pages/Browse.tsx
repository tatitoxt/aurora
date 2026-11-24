import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  artSrc,
  bridge,
  subscribe,
  type NowPlaying,
  type PlaylistFile,
  type PlaylistTrack,
  type CatalogSong,
  type PlayRecord,
  type QueueItem,
  type QueueState,
  type Stats,
} from "../bridge";
import {
  favEntryFor,
  favKeyFor,
  listable,
  loadFavs,
  replayFor,
  subscribeFavs,
  toggleFav,
  toQueueItem,
  type FavEntry,
} from "../favs";
import { extProviderId, formatTime } from "../lib";
import { useT } from "../i18n";
import SearchPanel from "../SearchPanel";
import BrowserSources from "../BrowserSources";
import { VideoBackdrop } from "../VideoBackdrop";
import {
  ArrowsOut,
  Broadcast,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  CaretUpDown,
  Clock,
  Heart,
  House,
  ListBullets,
  MagnifyingGlass,
  MusicNote,
  Pause,
  PencilSimple,
  Play,
  Plus,
  Playlist,
  Repeat,
  RepeatOnce,
  Shuffle,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SpeakerSlash,
  Gear,
  SquaresFour,
  Trash,
  User,
  X,
} from "@phosphor-icons/react";

/** Providers tried, in order, when playing a catalog/stats entry. */
const AUTO_ORDER = ["spotify", "youtube", "soundcloud", "apple", "tidal", "amazon"];

/* Module scope: the ref resets when Browse unmounts (Live view and
   back), which would silently revert unmute to the default volume. */
let preMuteVol = 0.8;

type View =
  | "home"
  | "search"
  | "liked"
  | "queue"
  | "services"
  | "settings"
  | "recent"
  | `pl:${string}`
  | `ar:${string}`;

/** Artwork tile that resolves file:// refs to loadable URLs. */
function Art({ url, icon }: { url?: string; icon?: React.ReactNode }) {
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
  if (src) return <img className="brw__art" src={src} alt="" />;
  return (
    <span className="brw__art brw__art--ph" aria-hidden>
      {icon ?? <MusicNote />}
    </span>
  );
}

const hueOf = (s: string) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};

/** Generated cover for art-less playlists: a two-tone gradient tile
    with the initial — reads like a blurred cover, not a dead square. */
function GenCover({ name }: { name: string }) {
  const h = hueOf(name);
  return (
    <span
      className="brw__art brw__art--gen"
      style={{
        background: `linear-gradient(135deg, hsl(${h} 42% 34%), hsl(${(h + 70) % 360} 38% 16%))`,
      }}
      aria-hidden
    >
      {name.trim().charAt(0).toUpperCase() || "♪"}
    </span>
  );
}

/* The poll emits fresh objects every call — skip the setState (and the
   whole-tree re-render it costs) when nothing actually changed. */
const sameJson = <T,>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);

const RECENT_SEARCHES_KEY = "brw.recentSearches";

export default function Browse() {
  const t = useT();
  const nav = useNavigate();
  const [view, setView] = useState<View>("home");
  const [queue, setQueue] = useState<QueueState>({ items: [], currentIndex: null });
  const [playlists, setPlaylists] = useState<PlaylistFile[]>([]);
  const [plTracks, setPlTracks] = useState<PlaylistTrack[]>([]);
  const [plLoading, setPlLoading] = useState(false);
  const [favs, setFavs] = useState<FavEntry[]>(loadFavs);
  const [stats, setStats] = useState<Stats | null>(null);
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [ext, setExt] = useState<{
    tabs: number;
    provider: string | null;
    providers?: string[];
  } | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [q, setQ] = useState("");
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<"off" | "all" | "one">("off");
  const [vol, setVol] = useState(0.8);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  /* "+" add-to-playlist popover: anchored to the button's viewport
     rect (fixed) so the scroll container can't clip it. */
  const [addTo, setAddTo] = useState<{ key: string; x: number; y: number } | null>(null);
  /* In-app dialog for Save/Rename/Delete — window.prompt/confirm are
     suppressed in automation and look alien anyway. */
  const [dlg, setDlg] = useState<
    | { kind: "save" }
    | { kind: "create" }
    | { kind: "rename"; path: string; name: string }
    | { kind: "delete"; path: string; name: string }
    | null
  >(null);
  const [dlgName, setDlgName] = useState("");
  const [ctx, setCtx] = useState<{
    x: number;
    y: number;
    kind: "pl" | "queue" | "railpl";
    index: number;
    /* railpl menus carry the playlist being right-clicked. */
    path?: string;
    name?: string;
  } | null>(null);
  /* Serialized: a second remove before the first lands would hand
     playlist_remove_track an index that no longer exists in the file. */
  const plRemoving = useRef(false);
  /* Rail playlist item highlighted as a drop target while a track
     row is dragged over it. */
  const [plDrop, setPlDrop] = useState<string | null>(null);
  /* Spotify's "/" shortcut jumps focus to the rail search box. */
  const railSearchRef = useRef<HTMLInputElement>(null);
  const [recent, setRecent] = useState<PlayRecord[]>([]);
  const [arSongs, setArSongs] = useState<CatalogSong[]>([]);
  const [arLocal, setArLocal] = useState<QueueItem[]>([]);
  const [arLoading, setArLoading] = useState(false);
  /* Spotify-style back/forward inside the Browse tab. */
  const [past, setPast] = useState<View[]>([]);
  const [future, setFuture] = useState<View[]>([]);
  const go = (v: View) => {
    if (v === view) return;
    setPast((p) => [...p, view].slice(-50));
    setFuture([]);
    setView(v);
  };
  const goBack = () => {
    if (past.length === 0) return;
    setFuture((f) => [view, ...f]);
    setView(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
  };
  const goFwd = () => {
    if (future.length === 0) return;
    setPast((p) => [...p, view]);
    setView(future[0]);
    setFuture((f) => f.slice(1));
  };

  /* The 4 s poll closes over the first render's view — read the live
     one through a ref so Show all doesn't get clipped back to 12. */
  const viewRef = useRef<View>(view);
  viewRef.current = view;

  const refresh = () => {
    void bridge
      .getQueue()
      .then((q2) => setQueue((p) => (sameJson(p, q2) ? p : q2)))
      .catch(() => {});
    /* Tabs can connect while Browse is mounted — keep the provider set
       live or playback still reports no tab. */
    void bridge
      .getExtStatus()
      .then((e) => setExt((p) => (sameJson(p, e) ? p : e)))
      .catch(() => {});
    /* A finished listen should surface on Home without remounting. */
    void bridge
      .recentPlays(viewRef.current === "recent" ? 50 : 12)
      .then((r) => setRecent((p) => (sameJson(p, r) ? p : r)))
      .catch(() => {});
    /* Volume can change outside this page (arrow-key shortcuts on
       Stage) — re-read or the mute button lies. */
    void bridge
      .getVolume()
      .then((v) => {
        setVol((p) => (p === v ? p : v));
        if (v > 0) preMuteVol = v;
      })
      .catch(() => {});
  };
  useEffect(() => {
    refresh();
    void bridge.listPlaylists().then(setPlaylists).catch(() => {});
    void bridge.getStats().then(setStats).catch(() => {});
    const offQ = subscribe<QueueState>("queue", setQueue);
    /* now-playing emits every engine tick (position updates) — only
       re-poll when the meaningful signature changes, or refresh()
       would run its 4 IPCs hundreds of times a minute. */
    const npSig = { current: "" };
    const offNp = subscribe<NowPlaying>("now-playing", (n) => {
      setNp(n);
      const sig = `${n.track?.id ?? ""}:${n.status}:${n.source ?? ""}`;
      if (sig !== npSig.current) {
        npSig.current = sig;
        refresh();
      }
    });
    const offFavs = subscribeFavs(() => setFavs(loadFavs()));
    void bridge.getShuffle().then(setShuffle).catch(() => {});
    void bridge.getRepeat().then(setRepeat).catch(() => {});
    void bridge.getVolume().then((v) => {
      setVol(v);
      if (v > 0) preMuteVol = v;
    }).catch(() => {});
    const poll = setInterval(refresh, 4000);
    return () => {
      offQ();
      offNp();
      offFavs();
      clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const inField = (e.target as HTMLElement | null)?.closest(
        "input, textarea, [contenteditable]",
      );
      /* Spotify binds both "/" and Ctrl/Cmd+K to search. */
      const searchKey =
        e.key === "/" || (e.key === "k" && (e.metaKey || e.ctrlKey));
      if (!searchKey || (e.key === "/" && inField)) return;
      e.preventDefault();
      go("search");
      railSearchRef.current?.focus();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  /* Browser preview only: the demo soundtrack lives in the YouTube embed,
     which unmounts with Stage — keep an audible (hidden) embed here so
     Browse isn't silent. On desktop the real audio never enters React. */
  const trackId = np?.track?.id ?? null;
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  useEffect(() => {
    setVideoUrl(null);
    if (!trackId || !np?.track || bridge.isTauri()) return;
    let stale = false;
    bridge.resolveVideo(np.track.artist, np.track.title).then((u) => {
      if (!stale) setVideoUrl(u);
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId]);

  const connected = useMemo(
    () =>
      new Set(
        (ext?.providers?.length
          ? ext.providers
          : ext?.provider
            ? [ext.provider]
            : []
        ).map(extProviderId),
      ),
    [ext],
  );

  const liked = listable(favs);
  const favSet = new Set(favs.map((f) => f.key));
  const favKey = favKeyFor(np);
  const isFav = favKey !== "" && favSet.has(favKey);
  const track = np?.track ?? null;
  const playing = np?.status === "playing";
  /* Row highlight (queue rows use currentIndex already). Local rows
     match the file path — Track.id is the path for local playback —
     so two entries sharing title+artist don't both light up. Remote
     rows have no path to compare, they key off the displayed title. */
  const isNow = (pt: PlaylistTrack) => {
    if (!track) return false;
    if (!pt.remote) return pt.path === track.id;
    const shown = pt.title || pt.path.split("/").pop() || "";
    return (
      track.title.trim().toLowerCase() === shown.trim().toLowerCase() &&
      track.artist.trim().toLowerCase() === pt.artist.trim().toLowerCase()
    );
  };
  /* Volume controls only reach the local player — provider tabs keep
     their own audio, so mute/slider would lie during external playback.
     "demo" stays enabled: the preview mock routes it to the audible
     YouTube-embed backdrop. */
  const volLocal = !track || np?.source === "local" || np?.source === "demo";
  const progress = track?.durationMs
    ? Math.min(1, (np?.positionMs ?? 0) / track.durationMs)
    : 0;

  const flash = (msg: string) => {
    setNote(msg);
    setErr("");
    setTimeout(() => setNote(""), 2800);
  };
  const fail = (e: unknown) => setErr(String(e));

  /** Play through the first connected provider tab (extension bridge). */
  const playExternal = (query: string) => {
    setErr("");
    const prov = AUTO_ORDER.find((p) => connected.has(p));
    if (!prov) {
      setErr(t("fs.noTab", { src: "a provider" }));
      return;
    }
    void bridge
      .extPlay(prov, query)
      .then((ok) =>
        ok ? flash(t("fs.playingInTab", { src: prov })) : setErr(t("fs.noTab", { src: prov })),
      )
      .catch(fail);
  };

  const playLiked = (e: FavEntry) => {
    setErr("");
    const replay = replayFor(e);
    if (!replay) return;
    if (replay.kind === "external") {
      playExternal(replay.query);
      return;
    }
    const locals = liked.filter((x) => replayFor(x)?.kind === "local").map(toQueueItem);
    const index = locals.findIndex((i) => i.path === e.trackId);
    if (index < 0) return;
    void bridge.playItems(locals, index).catch(fail);
  };

  /* Liked header Shuffle: queue every playable fav and let the
     engine shuffle — remote favs still open per-row. */
  const shuffleLiked = () => {
    const locals = liked
      .filter((x) => replayFor(x)?.kind === "local")
      .map(toQueueItem);
    if (locals.length === 0) return;
    setErr("");
    void bridge
      .setShuffle(true)
      .then(() =>
        bridge.playItems(locals, Math.floor(Math.random() * locals.length)),
      )
      .then(() => setShuffle(true))
      .catch(fail);
  };

  const openPlaylist = (p: PlaylistFile) => go(`pl:${p.path}`);

  /* Track loading keys off the view so Back/Forward re-fetches the
     rows instead of showing the previously opened playlist's. */
  useEffect(() => {
    if (!view.startsWith("pl:")) return;
    setPlLoading(true);
    setPlTracks([]);
    void bridge
      .playlistTracks(view.slice(3))
      .then(setPlTracks)
      .catch(fail)
      .finally(() => setPlLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  /* In-Browse artist page: staying inside the view stack keeps
     Back/Forward and the playbar — the router page had neither. */
  useEffect(() => {
    if (!view.startsWith("ar:")) return;
    const name = decodeURIComponent(view.slice(3));
    setArLoading(true);
    setArSongs([]);
    setArLocal([]);
    /* Local library rows first: they play without a provider tab. */
    void bridge
      .libraryTracks()
      .then((ts) =>
        setArLocal(
          ts.filter(
            (t) =>
              t.track.artist.trim().toLowerCase() ===
              name.trim().toLowerCase(),
          ),
        ),
      )
      .catch(() => {});
    void bridge
      .catalogSearch(name)
      /* catalogSearch matches the term anywhere (title, album);
         an artist page must list that artist's own catalog — the
         same credit filter SearchPanel applies internally. */
      .then((r) =>
        setArSongs(
          r.filter((s) =>
            s.artist.toLowerCase().includes(name.trim().toLowerCase()),
          ),
        ),
      )
      .catch(fail)
      .finally(() => setArLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  /* "Show all" pulls a longer history than the Home preview row. */
  useEffect(() => {
    if (view !== "recent") return;
    void bridge.recentPlays(50).then(setRecent).catch(() => {});
  }, [view]);

  /* Right-click menu: closes on any press outside it. */
  useEffect(() => {
    if (!ctx && !addTo) return;
    const h = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (!el?.closest?.(".brw__ctx")) setCtx(null);
      if (!el?.closest?.(".brw__plmenu") && !el?.closest?.(".lib__rm"))
        setAddTo(null);
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [ctx, addTo]);

  /* A row index only means something inside the view it was opened
     on — keyboard navigation can swap views while the menu is up. */
  useEffect(() => {
    setCtx(null);
    setAddTo(null);
    setPlSort({ key: null, dir: 1 });
    setPlQuery("");
  }, [view]);

  /* Spotify stores the query when a result actually plays. */
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    try {
      const v = JSON.parse(
        localStorage.getItem(RECENT_SEARCHES_KEY) ?? "[]",
      );
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  });
  const pushSearch = (s: string) => {
    const v = s.trim();
    if (!v) return;
    setRecentSearches((p) => {
      const n = [v, ...p.filter((x) => x.toLowerCase() !== v.toLowerCase())].slice(
        0,
        8,
      );
      try {
        localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(n));
      } catch {}
      return n;
    });
  };
  const [sFilter, setSFilter] = useState<
    "all" | "songs" | "artists" | "playlists"
  >("all");

  /* Playlist view: display-only sort + in-playlist filter (Spotify's
     column header and find box). Sorting never rewrites the .m3u,
     and drag-reorder stays disabled while a sort/filter is on — the
     visible order wouldn't map back to file indices. */
  const [plSort, setPlSort] = useState<{
    key: "title" | "artist" | "duration" | null;
    dir: 1 | -1;
  }>({ key: null, dir: 1 });
  const [plQuery, setPlQuery] = useState("");
  const toggleSort = (key: "title" | "artist" | "duration") =>
    setPlSort((p) =>
      p.key !== key
        ? { key, dir: 1 }
        : p.dir === 1
          ? { key, dir: -1 }
          : { key: null, dir: 1 },
    );
  const plShown = useMemo(() => {
    let rows = plTracks.map((t, i) => ({ t, i }));
    const term = plQuery.trim().toLowerCase();
    if (term)
      rows = rows.filter(
        ({ t: pt }) =>
          pt.title.toLowerCase().includes(term) ||
          pt.artist.toLowerCase().includes(term) ||
          pt.path.toLowerCase().includes(term),
      );
    if (plSort.key) {
      const dir = plSort.dir;
      const key = plSort.key;
      rows = [...rows].sort((a, b) => {
        const cmp =
          key === "duration"
            ? (a.t.durationMs ?? Number.MAX_SAFE_INTEGER) -
              (b.t.durationMs ?? Number.MAX_SAFE_INTEGER)
            : key === "artist"
              ? a.t.artist.localeCompare(b.t.artist)
              : a.t.title.localeCompare(b.t.title);
        return cmp !== 0 ? cmp * dir : a.i - b.i;
      });
    }
    return rows;
  }, [plTracks, plQuery, plSort]);

  /* Put the saved queue back when a playlist swap fails to start. */
  const restoreQueue = (saved: QueueState) => {
    if (saved.items.length > 0)
      void bridge.playItems(saved.items, saved.currentIndex ?? 0).catch(() => {});
  };

  /* Play All / Shuffle replace the queue with the playlist — importing
     onto the existing queue would let shuffle leak into older items.
     On failure the previous queue is restored. */
  const playPlaylist = (p: PlaylistFile, shuffled = false) => {
    setErr("");
    const saved = queue;
    void bridge
      .clearQueue()
      .then(() => bridge.importPlaylist(p.path))
      .then((res) => {
        if (res.imported === 0) {
          restoreQueue(saved);
          return;
        }
        return bridge.getQueue().then((q) => {
          setQueue(q);
          if (q.items.length === 0) {
            restoreQueue(saved);
            return;
          }
          const idx = shuffled ? Math.floor(Math.random() * q.items.length) : 0;
          return bridge.playQueueIndex(idx).catch((e) => {
            restoreQueue(saved);
            throw e;
          });
        });
      })
      .catch(fail);
  };

  const plName =
    view.startsWith("pl:")
      ? (playlists.find((p) => p.path === view.slice(3))?.name ?? "Playlist")
      : "";
  const arName = view.startsWith("ar:") ? decodeURIComponent(view.slice(3)) : "";
  /* Spotify groups an artist page by release — keep first-seen album
     order; empty album names fall into a "singles" bucket last. */
  const arGroups = useMemo(() => {
    const m = new Map<string, CatalogSong[]>();
    for (const s of arSongs) {
      const k = s.album?.trim() || "";
      const g = m.get(k);
      if (g) g.push(s);
      else m.set(k, [s]);
    }
    const singles = m.get("") ?? [];
    m.delete("");
    return [...m.entries(), ...(singles.length ? [["", singles] as [string, CatalogSong[]]] : [])];
  }, [arSongs]);
  /* Header art: first playlist row whose artwork we can resolve. */
  const artFor = (ts: PlaylistTrack[]) =>
    ts
      .map(
        (pt) =>
          queue.items.find(
            (i) => i.track.title === pt.title && i.track.artist === pt.artist,
          )?.track.artworkUrl ??
          liked.find((e) => e.title === pt.title && e.artist === pt.artist)
            ?.artworkUrl ??
          "",
      )
      .find(Boolean) ?? "";
  const plArt = artFor(plTracks);

  /* Card covers: resolve one artwork per playlist so the grids show
     real covers, not icon placeholders. */
  const [plArts, setPlArts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (playlists.length === 0) {
      setPlArts({});
      return;
    }
    let live = true;
    void Promise.all(
      playlists.map((p) =>
        bridge
          .playlistTracks(p.path)
          .then((ts) => [p.path, artFor(ts)] as const)
          .catch(() => [p.path, ""] as const),
      ),
    ).then((es) => live && setPlArts(Object.fromEntries(es)));
    return () => {
      live = false;
    };
    /* artFor reads queue/liked as they are when the playlist list
       changes — re-running per queue tick would refetch endlessly. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlists]);

  /** A history row maps onto the fav replay rules: local trackIds are
      file paths, everything else becomes a provider query. */
  const recReplay = (r: PlayRecord) =>
    replayFor({
      key: "",
      trackId: r.trackId,
      playerSource: r.source,
      title: r.title,
      artist: r.artist,
      artworkUrl: "",
      durationMs: r.durationMs,
    });
  const recArt = (r: PlayRecord) =>
    queue.items.find(
      (i) => i.track.title === r.title && i.track.artist === r.artist,
    )?.track.artworkUrl ??
    liked.find((e) => e.title === r.title && e.artist === r.artist)
      ?.artworkUrl ??
    "";
  const playRecent = (r: PlayRecord) => {
    setErr("");
    const replay = recReplay(r);
    if (!replay) return;
    if (replay.kind === "external") {
      playExternal(replay.query);
      return;
    }
    /* Local recents form the context, like Spotify replaying the row. */
    const locals = recent
      .map(recReplay)
      .flatMap((x) => (x?.kind === "local" ? [x.item as QueueItem] : []));
    const index = locals.findIndex((i) => i.path === r.trackId);
    if (index < 0) return;
    void bridge.playItems(locals, index).catch(fail);
  };

  /** Playlist detail rows play the clicked track: remote rows can't be
      queued (import skips them) so they go through the provider bridge;
      file rows are matched by path because import also skips missing
      files, shifting every later row's queue index. */
  const playPlTrack = (i: number) => {
    const p = playlists.find((x) => `pl:${x.path}` === view);
    const pt = plTracks[i];
    if (!p || !pt) return;
    setErr("");
    if (pt.remote) {
      /* Remote entries carry only a URL, so fall back to it: an empty
         query is ignored by the extension while ext_play still stops
         local playback. */
      playExternal(`${pt.title} ${pt.artist}`.trim() || pt.path);
      return;
    }
    const saved = queue;
    void bridge
      .clearQueue()
      .then(() => bridge.importPlaylist(p.path))
      .then((res) => {
        if (res.imported === 0) {
          restoreQueue(saved);
          return;
        }
        return bridge.getQueue().then((q2) => {
          setQueue(q2);
          const added = q2.items;
          /* Exact path wins: an earlier entry may share title+artist but
             point at a different recording. */
          let idx = added.findIndex((it) => it.path === pt.path);
          if (idx < 0)
            idx = added.findIndex(
              (it) =>
                it.track.title === pt.title && it.track.artist === pt.artist,
            );
          if (idx >= 0)
            return bridge.playQueueIndex(idx).catch((e) => {
              restoreQueue(saved);
              throw e;
            });
          restoreQueue(saved);
          setErr(t("brw.trackMissing"));
        });
      })
      .catch(fail);
  };

  /** Remove row i of the open playlist — serialized so a second press
      can't hand the backend an index that already shifted. */
  const removePlTrack = (i: number) => {
    if (plRemoving.current) return;
    const p = playlists.find((x) => `pl:${x.path}` === view);
    if (!p) return;
    plRemoving.current = true;
    void bridge
      .playlistRemoveTrack(p.path, i)
      .then(() => setPlTracks((ts) => ts.filter((_, j) => j !== i)))
      .catch(fail)
      .finally(() => {
        plRemoving.current = false;
      });
  };

  /** In-app dialog submit: Save queue-as-playlist / Rename / Delete. */
  const submitDlg = () => {
    if (!dlg) return;
    const name = dlgName.trim();
    if (dlg.kind === "save") {
      if (!name) return;
      void bridge
        .exportPlaylist(name)
        .then(() => {
          flash(t("lib.save"));
          return bridge.listPlaylists().then(setPlaylists);
        })
        .catch(fail);
    } else if (dlg.kind === "create") {
      if (!name) return;
      void bridge
        .createPlaylist(name)
        .then((f) => {
          setPlaylists((pls) => [...pls, f]);
          go(`pl:${f.path}`);
        })
        .catch(fail);
    } else if (dlg.kind === "rename") {
      if (!name || name === dlg.name) {
        setDlg(null);
        return;
      }
      void bridge
        .renamePlaylist(dlg.path, name)
        .then((f) => {
          setPlaylists((pls) => pls.map((x) => (x.path === dlg.path ? f : x)));
          go(`pl:${f.path}`);
        })
        .catch(fail);
    } else {
      void bridge
        .deletePlaylist(dlg.path)
        .then(() => {
          setPlaylists((pls) => pls.filter((x) => x.path !== dlg.path));
          go("home");
        })
        .catch(fail);
    }
    setDlg(null);
  };

  /* Spotify-style greeting follows the clock, not a fixed string. */
  const hour = new Date().getHours();
  const greet =
    hour < 12
      ? t("brw.greetMorning")
      : hour < 19
        ? t("brw.greetAfternoon")
        : t("brw.greetEvening");

  /** Jump-back tiles: the shortcuts Spotify puts under the greeting. */
  const jumpTiles = [
    liked.length > 0 && {
      key: "liked",
      name: t("lib.liked"),
      icon: <Heart weight="fill" />,
      onClick: () => go("liked"),
    },
    queue.items.length > 0 && {
      key: "queue",
      name: t("fs.upNext"),
      art: queue.items[queue.currentIndex ?? 0]?.track.artworkUrl,
      icon: <ListBullets />,
      onClick: () => go("queue"),
    },
    ...playlists.slice(0, 4).map((p) => ({
      key: `pl:${p.path}`,
      name: p.name,
      icon: <Playlist />,
      onClick: () => openPlaylist(p),
    })),
    ...(stats?.topArtists ?? []).slice(0, 2).map((a) => ({
      key: `ar:${a.name}`,
      name: a.name,
      icon: <User />,
      onClick: () => go(`ar:${encodeURIComponent(a.name)}`),
    })),
  ]
    .filter(Boolean)
    .slice(0, 8) as {
    key: string;
    name: string;
    icon: React.ReactNode;
    art?: string;
    onClick: () => void;
  }[];

  return (
    <div className="brw">
      {videoUrl && !bridge.isTauri() && (
        <VideoBackdrop
          url={videoUrl}
          posMs={np?.positionMs ?? 0}
          playing={playing}
          cls="brw__bgvid"
          readyCls="brw__bgvid--ready"
          audible
        />
      )}
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
                if (!tp) return;
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

      <main className="brw__main">
        <header className="brw__head">
          <span className="brw__navbtns">
            <button
              className="brw__icon"
              onClick={goBack}
              disabled={past.length === 0}
              aria-label={t("nav.back")}
              title={t("nav.back")}
            >
              <CaretLeft />
            </button>
            <button
              className="brw__icon"
              onClick={goFwd}
              disabled={future.length === 0}
              aria-label={t("brw.forward")}
              title={t("brw.forward")}
            >
              <CaretRight />
            </button>
          </span>
          <h1>
            {view === "home" && t("brw.home")}
            {view === "search" && t("brw.search")}
            {view === "liked" && t("lib.liked")}
            {view === "queue" && t("fs.upNext")}
            {view === "services" && t("sources.heading")}
            {view === "settings" && t("brw.settings")}
            {view === "recent" && t("brw.recentlyPlayed")}
            {view.startsWith("pl:") && plName}
            {view.startsWith("ar:") && arName}
          </h1>
          <span className="brw__headspace" />
          <button
            className="brw__icon"
            aria-label={t("brw.settings")}
            title={t("brw.settings")}
            onClick={() => go("settings")}
          >
            <Gear />
          </button>
        </header>
        {err && <span className="license-bad">{err}</span>}
        {note && <span className="note">● {note}</span>}

        {view === "search" && (
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
              onArtist={(name) => go(`ar:${encodeURIComponent(name)}`)}
              filter={sFilter === "playlists" ? "none" : sFilter}
              aside={
                (sFilter === "all" || sFilter === "playlists") &&
                playlists.length > 0 ? (
                  <>
                    <span className="srch__h">{t("lib.playlists")}</span>
                    <div className="srch__pllist">
                      {playlists.map((p) => (
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
          </div>
        )}

        {view === "services" && (
          <div className="brw__section">
            <BrowserSources />
          </div>
        )}

        {view === "settings" && (
          <div className="brw__section brw__settings">
            <button
              className="brw__setrow"
              onClick={() => nav("/settings")}
              title={t("brw.appSettings")}
            >
              <User />
              <span className="brw__setrow-t">
                <b>{t("brw.account")}</b>
                <small>{t("brw.appSettings")}</small>
              </span>
              <CaretRight />
            </button>
            <span className="brw__kick">{t("sources.heading")}</span>
            <BrowserSources />
          </div>
        )}

        {view.startsWith("ar:") && (
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
                    else if (arSongs[0])
                      playExternal(`${arSongs[0].title} ${arSongs[0].artist}`);
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
                        <span className="lib__idx">{i + 1}</span>
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
        )}

        {view === "recent" && (
          <section className="brw__section">
            {recent.length === 0 && (
              <span className="brw__empty">{t("brw.noTracks")}</span>
            )}
            <div className="brw__grid">
              {recent.map((r) => (
                <button
                  key={`${r.trackId}-${r.playedAtMs}`}
                  className="brw__card"
                  title={`${r.title} — ${r.artist}`}
                  onClick={() => playRecent(r)}
                >
                  <Art url={recArt(r)} />
                  <span className="brw__cardplay" aria-hidden>
                    <Play weight="fill" />
                  </span>
                  <span className="brw__cardt">{r.title}</span>
                  <span className="brw__cards">{r.artist}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {view === "home" && (
          <>
            <h2 className="brw__greet">
              {greet}
              <em className="brw__wordmark">{bridge.productName}</em>
            </h2>
            {jumpTiles.length > 0 && (
              <div className="brw__jump">
                {jumpTiles.map((j) => (
                  <button key={j.key} className="brw__tile" onClick={j.onClick}>
                    {j.art ? (
                      <Art url={j.art} icon={j.icon} />
                    ) : (
                      <span className="brw__art brw__art--ph" aria-hidden>
                        {j.icon}
                      </span>
                    )}
                    <span className="brw__tilename">{j.name}</span>
                  </button>
                ))}
              </div>
            )}

            {recent.length > 0 && (
              <section className="brw__section">
                <span className="brw__sechead">
                  <span className="brw__kick">{t("brw.recentlyPlayed")}</span>
                  <button className="brw__showall" onClick={() => go("recent")}>
                    {t("brw.showAll")}
                  </button>
                </span>
                <div className="brw__grid">
                  {recent.slice(0, 12).map((r) => (
                    <button
                      key={`${r.trackId}-${r.playedAtMs}`}
                      className="brw__card"
                      title={`${r.title} — ${r.artist}`}
                      onClick={() => playRecent(r)}
                    >
                      <Art url={recArt(r)} />
                      <span className="brw__cardplay" aria-hidden>
                        <Play weight="fill" />
                      </span>
                      <span className="brw__cardt">{r.title}</span>
                      <span className="brw__cards">{r.artist}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            <section className="brw__section">
              <span className="brw__sechead">
                <span className="brw__kick">{t("fs.upNext")}</span>
                {queue.items.length > 0 && (
                  <button className="brw__showall" onClick={() => go("queue")}>
                    {t("brw.showAll")}
                  </button>
                )}
              </span>
              <div className="brw__grid">
                {queue.items.slice(0, 12).map((item, i) => (
                  <button
                    key={item.path}
                    className="brw__card"
                    title={`${item.track.title} — ${item.track.artist}`}
                    onClick={() => void bridge.playQueueIndex(i)}
                  >
                    <Art url={item.track.artworkUrl} />
                    <span className="brw__cardplay" aria-hidden>
                      <Play weight="fill" />
                    </span>
                    <span className="brw__cardt">{item.track.title}</span>
                    <span className="brw__cards">{item.track.artist}</span>
                  </button>
                ))}
                {queue.items.length === 0 && (
                  <span className="brw__empty">{t("lib.queueEmpty")}</span>
                )}
              </div>
            </section>

            {liked.length > 0 && (
              <section className="brw__section">
                <span className="brw__sechead">
                  <span className="brw__kick">{t("lib.liked")}</span>
                  <button className="brw__showall" onClick={() => go("liked")}>
                    {t("brw.showAll")}
                  </button>
                </span>
                <div className="brw__grid">
                  {liked.slice(0, 12).map((e) => (
                    <button
                      key={e.key}
                      className="brw__card"
                      title={`${e.title} — ${e.artist}`}
                      onClick={() => playLiked(e)}
                    >
                      <Art url={e.artworkUrl} icon={<Heart weight="fill" />} />
                      <span className="brw__cardplay" aria-hidden>
                        <Play weight="fill" />
                      </span>
                      <span className="brw__cardt">{e.title}</span>
                      <span className="brw__cards">{e.artist}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {stats && stats.topTracks.length > 0 && (
              <section className="brw__section">
                <span className="brw__kick">{t("brw.topTracks")}</span>
                <div className="brw__rows">
                  {stats.topTracks.slice(0, 6).map((e, i) => (
                    <button
                      key={`${e.name}:${e.sub}`}
                      className="brw__row"
                      onClick={() => playExternal(`${e.name} ${e.sub}`)}
                    >
                      <span className="brw__idx">{i + 1}</span>
                      <span className="brw__meta">
                        <span className="brw__mt">{e.name}</span>
                        <span className="brw__ms">{e.sub}</span>
                      </span>
                      <span className="brw__plays">
                        {e.plays}{" "}
                        {e.plays === 1 ? t("brw.playsOne") : t("brw.plays")}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {stats && stats.topArtists.length > 0 && (
              <section className="brw__section">
                <span className="brw__kick">{t("brw.topArtists")}</span>
                <div className="brw__grid brw__grid--round">
                  {stats.topArtists.slice(0, 8).map((a) => (
                    <button
                      key={a.name}
                      className="brw__card brw__card--round"
                      title={a.name}
                      onClick={() => go(`ar:${encodeURIComponent(a.name)}`)}
                    >
                      <span className="brw__art brw__art--round brw__art--ph" aria-hidden>
                        <User />
                      </span>
                      <button
                        type="button"
                        className="brw__cardplay"
                        aria-label={`${t("fs.playBtn")} ${a.name}`}
                        title={`${t("fs.playBtn")} ${a.name}`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          playExternal(a.name);
                        }}
                      >
                        <Play weight="fill" />
                      </button>
                      <span className="brw__cardt">{a.name}</span>
                      <span className="brw__cards">
                        {a.plays} {t("brw.plays")}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {playlists.length > 0 && (
              <section className="brw__section">
                <span className="brw__kick">{t("lib.playlists")}</span>
                <div className="brw__grid">
                  {playlists.map((p) => (
                    <button
                      key={p.path}
                      className="brw__card"
                      title={p.name}
                      onClick={() => openPlaylist(p)}
                    >
                      {plArts[p.path] ? (
                        <img className="brw__art" src={plArts[p.path]} alt="" />
                      ) : (
                        <GenCover name={p.name} />
                      )}
                      <button
                        type="button"
                        className="brw__cardplay"
                        aria-label={`${t("fs.playBtn")} ${p.name}`}
                        title={`${t("fs.playBtn")} ${p.name}`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          playPlaylist(p);
                        }}
                      >
                        <Play weight="fill" />
                      </button>
                      <span className="brw__cardt">{p.name}</span>
                      <span className="brw__cards">playlist</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {view === "liked" && (
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
              {liked
                .filter(
                  (e) =>
                    !plQuery.trim() ||
                    e.title.toLowerCase().includes(plQuery.trim().toLowerCase()) ||
                    e.artist.toLowerCase().includes(plQuery.trim().toLowerCase()),
                )
                .map((e) => (
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
          </>
        )}

        {view === "queue" && (
          <>
            {queue.items.length > 0 && (
              <div className="brw__qtools">
                <span className="seg seg--ghost">
                  <button
                    title={t("lib.save")}
                    onClick={() => {
                      setDlgName("");
                      setDlg({ kind: "save" });
                    }}
                  >
                    {t("lib.save")}
                  </button>
                  <button onClick={() => void bridge.clearQueue().catch(fail)}>
                    {t("lib.clear")}
                  </button>
                </span>
              </div>
            )}
            <div className="lib">
              {queue.items.map((item, i) => {
                const current = queue.currentIndex === i;
                const ci = queue.currentIndex ?? -1;
                return (
                  <Fragment key={item.path}>
                    {current && (
                      <div className="brw__kick brw__qsection">
                        {t("fs.nowPlaying")}
                      </div>
                    )}
                    {i === ci + 1 && (
                      <div className="brw__kick brw__qsection">
                        {t("brw.nextInQueue")}
                      </div>
                    )}
                    <div
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (
                        (e.key === "Enter" || e.key === " ") &&
                        e.target === e.currentTarget
                      ) {
                        e.preventDefault();
                        void bridge.playQueueIndex(i);
                      }
                    }}
                    className={[
                      "lib__row",
                      "lib__row--num",
                      current ? "lib__row--current" : "",
                      dragIdx === i ? "lib__row--dragging" : "",
                      dropIdx === i && dragIdx !== i ? "lib__row--dropover" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    draggable
                    onDragStart={(e) => {
                      /* Also published for rail-playlist drops. */
                      e.dataTransfer.setData("application/x-noctbeat-track", item.path);
                      e.dataTransfer.effectAllowed = "copyMove";
                      setDragIdx(i);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDropIdx(i);
                    }}
                    onDragLeave={() => setDropIdx((d) => (d === i ? null : d))}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragIdx !== null && dragIdx !== i) {
                        void bridge.queueMove(dragIdx, i).catch(fail);
                      }
                      setDragIdx(null);
                      setDropIdx(null);
                    }}
                    onDragEnd={() => {
                      setDragIdx(null);
                      setDropIdx(null);
                    }}
                    onClick={() => void bridge.playQueueIndex(i)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCtx({ x: e.clientX, y: e.clientY, kind: "queue", index: i });
                    }}
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
                    <Art url={item.track.artworkUrl} />
                    <span className="lib__title">{item.track.title}</span>
                    <span className="lib__sub">{item.track.artist}</span>
                    <span className="lib__dur">
                      {item.track.durationMs ? formatTime(item.track.durationMs) : ""}
                    </span>
                    <button
                      className="lib__rm"
                      aria-label={current ? t("fs.playingCantRemove") : t("fs.removeFromQueue")}
                      title={current ? t("fs.playingCantRemove") : t("fs.removeFromQueue")}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!current) void bridge.queueRemove(i).catch(fail);
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                  </Fragment>
                );
              })}
              {queue.items.length === 0 && (
                <span className="brw__empty">{t("lib.queueEmpty")}</span>
              )}
            </div>
          </>
        )}

        {view.startsWith("pl:") && (
          <>
            <div className="brw__plhead">
              <span className="brw__plart">
                {plArt ? (
                  <Art url={plArt} icon={<Playlist />} />
                ) : (
                  <GenCover name={plName} />
                )}
              </span>
              <span className="brw__plmeta">
                <span className="brw__plt">{plName}</span>
                <span className="brw__pls">
                  {plTracks.length} {plTracks.length === 1 ? t("lib.track") : t("lib.tracks")}
                  {plTracks.some((pt) => pt.durationMs > 0) && (
                    <>
                      {" · "}
                      {formatTime(
                        plTracks.reduce((ms, pt) => ms + pt.durationMs, 0),
                      )}
                      {/* '+' flags a subtotal: some rows report no length. */}
                      {plTracks.some((pt) => pt.durationMs === 0) ? "+" : ""}
                    </>
                  )}
                </span>
              </span>
              <span className="seg seg--ghost">
                <button
                  title={t("fs.shuffle")}
                  onClick={() => {
                    const p = playlists.find((x) => `pl:${x.path}` === view);
                    if (!p) return;
                    void bridge
                      .setShuffle(true)
                      .then(() => {
                        setShuffle(true);
                        playPlaylist(p, true);
                      })
                      .catch(fail);
                  }}
                >
                  <Shuffle /> {t("fs.shuffle")}
                </button>
                <button
                  onClick={() => {
                    const p = playlists.find((x) => `pl:${x.path}` === view);
                    if (p) playPlaylist(p);
                  }}
                >
                  <Play weight="fill" /> {t("brw.playAll")}
                </button>
                <button
                  title={t("lib.rename")}
                  onClick={() => {
                    const p = playlists.find((x) => `pl:${x.path}` === view);
                    if (!p) return;
                    setDlgName(p.name);
                    setDlg({ kind: "rename", path: p.path, name: p.name });
                  }}
                >
                  <PencilSimple /> {t("lib.rename")}
                </button>
                <button
                  title={t("lib.delete")}
                  onClick={() => {
                    const p = playlists.find((x) => `pl:${x.path}` === view);
                    if (!p) return;
                    setDlg({ kind: "delete", path: p.path, name: p.name });
                  }}
                >
                  <Trash /> {t("lib.delete")}
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
            {plLoading && <span className="brw__empty">{t("srch.loading")}</span>}
            {plTracks.length > 0 && (
              <div className="brw__colhead" aria-hidden>
                <span>#</span>
                <button
                  className={plSort.key === "title" ? "on" : ""}
                  onClick={() => toggleSort("title")}
                  title={t("brw.colTitle")}
                >
                  {t("brw.colTitle")}
                  {plSort.key === "title" ? (
                    plSort.dir === 1 ? (
                      <CaretUp />
                    ) : (
                      <CaretDown />
                    )
                  ) : (
                    <CaretUpDown />
                  )}
                </button>
                <button
                  className={plSort.key === "artist" ? "on" : ""}
                  onClick={() => toggleSort("artist")}
                  title={t("srch.artist")}
                >
                  {t("srch.artist")}
                  {plSort.key === "artist" ? (
                    plSort.dir === 1 ? (
                      <CaretUp />
                    ) : (
                      <CaretDown />
                    )
                  ) : (
                    <CaretUpDown />
                  )}
                </button>
                <button
                  className={`brw__coldur ${plSort.key === "duration" ? "on" : ""}`}
                  onClick={() => toggleSort("duration")}
                  title={t("brw.colDuration")}
                >
                  <Clock />
                  {plSort.key === "duration" ? (
                    plSort.dir === 1 ? (
                      <CaretUp />
                    ) : (
                      <CaretDown />
                    )
                  ) : (
                    <CaretUpDown />
                  )}
                </button>
              </div>
            )}
            <div className="lib">
              {plShown.map(({ t: pt, i }) => {
                const current = isNow(pt);
                return (
                <div
                  className={[
                    "lib__row",
                    current ? "lib__row--current" : "",
                    dragIdx === i ? "lib__row--dragging" : "",
                    dropIdx === i && dragIdx !== i ? "lib__row--dropover" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  role="button"
                  tabIndex={0}
                  key={`${pt.path}-${i}`}
                  title={pt.title || pt.path.split("/").pop()}
                  /* Sorted/filtered rows don't map to file indices —
                     Spotify locks manual reorder the same way. */
                  draggable={!plQuery.trim() && !plSort.key}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/x-noctbeat-track", pt.path);
                    e.dataTransfer.effectAllowed = "copyMove";
                    setDragIdx(i);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDropIdx(i);
                  }}
                  onDragLeave={() => setDropIdx((d) => (d === i ? null : d))}
                  onDrop={(e) => {
                    e.preventDefault();
                    const p = playlists.find((x) => `pl:${x.path}` === view);
                    if (p && dragIdx !== null && dragIdx !== i) {
                      const from = dragIdx;
                      setPlTracks((ts) => {
                        const n = [...ts];
                        const [m] = n.splice(from, 1);
                        n.splice(i, 0, m);
                        return n;
                      });
                      void bridge
                        .playlistMoveTrack(p.path, from, i)
                        .catch((err) => {
                          fail(err);
                          return bridge
                            .playlistTracks(p.path)
                            .then(setPlTracks)
                            .catch(() => {});
                        });
                    }
                    setDragIdx(null);
                    setDropIdx(null);
                  }}
                  onDragEnd={() => {
                    setDragIdx(null);
                    setDropIdx(null);
                  }}
                  onClick={() => playPlTrack(i)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtx({ x: e.clientX, y: e.clientY, kind: "pl", index: i });
                  }}
                  onKeyDown={(e) => {
                    if (
                      (e.key === "Enter" || e.key === " ") &&
                      e.target === e.currentTarget
                    ) {
                      e.preventDefault();
                      playPlTrack(i);
                    }
                  }}
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
                  <span className="lib__title">{pt.title || pt.path.split("/").pop()}</span>
                  <span className="lib__sub">{pt.artist}</span>
                  <span className="lib__dur">
                    {pt.remote ? "stream" : pt.durationMs ? formatTime(pt.durationMs) : ""}
                  </span>
                  <button
                    className="lib__rm"
                    title={t("lib.removeFromPlaylist")}
                    aria-label={t("lib.removeFromPlaylist")}
                    onClick={(e) => {
                      e.stopPropagation();
                      removePlTrack(i);
                    }}
                  >
                    <X />
                  </button>
                </div>
                );
              })}
            </div>
          </>
        )}
      </main>

      {dlg && (
        <span className="brw__dlg" onClick={() => setDlg(null)}>
          <span
            className="brw__dlgcard"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setDlg(null);
                return;
              }
              if (e.key !== "Tab") return;
              /* Focus trap: Tab cycles through the card's own
                 controls so focus can't fall behind the overlay. */
              const els = Array.from(
                e.currentTarget.querySelectorAll<HTMLElement>(
                  "button, input",
                ),
              );
              if (els.length === 0) return;
              const first = els[0];
              const last = els[els.length - 1];
              const active = document.activeElement as HTMLElement | null;
              if (e.shiftKey && active === first) {
                e.preventDefault();
                last.focus();
              } else if (!e.shiftKey && active === last) {
                e.preventDefault();
                first.focus();
              } else if (active && !els.includes(active)) {
                e.preventDefault();
                (e.shiftKey ? last : first).focus();
              }
            }}
          >
            <span className="brw__dlgtitle">
              {dlg.kind === "save"
                ? t("lib.save")
                : dlg.kind === "create"
                  ? t("lib.newPlaylist")
                  : dlg.kind === "rename"
                    ? t("lib.rename")
                    : t("lib.delete")}
            </span>
            {dlg.kind === "delete" ? (
              <span className="brw__dlgname">{dlg.name}</span>
            ) : (
              <input
                className="brw__dlginput"
                autoFocus
                value={dlgName}
                placeholder={t("lib.playlistName")}
                aria-label={t("lib.playlistName")}
                onChange={(e) => setDlgName(e.target.value)}
                onKeyDown={(e) => {
                  /* Enter that confirms an IME candidate must not
                     submit — the name hasn't reached dlgName yet. */
                  if (e.key === "Enter" && !e.nativeEvent.isComposing)
                    submitDlg();
                }}
              />
            )}
            <span className="brw__dlgbtns">
              <button className="brw__dlgbtn" onClick={() => setDlg(null)}>
                {t("brw.cancel")}
              </button>
              <button
                className={`brw__dlgbtn brw__dlgbtn--go ${dlg.kind === "delete" ? "brw__dlgbtn--danger" : ""}`}
                autoFocus={dlg.kind === "delete"}
                onClick={submitDlg}
              >
                {dlg.kind === "save"
                  ? t("lib.save")
                  : dlg.kind === "create"
                    ? t("lib.create")
                    : dlg.kind === "rename"
                      ? t("lib.rename")
                      : t("lib.delete")}
              </button>
            </span>
          </span>
        </span>
      )}

      {ctx && (
        <span
          className="brw__ctx"
          style={{
            left: Math.max(8, Math.min(ctx.x, window.innerWidth - 184)),
            top: Math.max(8, Math.min(ctx.y, window.innerHeight - 120)),
          }}
        >
          {ctx.kind !== "railpl" && (
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
                  setDlg({
                    kind: "delete",
                    path: ctx.path ?? "",
                    name: ctx.name ?? "",
                  });
                }}
              >
                {t("lib.delete")}
              </button>
            </>
          )}
          {ctx.kind === "pl" && (
            <button
              onClick={() => {
                setCtx(null);
                removePlTrack(ctx.index);
              }}
            >
              {t("lib.removeFromPlaylist")}
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
      )}

      <footer className="brw__bar">
        {track ? (
          <>
            <Art url={track.artworkUrl} />
            <span className="brw__np">
              <span className="brw__npt">{track.title}</span>
              <span className="brw__npa">{track.artist}</span>
            </span>
            <button
              className={`brw__icon ${isFav ? "on" : ""}`}
              aria-label={isFav ? t("fs.unlike") : t("fs.like")}
              title={isFav ? t("fs.unlike") : t("fs.like")}
              onClick={() => {
                const entry = favEntryFor(np);
                if (entry) setFavs((prev) => toggleFav(prev, entry));
              }}
            >
              <Heart size={15} weight={isFav ? "fill" : "regular"} />
            </button>
          </>
        ) : (
          <span className="brw__np" />
        )}
        <span className="brw__ctl">
          <button
            className={`brw__icon ${shuffle ? "on" : ""}`}
            aria-label={t("fs.shuffle")}
            title={t("fs.shuffle")}
            onClick={() =>
              void bridge.getShuffle().then((on) => {
                const next = !on;
                return bridge.setShuffle(next).then(() => setShuffle(next));
              })
            }
          >
            <Shuffle size={15} weight={shuffle ? "fill" : "regular"} />
          </button>
          <button
            className="brw__icon"
            aria-label={t("fs.prev")}
            title={t("fs.prev")}
            onClick={() => void bridge.mediaControl("previous")}
          >
            <SkipBack size={16} weight="fill" />
          </button>
          <button
            className="brw__icon brw__icon--play"
            aria-label={playing ? t("fs.pauseBtn") : t("fs.playBtn")}
            title={playing ? t("fs.pauseBtn") : t("fs.playBtn")}
            onClick={() => void bridge.mediaControl("play-pause")}
          >
            {playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
          </button>
          <button
            className="brw__icon"
            aria-label={t("fs.next")}
            title={t("fs.next")}
            onClick={() => void bridge.mediaControl("next")}
          >
            <SkipForward size={16} weight="fill" />
          </button>
          <button
            className={`brw__icon ${repeat !== "off" ? "on" : ""}`}
            aria-label={t(
              repeat === "off"
                ? "fs.repeatOff"
                : repeat === "all"
                  ? "fs.repeatAll"
                  : "fs.repeatOne",
            )}
            title={t(
              repeat === "off"
                ? "fs.repeatOff"
                : repeat === "all"
                  ? "fs.repeatAll"
                  : "fs.repeatOne",
            )}
            onClick={() =>
              void bridge.getRepeat().then((m) => {
                const next = m === "off" ? "all" : m === "all" ? "one" : "off";
                return bridge.setRepeat(next).then(() => setRepeat(next));
              })
            }
          >
            {repeat === "one" ? (
              <RepeatOnce size={15} weight="fill" />
            ) : (
              <Repeat size={15} weight={repeat === "all" ? "fill" : "regular"} />
            )}
          </button>
          <span className="brw__time">{track ? formatTime(np?.positionMs ?? 0) : "0:00"}</span>
          <button
            className="brw__seek"
            aria-label={t("brw.seek")}
            onClick={(e) => {
              if (!track?.durationMs) return;
              const r = e.currentTarget.getBoundingClientRect();
              void bridge.seek(
                Math.round(((e.clientX - r.left) / r.width) * track.durationMs),
              );
            }}
          >
            <i style={{ width: `${progress * 100}%` }} />
          </button>
          <span className="brw__time">
            {track?.durationMs ? formatTime(track.durationMs) : "0:00"}
          </span>
        </span>
        <button
          className={`brw__icon ${view === "queue" ? "on" : ""}`}
          aria-label={t("lib.queue")}
          title={t("lib.queue")}
          onClick={() => go("queue")}
        >
          <ListBullets size={15} />
        </button>
        <span
          className={`brw__volwrap ${volLocal ? "" : "brw__volwrap--off"}`}
          title={volLocal ? t("fs.volume") : t("brw.volLocalOnly")}
        >
          <button
            className={`brw__icon ${vol === 0 ? "" : "on"}`}
            disabled={!volLocal}
            aria-label={vol === 0 ? t("fs.unmute") : t("fs.mute")}
            title={volLocal ? (vol === 0 ? t("fs.unmute") : t("fs.mute")) : t("brw.volLocalOnly")}
            onClick={() => {
              const next = vol === 0 ? preMuteVol : 0;
              if (vol !== 0) preMuteVol = vol;
              setVol(next);
              void bridge.setVolume(next);
            }}
          >
            {vol === 0 ? <SpeakerSlash size={15} /> : <SpeakerHigh size={15} />}
          </button>
          <input
            className="brw__vol"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={vol}
            disabled={!volLocal}
            aria-label={t("fs.volume")}
            onChange={(e) => {
              const v = Number(e.target.value);
              setVol(v);
              void bridge.setVolume(v);
            }}
          />
        </span>
        <button
          className="brw__icon brw__icon--live"
          aria-label={t("brw.liveView")}
          title={t("brw.liveView")}
          onClick={() => nav("/")}
        >
          <SquaresFour size={15} />
          <span>{t("brw.liveView")}</span>
        </button>
        <button
          className="brw__icon"
          aria-label={t("nav.fullscreen")}
          title={t("nav.fullscreen")}
          /* Browser preview can't go fullscreen — take them to the
             live stage instead so the button is never dead. */
          onClick={() =>
            bridge.isTauri() ? void bridge.toggleFullscreen() : nav("/")
          }
        >
          <ArrowsOut size={15} />
        </button>
      </footer>
    </div>
  );
}
