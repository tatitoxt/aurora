import { Fragment } from "react";
import { useT } from "../../i18n";
import { Art } from "./bits";
import { Play } from "@phosphor-icons/react";
import type { PlayRecord } from "../../bridge";

/** Recently played grid, grouped by day (Today / Yesterday / date). */
export default function RecentView({
  empty,
  recGroups,
  playRecent,
  recArt,
}: {
  empty: boolean;
  recGroups: { label: string; rows: PlayRecord[] }[];
  playRecent: (r: PlayRecord) => void;
  recArt: (r: PlayRecord) => string | undefined;
}) {
  const t = useT();
  return (
<section className="brw__section">
  {empty && (
    <span className="brw__empty">{t("brw.noTracks")}</span>
  )}
  {recGroups.map((g) => (
    <Fragment key={g.label}>
      {recGroups.length > 1 && (
        <span className="brw__kick brw__qsection">{g.label}</span>
      )}
      <div className="brw__grid">
        {g.rows.map((r) => (
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
    </Fragment>
  ))}
</section>
);
}
