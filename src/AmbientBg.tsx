/** Liquid ambient backdrop: three oversized gradient blobs tinted by the
 * theme accents (artwork-driven when dynamic accents are on) drifting
 * slowly behind the player surfaces. Transform-only animation stays on the
 * compositor — near-zero CPU and no extra RAM; prefers-reduced-motion
 * freezes the drift into a static wash; so does pausing (no repaints idle). */
export default function AmbientBg({ playing = true }: { playing?: boolean }) {
  return (
    <div className={playing ? "amb" : "amb amb--still"} aria-hidden="true">
      <span className="amb__b amb__b1" />
      <span className="amb__b amb__b2" />
      <span className="amb__b amb__b3" />
    </div>
  );
}
