import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  artSrc,
  bridge,
  subscribe,
  type NowPlaying,
  type PlaylistFile,
  type PlaylistTrack,
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
  Heart,
  House,
  ListBullets,
  MagnifyingGlass,
  MusicNote,
  Pause,
  Play,
  Playlist,
  SkipBack,
  SkipForward,
  SquaresFour,
  User,
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
    const offQ = subscribe<QueueState>("queue", setQueue);
    const offNp = subscribe<NowPlaying>("now-playing", (n) => {
      setNp(n);
      refresh();
    });
    const offFavs = subscribeFavs(() => setFavs(loadFavs()));
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
    setView(`pl:${p.path}`);
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
          <img className="brw__logo" src="/noctbeat-mark.png" alt="" />
          {bridge.productName}
        </span>
        <label
          className={`brw__railsearch ${view === "search" ? "on" : ""}`}
          /* Click or typing switches to Search — plain keyboard
             focus must not, or tabbing past the rail would jump
             the user into SearchPanel's autofocused input. The
             same click also opens Search when the input is
             collapsed to just an icon in narrow windows. */
          onClick={() => setView("search")}
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
              if (!(e.nativeEvent as InputEvent).isComposing) setView("search");
            }}
            /* Committing the same interim text fires no onChange —
               open Search when the composition ends instead. A
               canceled composition ends with empty data and must
               not switch the view. */
            onCompositionEnd={(e) => {
              if (e.data !== "") setView("search");
            }}
          />
        </label>
        <button
          className={`brw__nav ${view === "home" ? "on" : ""}`}
          onClick={() => setView("home")}
        >
          <House weight={view === "home" ? "fill" : "regular"} />
          <span>{t("brw.home")}</span>
        </button>
        <button
          className={`brw__nav ${view === "liked" ? "on" : ""}`}
          onClick={() => setView("liked")}
        >
          <Heart weight={view === "liked" ? "fill" : "regular"} />
          <span>{t("lib.liked")}</span>
          {liked.length > 0 && <em>{liked.length}</em>}
        </button>
        <button
          className={`brw__nav ${view === "queue" ? "on" : ""}`}
          onClick={() => setView("queue")}
        >
          <ListBullets weight={view === "queue" ? "fill" : "regular"} />
          <span>{t("fs.upNext")}</span>
          {queue.items.length > 0 && <em>{queue.items.length}</em>}
        </button>
        <button
          className={`brw__nav ${view === "services" ? "on" : ""}`}
          onClick={() => setView("services")}
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
            <section className="brw__section">
              <span className="brw__kick">{t("fs.upNext")}</span>
              <div className="brw__grid">
                {queue.items.slice(0, 12).map((item, i) => (
                  <button
                    key={item.path}
                    className="brw__card"
                    title={`${item.track.title} — ${item.track.artist}`}
                    onClick={() => void bridge.playQueueIndex(i)}
                  >
                    <Art url={item.track.artworkUrl} />
                    <span className="brw__cardt">{item.track.title}</span>
                    <span className="brw__cards">{item.track.artist}</span>
                  </button>
                ))}
                {queue.items.length === 0 && (
                  <span className="brw__empty">{t("lib.queueEmpty")}</span>
                )}
              </div>
            </section>

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
          <div className="lib">
            {queue.items.map((item, i) => {
              const current = queue.currentIndex === i;
              return (
                <button
                  key={item.path}
                  className={`lib__row lib__row--num ${current ? "lib__row--current" : ""}`}
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
                </button>
              );
            })}
            {queue.items.length === 0 && (
              <span className="brw__empty">{t("lib.queueEmpty")}</span>
            )}
          </div>
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
              <button
                className="seg seg--ghost"
                onClick={() => {
                  const p = playlists.find((x) => `pl:${x.path}` === view);
                  if (p) playPlaylist(p);
                }}
              >
                <Play weight="fill" /> {t("brw.playAll")}
              </button>
            </div>
            {plLoading && <span className="brw__empty">{t("srch.loading")}</span>}
            <div className="lib">
              {plTracks.map((pt, i) => (
                <div className="lib__row" key={`${pt.path}-${i}`}>
                  <span className="lib__idx">{i + 1}</span>
                  <span className="lib__title">{pt.title || pt.path.split("/").pop()}</span>
                  <span className="lib__sub">{pt.artist}</span>
                  <span className="lib__dur">
                    {pt.remote ? "stream" : pt.durationMs ? formatTime(pt.durationMs) : ""}
                  </span>
                </div>
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
