import { useEffect, useState } from "react";
import { bridge, subscribe, type Settings } from "./bridge";

export const LYRIC_ANIMS = ["fade", "slide", "pop", "typewriter", "pulse", "none"] as const;
export type LyricAnim = (typeof LYRIC_ANIMS)[number];

/** Reactive lyric-animation class: `lanim--<preset>` for the karaoke
 * surfaces, or "" for none. Follows the settings event live. */
export function useLyricAnim(): string {
  const [anim, setAnim] = useState("fade");
  useEffect(() => {
    void bridge.getSettings().then((s) => setAnim(s.lyricAnim));
    return subscribe<Settings>("settings", (s) => setAnim(s.lyricAnim));
  }, []);
  return `lanim--${anim}`;
}
