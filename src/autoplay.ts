import { useEffect, useState } from "react";
import { bridge, subscribe, type NowPlaying } from "./bridge";

/** Shared autoplay/radio setting. Playback must outlive Browse, so the
 * listener is app-level while the playbar only edits this small store. */
const KEY = "noctbeat-autoplay";
const EVENT = "noctbeat-autoplay-started";

let enabled = localStorage.getItem(KEY) === "1";
let starting = false;
let manualSeekAt = 0;
window.addEventListener("noctbeat-manual-seek", () => {
  manualSeekAt = Date.now();
});
const listeners = new Set<(on: boolean) => void>();

function setEnabled(next: boolean) {
  enabled = next;
  localStorage.setItem(KEY, next ? "1" : "0");
  listeners.forEach((cb) => cb(next));
}

export function useAutoplay(): [boolean, (next: boolean) => void] {
  const [on, setOn] = useState(enabled);
  useEffect(() => {
    const cb = (next: boolean) => setOn(next);
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);
  return [on, setEnabled];
}

function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** App-level radio listener: when a queue naturally runs out, continue
 * with library tracks — same artist first, then the rest shuffled. */
export function useRadioAutoplay(active = true) {
  const [on] = useAutoplay();
  useEffect(() => {
    if (!on || !active) return;
    return subscribe<NowPlaying>("now-playing", (n) => {
      if (n.status !== "stopped" || starting) return;
      const ended = n.track;
      if (!ended) return;
      /* MPRIS Stop also reports `stopped`, but rewinds to zero. Radio is
         only for natural queue exhaustion near the duration. */
      // MPRIS Stop rewinds to zero; any nonzero stopped position is the
      // engine reaching the real end of the media, regardless of whether
      // playlist metadata overstated its duration.
      const naturalEnd = n.positionMs > 1000;
      if (!naturalEnd || Date.now() - manualSeekAt < 1000) return;
      starting = true;
      void bridge
        .libraryTracks()
        .then((items) => {
          if (items.length === 0) return;
          const artist = ended.artist.toLowerCase();
          const sameArtist = items.filter(
            (it) =>
              it.track.artist.toLowerCase() === artist &&
              it.track.title !== ended.title,
          );
          const rest = items.filter(
            (it) =>
              it.track.artist.toLowerCase() !== artist ||
              it.track.title === ended.title,
          );
          const radio = [...shuffled(sameArtist), ...shuffled(rest)].slice(0, 30);
          if (radio.length === 0) return;
          return bridge.playItems(radio, 0).then(() => {
            window.dispatchEvent(new Event(EVENT));
          });
        })
        .catch(() => {})
        .finally(() => {
          starting = false;
        });
    });
  }, [on, active]);
}

export function onAutoplayStarted(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
