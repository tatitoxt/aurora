import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  artSrc,
  bridge,
  subscribe,
  type NowPlaying,
  type PlaylistFile,
  type PlaylistTrack,
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
  CaretLeft,
  CaretRight,
  Heart,
  House,
  ListBullets,
  MagnifyingGlass,
  MusicNote,
  Pause,
  Play,
  Playlist,
  Repeat,
  RepeatOnce,
  Shuffle,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SquaresFour,
  User,
  X,
} from "@phosphor-icons/react";

/** Providers tried, in order, when playing a catalog/stats entry. */
const AUTO_ORDER = ["spotify", "youtube", "soundcloud", "apple", "tidal", "amazon"];

type View = "home" | "search" | "liked" | "queue" | "services" | `pl:${string}`;

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
  const [recent, setRecent] = useState<PlayRecord[]>([]);
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

  const refresh = () => {
    void bridge.getQueue().then(setQueue).catch(() => {});
    /* Tabs can connect while Browse is mounted — keep the provider set
       live or playback still reports no tab. */
    void bridge.getExtStatus().then(setExt).catch(() => {});
  };
  useEffect(() => {
    refresh();
    void bridge.listPlaylists().then(setPlaylists).catch(() => {});
    void bridge.getStats().then(setStats).catch(() => {});
    void bridge.recentPlays(12).then(setRecent).catch(() => {});
    const offQ = subscribe<QueueState>("queue", setQueue);
    const offNp = subscribe<NowPlaying>("now-playing", (n) => {
      setNp(n);
      refresh();
    });
    const offFavs = subscribeFavs(() => setFavs(loadFavs()));
    void bridge.getShuffle().then(setShuffle).catch(() => {});
    void bridge.getRepeat().then(setRepeat).catch(() => {});
    void bridge.getVolume().then(setVol).catch(() => {});
    const poll = setInterval(refresh, 4000);
    return () => {
      offQ();
      offNp();
      offFavs();
      clearInterval(poll);
    };
  }, []);

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

  const openPlaylist = (p: PlaylistFile) => {
    go(`pl:${p.path}`);
    setPlLoading(true);
    setPlTracks([]);
    void bridge
      .playlistTracks(p.path)
      .then(setPlTracks)
      .catch(fail)
      .finally(() => setPlLoading(false));
  };

  const playPlaylist = (p: PlaylistFile) => {
    setErr("");
    const before = queue.items.length;
    void bridge
      .importPlaylist(p.path)
      .then((res) => {
        if (res.imported === 0) return;
        return bridge.getQueue().then((q) => {
          setQueue(q);
          const first = Math.min(before, q.items.length - 1);
          return bridge.playQueueIndex(Math.max(0, first));
        });
      })
      .catch(fail);
  };

  const plName =
    view.startsWith("pl:")
      ? (playlists.find((p) => p.path === view.slice(3))?.name ?? "Playlist")
      : "";

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
    const before = queue.items.length;
    void bridge
      .importPlaylist(p.path)
      .then((res) => {
        if (res.imported === 0) return;
        return bridge.getQueue().then((q2) => {
          setQueue(q2);
          const added = q2.items.slice(before);
          /* Exact path wins: an earlier entry may share title+artist but
             point at a different recording. */
          let idx = added.findIndex((it) => it.path === pt.path);
          if (idx < 0)
            idx = added.findIndex(
              (it) =>
                it.track.title === pt.title && it.track.artist === pt.artist,
            );
          if (idx >= 0) return bridge.playQueueIndex(before + idx);
          setErr(t("brw.trackMissing"));
        });
      })
      .catch(fail);
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
      onClick: () => nav(`/artist/${encodeURIComponent(a.name)}`),
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
        <span className="brw__brand">
          <img className="brw__logo" src="/noctbeat-mark.svg" alt="" />
          {bridge.productName}
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
            value={q}
            placeholder={t("fs.searchSongs")}
            aria-label={t("brw.search")}
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

        <span className="brw__railhead">{t("lib.playlists")}</span>
        <div className="brw__pllist">
          {playlists.map((p) => (
            <button
              key={p.path}
              className={`brw__nav brw__nav--pl ${view === `pl:${p.path}` ? "on" : ""}`}
              onClick={() => openPlaylist(p)}
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
            {view.startsWith("pl:") && plName}
          </h1>
        </header>
        {err && <span className="license-bad">{err}</span>}
        {note && <span className="note">● {note}</span>}

        {view === "search" && (
          <div className="brw__search">
            <SearchPanel
              src="auto"
              label={(id) => id}
              connected={connected}
              onPlayed={refresh}
              query={q}
              onQuery={setQ}
              songLimit={6}
              aside={
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

        {view === "home" && (
          <>
            <h2 className="brw__greet">{greet}</h2>
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
                        {e.plays} {t("brw.plays")}
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
                    <Link
                      key={a.name}
                      className="brw__card brw__card--round"
                      to={`/artist/${encodeURIComponent(a.name)}`}
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
                    </Link>
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
                      <span className="brw__art brw__art--ph" aria-hidden>
                        <Playlist />
                      </span>
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
            {liked.length === 0 && <span className="brw__empty">{t("lib.likedEmpty")}</span>}
            <div className="lib">
              {liked.map((e) => (
                <button key={e.key} className="lib__row" onClick={() => playLiked(e)}>
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

        {view === "queue" && (
          <>
            {queue.items.length > 0 && (
              <div className="brw__qtools">
                <span className="seg seg--ghost">
                  <button onClick={() => void bridge.clearQueue().catch(fail)}>
                    {t("lib.clear")}
                  </button>
                </span>
              </div>
            )}
            <div className="lib">
              {queue.items.map((item, i) => {
                const current = queue.currentIndex === i;
                return (
                  <div
                    key={item.path}
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
                    onDragStart={() => setDragIdx(i)}
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
              <span className="brw__art brw__art--ph" aria-hidden>
                <Playlist />
              </span>
              <span className="brw__plmeta">
                <span className="brw__plt">{plName}</span>
                <span className="brw__pls">
                  {plTracks.length} {plTracks.length === 1 ? t("lib.track") : t("lib.tracks")}
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
                        playPlaylist(p);
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
              </span>
            </div>
            {plLoading && <span className="brw__empty">{t("srch.loading")}</span>}
            <div className="lib">
              {plTracks.map((pt, i) => (
                <button
                  className="lib__row"
                  key={`${pt.path}-${i}`}
                  title={pt.title || pt.path.split("/").pop()}
                  onClick={() => playPlTrack(i)}
                >
                  <span className="lib__idx">{i + 1}</span>
                  <span className="lib__title">{pt.title || pt.path.split("/").pop()}</span>
                  <span className="lib__sub">{pt.artist}</span>
                  <span className="lib__dur">
                    {pt.remote ? "stream" : pt.durationMs ? formatTime(pt.durationMs) : ""}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </main>

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
        <span className="brw__volwrap" title={t("fs.volume")}>
          <SpeakerHigh size={15} />
          <input
            className="brw__vol"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={vol}
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
          onClick={() => void bridge.toggleFullscreen()}
        >
          <ArrowsOut size={15} />
        </button>
      </footer>
    </div>
  );
}
