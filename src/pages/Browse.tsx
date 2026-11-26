import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
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
import BrowserSources from "../BrowserSources";
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
import { Art, GenCover, SeekCluster, SyncBackdrop } from "./browse/bits";
import {
  AUTO_ORDER,
  LAST_VIEW_KEY,
  RECENT_SEARCHES_KEY,
  readLastView,
  sameJson,
  type View,
} from "./browse/types";
import SearchView from "./browse/SearchView";
import RecentView from "./browse/RecentView";
import ArtistView from "./browse/ArtistView";
import HomeView from "./browse/HomeView";
import LikedView from "./browse/LikedView";
import QueueView from "./browse/QueueView";
import PlaylistView from "./browse/PlaylistView";
import DlgModal from "./browse/DlgModal";
import CtxMenu from "./browse/CtxMenu";
import Playbar from "./browse/Playbar";
import LyricsPanel from "./browse/LyricsPanel";
import Rail from "./browse/Rail";

/* Module scope: the ref resets when Browse unmounts (Live view and
   back), which would silently revert unmute to the default volume. */
const preMuteVolRef = { current: 0.8 };


export default function Browse() {
  const t = useT();
  const nav = useNavigate();
  const [view, setView] = useState<View>(readLastView);
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
  const [showLyrics, setShowLyrics] = useState(false);
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
    kind: "pl" | "queue" | "railpl" | "pladd";
    index: number;
    /* railpl: the playlist being right-clicked. pladd: the track
       path being added to a playlist. */
    path?: string;
    name?: string;
  } | null>(null);
  /* Serialized: a second remove before the first lands would hand
     playlist_remove_track an index that no longer exists in the file. */
  const plRemoving = useRef(false);
  /* Artist catalog results are static for the session — cache by
     artist so revisiting a page doesn't re-hit the extension. */
  const arCatalogCache = useRef(new Map<string, CatalogSong[]>());
  /* Rail playlist item highlighted as a drop target while a track
     row is dragged over it. */
  const [plDrop, setPlDrop] = useState<string | null>(null);
  /* Spotify's "/" shortcut jumps focus to the rail search box. */
  const railSearchRef = useRef<HTMLInputElement>(null);
  const [recent, setRecent] = useState<PlayRecord[]>([]);
  const [arSongs, setArSongs] = useState<CatalogSong[]>([]);
  const [arLocal, setArLocal] = useState<QueueItem[]>([]);
  const [arLoading, setArLoading] = useState(false);
  /* Long lists render in 200-row pages revealed by a sentinel — a
     2 000-track playlist shouldn't mount 2 000 rows of DOM at once. */
  const [listLimit, setListLimit] = useState(200);
  const listEndRef = useRef<HTMLDivElement>(null);
  /* Multi-select on playlist rows: indices into plTracks (the stored
     file order), so they stay valid under find/sort. */
  const [sel, setSel] = useState<Set<number>>(new Set());
  const selAnchor = useRef<number | null>(null);
  const [plSort, setPlSort] = useState<{
    key: "title" | "artist" | "duration" | null;
    dir: 1 | -1;
  }>({ key: null, dir: 1 });
  const [plQuery, setPlQuery] = useState("");
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
        if (v > 0) preMuteVolRef.current = v;
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
      /* Everything except the volatile fields is render-worthy:
         metadata can arrive after the track starts (duration,
         artwork). updatedAtMs is stamped fresh on every snapshot,
         so it must stay out of the signature together with
         positionMs — otherwise every tick still re-renders. */
      const { positionMs: _pos, updatedAtMs: _upd, ...rest } = n;
      const sig = JSON.stringify(rest);
      if (sig !== npSig.current) {
        npSig.current = sig;
        setNp(n);
        refresh();
      }
    });
    const offFavs = subscribeFavs(() => setFavs(loadFavs()));
    void bridge.getShuffle().then(setShuffle).catch(() => {});
    void bridge.getRepeat().then(setRepeat).catch(() => {});
    void bridge.getVolume().then((v) => {
      setVol(v);
      if (v > 0) preMuteVolRef.current = v;
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
      /* Playlist multi-select: Esc clears, Cmd/Ctrl+A picks every row
         (unless the user is selecting text in a field). */
      if (view.startsWith("pl:")) {
        if (e.key === "Escape" && sel.size > 0) {
          setSel(new Set());
          return;
        }
        if (
          e.key === "a" &&
          (e.metaKey || e.ctrlKey) &&
          !inField &&
          plShown.length > 0
        ) {
          e.preventDefault();
          /* Select-all covers the rows the user can see — a filter
             must not rope hidden tracks into a bulk delete. */
          setSel(new Set(plShown.map((r) => r.i)));
          return;
        }
      }
      /* Esc peels UI layers before navigating: context menu, then
         dialogs, then back in the view history — so one key never
         does two things. */
      if (e.key === "Escape") {
        /* The command palette lives outside this component — while
           it's open, Esc is its key, not ours. */
        if (document.querySelector(".palette-backdrop")) return;
        if (ctx) {
          setCtx(null);
          return;
        }
        if (addTo) {
          setAddTo(null);
          return;
        }
        if (dlg) {
          setDlg(null);
          return;
        }
        if (!inField && past.length > 0) {
          goBack();
          return;
        }
      }
      /* Media shortcuts, Spotify-style: Ctrl/Cmd+arrows for volume and
         transport, Space toggles play — all inert while typing. */
      if (!inField && (e.ctrlKey || e.metaKey)) {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const d = e.key === "ArrowUp" ? 0.05 : -0.05;
          setVol((v) => {
            const nv = Math.min(1, Math.max(0, v + d));
            if (nv > 0) preMuteVolRef.current = nv;
            void bridge.setVolume(nv).catch(() => {});
            return nv;
          });
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          void bridge.mediaControl("next");
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          void bridge.mediaControl("previous");
          return;
        }
      }
      if (e.key === " " && !inField) {
        e.preventDefault();
        void bridge.mediaControl("play-pause");
        return;
      }
      /* "/" jumps to search (Ctrl/Cmd+K belongs to the Palette). */
      if (e.key !== "/" || inField) return;
      e.preventDefault();
      go("search");
      /* The rail input collapses to an icon under 440px — focusing a
         hidden element drops the keystrokes, so aim at the panel's
         own input after it mounts. */
      const rail = railSearchRef.current;
      if (rail && rail.offsetParent !== null) rail.focus();
      else
        requestAnimationFrame(() =>
          document.querySelector<HTMLInputElement>(".srch input")?.focus(),
        );
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, sel.size, plShown, ctx, addTo, dlg, past.length]);

  /* Re-entering Browse from Stage should land where you left off. */
  useEffect(() => {
    try {
      localStorage.setItem(LAST_VIEW_KEY, view);
    } catch {
      /* storage can be unavailable in private contexts */
    }
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

  /* These derive from inputs that change rarely (favs, np track
     identity) — recomputing them per render allocated a Set and
     re-ran listable over every favorite on every tick. */
  const liked = useMemo(() => listable(favs), [favs]);
  const favSet = useMemo(() => new Set(favs.map((f) => f.key)), [favs]);
  const favKey = useMemo(() => favKeyFor(np), [np]);
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


  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (msg: string) => {
    setNote(msg);
    setErr("");
    /* Retrigger: a stale timer must not clear the newer note early. */
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(""), 2800);
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

  /* pool narrows the queue to a section's rows (e.g. one artist's
     likes) — Next must play the next row in that section, not jump
     to an unrelated favorite. */
  const playLiked = (e: FavEntry, pool?: FavEntry[]) => {
    setErr("");
    const replay = replayFor(e);
    if (!replay) return;
    if (replay.kind === "external") {
      playExternal(replay.query);
      return;
    }
    const locals = (pool ?? liked)
      .filter((x) => replayFor(x)?.kind === "local")
      .map(toQueueItem);
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
      .catch((e) => {
        fail(e);
        /* A persisted pl: view can outlive the file — a renamed or
           deleted playlist would reload into the dead page forever.
           Bail to Home only when the file is confirmed gone, not on
           a transient IPC error. */
        void bridge
          .listPlaylists()
          .then((pls) => {
            if (!pls.some((x) => x.path === view.slice(3))) setView("home");
          })
          .catch(() => {});
      })
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
    const cached = arCatalogCache.current.get(name.trim().toLowerCase());
    if (cached) {
      setArSongs(cached);
      setArLoading(false);
      return;
    }
    void bridge
      .catalogSearch(name)
      /* catalogSearch matches the term anywhere (title, album);
         an artist page must list that artist's own catalog — the
         same credit filter SearchPanel applies internally. */
      .then((r) => {
        const songs = r.filter((s) =>
          s.artist.toLowerCase().includes(name.trim().toLowerCase()),
        );
        arCatalogCache.current.set(name.trim().toLowerCase(), songs);
        setArSongs(songs);
      })
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
  /* Liked rows reuse the same find box text. */
  const likedShown = useMemo(
    () =>
      liked.filter(
        (e) =>
          !plQuery.trim() ||
          e.title.toLowerCase().includes(plQuery.trim().toLowerCase()) ||
          e.artist.toLowerCase().includes(plQuery.trim().toLowerCase()),
      ),
    [liked, plQuery],
  );

  /* A new view or filter restarts the reveal window. */
  useEffect(() => setListLimit(200), [view, plQuery]);
  useEffect(() => {
    setSel(new Set());
    selAnchor.current = null;
  }, [view]);
  /* The anchor is a display position — any reorder, filter change or
     file mutation (delete/move renumbers rows) makes it point at a
     different track, so the next Shift-click must re-anchor. */
  useEffect(() => {
    selAnchor.current = null;
  }, [plQuery, plSort, plTracks]);
  useEffect(() => {
    const el = listEndRef.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) setListLimit((l) => l + 200);
    });
    io.observe(el);
    return () => io.disconnect();
  });
  const toggleSort = (key: "title" | "artist" | "duration") =>
    setPlSort((p) =>
      p.key !== key
        ? { key, dir: 1 }
        : p.dir === 1
          ? { key, dir: -1 }
          : { key: null, dir: 1 },
    );
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
    /* Check emptiness first: clearing the live queue for an empty
       playlist would force restoreQueue to restart the current track
       from position 0, even when it was paused. */
    void bridge
      .playlistTracks(p.path)
      .then((ts) => {
        if (ts.length === 0) {
          flash(t("brw.noTracks"));
          return;
        }
        return bridge
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
              const idx = shuffled
                ? Math.floor(Math.random() * q.items.length)
                : 0;
              return bridge.playQueueIndex(idx).catch((e) => {
                restoreQueue(saved);
                throw e;
              });
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
  /* Liked songs by this artist — the artist page shows your own
     relationship, not just the catalog (Spotify does the same). */
  const arLiked = useMemo(
    () =>
      arName
        ? liked.filter(
            (e) => e.artist.trim().toLowerCase() === arName.trim().toLowerCase(),
          )
        : [],
    [liked, arName],
  );
  /* Spotify groups Recently played by day. */
  const recGroups = useMemo(() => {
    const dayStart = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
    const today = dayStart(Date.now());
    const m = new Map<number, PlayRecord[]>();
    for (const r of recent) {
      const d = dayStart(r.playedAtMs);
      const g = m.get(d);
      if (g) g.push(r);
      else m.set(d, [r]);
    }
    return [...m.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([d, rows]) => ({
        label:
          d === today
            ? t("brw.today")
            : d === today - 86400000
              ? t("brw.yesterday")
              : new Date(d).toLocaleDateString(),
        rows,
      }));
  }, [recent, t]);
  /* Queue stats line: tracks + total runtime of what's left. */
  const queueLeftMs = useMemo(
    () =>
      queue.items
        .slice(Math.max(0, queue.currentIndex ?? 0))
        .reduce((s, i) => s + (i.track.durationMs ?? 0), 0),
    [queue],
  );
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
      .then(() => {
        setPlTracks((ts) => ts.filter((_, j) => j !== i));
        /* Rows below the deleted one shift down — renumber the
           selection so it still points at the same tracks. */
        setSel((s) => {
          if (s.size === 0) return s;
          const n = new Set<number>();
          s.forEach((j) => {
            if (j < i) n.add(j);
            else if (j > i) n.add(j - 1);
          });
          return n;
        });
      })
      .catch(fail)
      .finally(() => {
        plRemoving.current = false;
      });
  };

  /* Arrow keys walk focus across .lib__row siblings, skipping the
     section kickers and headers between them. */
  const navRow = (e: React.KeyboardEvent, dir: 1 | -1) => {
    let sib: Element | null =
      dir > 0
        ? e.currentTarget.nextElementSibling
        : e.currentTarget.previousElementSibling;
    while (sib && !sib.classList.contains("lib__row"))
      sib =
        dir > 0 ? sib.nextElementSibling : sib.previousElementSibling;
    if (sib) {
      e.preventDefault();
      (sib as HTMLElement).focus();
    }
  };

  /* Bulk remove: walk selected indices descending so each deletion
     leaves the earlier indices valid. One reload at the end. */
  const removeSelected = () => {
    const p = playlists.find((x) => `pl:${x.path}` === view);
    if (!p || sel.size === 0 || plRemoving.current) return;
    plRemoving.current = true;
    const idx = [...sel].sort((a, b) => b - a);
    void idx
      .reduce(
        (pr, i) => pr.then(() => bridge.playlistRemoveTrack(p.path, i)),
        Promise.resolve() as Promise<unknown>,
      )
      .then(() => bridge.playlistTracks(p.path).then(setPlTracks))
      .catch(fail)
      .finally(() => {
        plRemoving.current = false;
        setSel(new Set());
        selAnchor.current = null;
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
          /* Deleting a different playlist from the rail shouldn't
             yank the user off the one they're browsing (or wipe its
             find/sort state). */
          if (view === `pl:${dlg.path}`) go("home");
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
        <SyncBackdrop
          url={videoUrl}
          playing={playing}
          cls="brw__bgvid"
          readyCls="brw__bgvid--ready"
        />
      )}
      <Rail
        view={view}
        q={q}
        setQ={setQ}
        go={go}
        railSearchRef={railSearchRef}
        liked={liked}
        queue={queue}
        playlists={playlists}
        openPlaylist={openPlaylist}
        plDrop={plDrop}
        setPlDrop={setPlDrop}
        setCtx={setCtx}
        setDlg={setDlg}
        setDlgName={setDlgName}
        setPlTracks={setPlTracks}
        flash={flash}
        fail={fail}
      />

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
          <SearchView
            q={q}
            setQ={setQ}
            sFilter={sFilter}
            setSFilter={setSFilter}
            recentSearches={recentSearches}
            setRecentSearches={setRecentSearches}
            connected={connected}
            refresh={refresh}
            pushSearch={pushSearch}
            openPlaylist={openPlaylist}
            playlists={playlists}
            goArtist={(name) => go(`ar:${encodeURIComponent(name)}`)}
          />
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
          <ArtistView
            arName={arName}
            arSongs={arSongs}
            arLocal={arLocal}
            arLiked={arLiked}
            arGroups={arGroups}
            arLoading={arLoading}
            fail={fail}
            playExternal={playExternal}
            playLiked={playLiked}
            goArtist={(n) => go(`ar:${encodeURIComponent(n)}`)}
          />
        )}

        {view === "recent" && (
          <RecentView
            empty={recent.length === 0}
            recGroups={recGroups}
            playRecent={playRecent}
            recArt={recArt}
          />
        )}
        {view === "home" && (
          <HomeView
            greet={greet}
            jumpTiles={jumpTiles}
            recent={recent}
            playRecent={playRecent}
            recArt={recArt}
            queue={queue}
            liked={liked}
            playLiked={playLiked}
            stats={stats}
            playExternal={playExternal}
            playlists={playlists}
            openPlaylist={openPlaylist}
            plArts={plArts}
            playPlaylist={playPlaylist}
            go={go}
          />
        )}

        {view === "liked" && (
          <LikedView
            liked={liked}
            playLiked={playLiked}
            shuffleLiked={shuffleLiked}
            plQuery={plQuery}
            setPlQuery={setPlQuery}
            likedShown={likedShown}
            listLimit={listLimit}
            navRow={navRow}
            playlists={playlists}
            addTo={addTo}
            setAddTo={setAddTo}
            flash={flash}
            fail={fail}
            listEndRef={listEndRef}
          />
        )}

        {view === "queue" && (
          <QueueView
            queue={queue}
            playing={playing}
            queueLeftMs={queueLeftMs}
            navRow={navRow}
            dragIdx={dragIdx}
            setDragIdx={setDragIdx}
            dropIdx={dropIdx}
            setDropIdx={setDropIdx}
            setCtx={setCtx}
            setDlgName={setDlgName}
            setDlg={setDlg}
            fail={fail}
          />
        )}

        {view.startsWith("pl:") && (
          <PlaylistView
            view={view}
            plArt={plArt}
            plName={plName}
            plTracks={plTracks}
            setPlTracks={setPlTracks}
            plLoading={plLoading}
            playlists={playlists}
            plQuery={plQuery}
            setPlQuery={setPlQuery}
            plSort={plSort}
            toggleSort={toggleSort}
            plShown={plShown}
            isNow={isNow}
            playing={playing}
            sel={sel}
            setSel={setSel}
            selAnchor={selAnchor}
            dragIdx={dragIdx}
            setDragIdx={setDragIdx}
            dropIdx={dropIdx}
            setDropIdx={setDropIdx}
            navRow={navRow}
            removeSelected={removeSelected}
            playPlTrack={playPlTrack}
            removePlTrack={removePlTrack}
            listLimit={listLimit}
            listEndRef={listEndRef}
            setCtx={setCtx}
            setDlg={setDlg}
            setDlgName={setDlgName}
            setShuffle={setShuffle}
            playPlaylist={playPlaylist}
            fail={fail}
          />
        )}
              {showLyrics && <LyricsPanel close={() => setShowLyrics(false)} />}
      </main>

      {dlg && (
        <DlgModal
          dlg={dlg}
          setDlg={setDlg}
          dlgName={dlgName}
          setDlgName={setDlgName}
          submitDlg={submitDlg}
        />
      )}

      {ctx && (
        <CtxMenu
          ctx={ctx}
          setCtx={setCtx}
          playlists={playlists}
          plTracks={plTracks}
          queue={queue}
          sel={sel}
          go={go}
          playPlTrack={playPlTrack}
          removePlTrack={removePlTrack}
          removeSelected={removeSelected}
          setDlg={setDlg}
          setDlgName={setDlgName}
          flash={flash}
          fail={fail}
        />
      )}

      <Playbar
        track={track}
        np={np}
        playing={playing}
        isFav={isFav}
        setFavs={setFavs}
        shuffle={shuffle}
        setShuffle={setShuffle}
        repeat={repeat}
        setRepeat={setRepeat}
        vol={vol}
        setVol={setVol}
        volLocal={volLocal}
        view={view}
        go={go}
        preMuteVolRef={preMuteVolRef}
        showLyrics={showLyrics}
        toggleLyrics={() => setShowLyrics((v) => !v)}
      />
    </div>
  );
}
