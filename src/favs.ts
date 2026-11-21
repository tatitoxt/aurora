import type { NowPlaying, QueueItem, RemoteTrack } from "./bridge";

/** A liked track, with enough metadata to list it and replay it later. */
export interface FavEntry {
  /** Stable identity: `${npSource}:${track.id}` — matches the heart state. */
  key: string;
  /** `track.id` — a local path, or `provider:id` for streamed tracks. */
  trackId: string;
  title: string;
  artist: string;
  artworkUrl: string;
  durationMs: number;
}

const KEY = "noctbeat.favs";
/** Storage events don't fire in the document that wrote — sync via this. */
export const FAVS_EVENT = "noctbeat:favs";

export function loadFavs(): FavEntry[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((v): FavEntry[] => {
      if (typeof v === "string") {
        // Legacy entries stored bare keys: keep the heart state alive, but
        // without metadata the Liked view can't list them.
        return [{ key: v, trackId: "", title: "", artist: "", artworkUrl: "", durationMs: 0 }];
      }
      if (v !== null && typeof v === "object" && typeof (v as FavEntry).key === "string") {
        const e = v as Partial<FavEntry>;
        return [
          {
            key: e.key as string,
            trackId: typeof e.trackId === "string" ? e.trackId : "",
            title: typeof e.title === "string" ? e.title : "",
            artist: typeof e.artist === "string" ? e.artist : "",
            artworkUrl: typeof e.artworkUrl === "string" ? e.artworkUrl : "",
            durationMs: typeof e.durationMs === "number" ? e.durationMs : 0,
          },
        ];
      }
      return [];
    });
  } catch {
    return [];
  }
}

export function favKeys(entries: FavEntry[]): Set<string> {
  return new Set(entries.map((e) => e.key));
}

/** Heart key for the track playing in `np`; "" when nothing is playing. */
export function favKeyFor(np: NowPlaying | null): string {
  const id = np?.track?.id;
  return id ? `${np?.source ?? ""}:${id}` : "";
}

/** Fav entry for the track playing in `np`; null when nothing is playing. */
export function favEntryFor(np: NowPlaying | null): FavEntry | null {
  const t = np?.track;
  const key = favKeyFor(np);
  if (!t || !key) return null;
  return {
    key,
    trackId: t.id,
    title: t.title,
    artist: t.artist,
    artworkUrl: t.artworkUrl ?? "",
    durationMs: t.durationMs,
  };
}

/** Add `entry` or remove it when present; persists and emits FAVS_EVENT. */
export function toggleFav(entries: FavEntry[], entry: FavEntry): FavEntry[] {
  const next = entries.some((e) => e.key === entry.key)
    ? entries.filter((e) => e.key !== entry.key)
    : [entry, ...entries];
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Quota exceeded — the in-memory state still updates this session.
  }
  window.dispatchEvent(new Event(FAVS_EVENT));
  return next;
}

/** Entries the Liked view can list and replay (legacy keys are skipped). */
export function listable(entries: FavEntry[]): FavEntry[] {
  return entries.filter((e) => e.trackId !== "");
}

const PROVIDER_ID = /^(youtube|soundcloud):(.+)$/;

/** `track.id` of a streamed track is `provider:id`; local files use paths. */
export function remoteParts(trackId: string): { source: string; id: string } | null {
  const m = PROVIDER_ID.exec(trackId);
  return m ? { source: m[1], id: m[2] } : null;
}

/** Rebuild a RemoteTrack for replaying a liked stream (id → provider URL). */
export function toRemoteTrack(e: FavEntry): RemoteTrack | null {
  const p = remoteParts(e.trackId);
  if (!p) return null;
  const url =
    p.source === "soundcloud"
      ? // Numeric ids aren't permalink paths; yt-dlp resolves the API form.
        /^\d+$/.test(p.id)
        ? `https://api.soundcloud.com/tracks/${p.id}`
        : `https://soundcloud.com/${p.id}`
      : `https://www.youtube.com/watch?v=${p.id}`;
  return {
    id: p.id,
    source: p.source,
    title: e.title,
    artist: e.artist,
    durationMs: e.durationMs,
    url,
    artworkUrl: e.artworkUrl,
  };
}

/** Local files store their path as `track.id` — replay straight from it. */
export function toQueueItem(e: FavEntry): QueueItem {
  return {
    track: {
      id: e.trackId,
      title: e.title,
      artist: e.artist,
      album: "",
      artworkUrl: e.artworkUrl,
      durationMs: e.durationMs,
    },
    path: e.trackId,
  };
}
