import { useT } from "../../i18n";
import {
  bridge,
  type PlaylistFile,
  type PlayRecord,
  type QueueState,
  type Stats,
} from "../../bridge";
import { Art, GenCover } from "./bits";
import { Heart, Play, User } from "@phosphor-icons/react";
import type { FavEntry } from "../../favs";
import type { View } from "./types";

export type JumpTile = {
  key: string;
  name: string;
  icon: React.ReactNode;
  art?: string;
  onClick: () => void;
};

/** Home: greeting + jump-back tiles, then Recently played, Up next,
    Liked, Top tracks, Top artists and Playlists sections — Spotify's
    home layout. */
export default function HomeView({
  greet,
  jumpTiles,
  recent,
  playRecent,
  recArt,
  queue,
  liked,
  playLiked,
  stats,
  playExternal,
  playlists,
  openPlaylist,
  plArts,
  playPlaylist,
  go,
}: {
  greet: string;
  jumpTiles: JumpTile[];
  recent: PlayRecord[];
  playRecent: (r: PlayRecord) => void;
  recArt: (r: PlayRecord) => string | undefined;
  queue: QueueState;
  liked: FavEntry[];
  playLiked: (e: FavEntry) => void;
  stats: Stats | null;
  playExternal: (query: string) => void;
  playlists: PlaylistFile[];
  openPlaylist: (p: PlaylistFile) => void;
  plArts: Record<string, string>;
  playPlaylist: (p: PlaylistFile) => void;
  go: (v: View) => void;
}) {
  const t = useT();
  return (
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
);
}
