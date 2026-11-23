import { useEffect, useState } from "react";
import { artSrc, bridge, subscribe, type NowPlaying } from "./bridge";

/** Blurred now-playing artwork behind a page, so secondary views sit on the
 * song's colors (iBaila-style) instead of a flat grey panel. One static
 * image; the blur is composited once, so it costs no per-frame CPU. */
export default function ArtBackdrop({ src: fixed }: { src?: string } = {}) {
  const [url, setUrl] = useState<string | undefined>();
  const [src, setSrc] = useState("");
  useEffect(() => {
    void bridge.getNowPlaying().then((np) => setUrl(np?.track?.artworkUrl));
    return subscribe<NowPlaying>("now-playing", (np) => setUrl(np?.track?.artworkUrl));
  }, []);
  useEffect(() => {
    if (!url) return setSrc("");
    let live = true;
    void artSrc(url).then((s) => live && setSrc(s));
    return () => {
      live = false;
    };
  }, [url]);
  const shown = fixed || src;
  return (
    <div className="artbg" aria-hidden="true">
      {shown && <img src={shown} alt="" />}
    </div>
  );
}
