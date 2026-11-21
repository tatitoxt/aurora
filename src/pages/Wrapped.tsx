import { useT } from "../i18n";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { bridge, type Wrapped } from "../bridge";
import { monthLabel, wrappedModel } from "../wrapped";
import { ellipsize } from "../share";

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Monthly recap poster: hero numbers plus top-5 tracks and artists for
 * the current calendar month. */
export default function WrappedPage() {
  const t = useT();
  const [wrapped, setWrapped] = useState<Wrapped | null>(null);

  useEffect(() => {
    void bridge.getWrapped().then(setWrapped);
  }, []);

  if (!wrapped) return <div className="glass" />;
  const m = wrappedModel(wrapped);

  return (
    <div className="glass">
      <div className="settings">
        <div className="pagehead" style={{ padding: "0 0 4px" }}>
          <div className="pagehead__top">
            <span className="art__kicker">Recap</span>
            <span className="pagehead__links">
              <Link to="/stats" className="pagehead__link">
                Stats
              </Link>
            </span>
          </div>
          <h1 className="pagehead__name">{m.headline}</h1>
        </div>

        {wrapped.plays === 0 ? (
          <div className="field">
            <span>
              Nothing heard in {monthLabel(wrapped.month)} · a track counts
              after 30 s
            </span>
          </div>
        ) : (
          <>
            <div className="wrapped__hero">
              <em>{m.minutes}</em>
              <span>
                {m.plays} · {m.unique}
              </span>
            </div>

            <div className="stat-cards">
              <div className="stat-card">
                <em>{m.streak}</em>
                <span>listening streak</span>
              </div>
              <div className="stat-card">
                <em title={wrapped.topTracks[0]?.name}>
                  {ellipsize(m.topTrack.split(" · ")[0], 18)}
                </em>
                <span>top track</span>
              </div>
              <div className="stat-card">
                <em title={wrapped.topArtists[0]?.name}>
                  {ellipsize(m.topArtist, 18)}
                </em>
                <span>top artist</span>
              </div>
            </div>

            <div className="panel">
              <span>{t("wrapped.topTracks")}</span>
              <div className="tops">
                {wrapped.topTracks.map((t, i) => (
                  <div className="tops__row" key={`${t.name}-${i}`}>
                    <em>{i + 1}</em>
                    <div className="tops__meta">
                      <b>{t.name}</b>
                      <span>{t.sub}</span>
                    </div>
                    <span className="tops__n">
                      {t.plays}× · {fmtDur(t.ms)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="panel">
              <span>{t("wrapped.topArtists")}</span>
              <div className="tops">
                {wrapped.topArtists.map((a, i) => (
                  <div className="tops__row" key={`${a.name}-${i}`}>
                    <em>{i + 1}</em>
                    <div className="tops__meta">
                      <b>{a.name}</b>
                    </div>
                    <span className="tops__n">
                      {a.plays}× · {fmtDur(a.ms)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {wrapped.bestDay && (
              <div className="field">
                <span>Best day: {m.bestDay}</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
