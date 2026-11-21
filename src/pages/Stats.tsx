import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { bridge, type Stats } from "../bridge";
import { useT } from "../i18n";

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Wrapped-style listening stats: totals, daily activity, top tracks and
 * artists from the persisted play history. */
export default function Stats() {
  const t = useT();
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    void bridge.getStats().then(setStats);
  }, []);

  const clear = () => {
    void bridge
      .clearHistory()
      .then(() => bridge.getStats())
      .then(setStats);
  };

  if (!stats) return <div className="glass" />;
  const maxMs = Math.max(1, ...stats.days.map((d) => d.ms));

  return (
    <div className="glass">
      <div className="settings">
        <div className="pagehead" style={{ padding: "0 0 4px" }}>
          <div className="pagehead__top">
            <span className="art__kicker">{t("stats.insights")}</span>
            <span className="pagehead__links">
              <Link to="/wrapped" className="pagehead__link">
                {t("stats.recap")}
              </Link>
              <Link to="/" className="pagehead__link">
                {t("nav.back")}
              </Link>
            </span>
          </div>
          <h1 className="pagehead__name">{t("stats.title")}</h1>
        </div>

        {stats.plays === 0 ? (
          <div className="field">
            <span>No plays yet · a track counts after 30 s of listening</span>
          </div>
        ) : (
          <>
            <div className="stat-cards">
              <div className="stat-card">
                <em>{fmtDur(stats.totalMs)}</em>
                <span>listened</span>
              </div>
              <div className="stat-card">
                <em>{stats.plays}</em>
                <span>plays</span>
              </div>
              <div className="stat-card">
                <em>{stats.topArtists[0]?.name ?? "-"}</em>
                <span>top artist</span>
              </div>
            </div>

            <div className="panel">
              <span>Last 14 days</span>
              <div className="days">
                {stats.days.map((d) => (
                  <div
                    key={d.date}
                    className={`days__bar ${d.ms === maxMs ? "days__bar--max" : ""}`}
                    title={`${d.date} · ${d.plays} plays · ${fmtDur(d.ms)}`}
                    style={{ height: `${Math.max(6, (d.ms / maxMs) * 100)}%` }}
                  />
                ))}
              </div>
            </div>

            <div className="panel">
              <span>{t("stats.topTracks")}</span>
              <div className="tops">
                {stats.topTracks.map((t, i) => (
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
              <span>{t("stats.topArtists")}</span>
              <div className="tops">
                {stats.topArtists.map((a, i) => (
                  <div className="tops__row" key={`${a.name}-${i}`}>
                    <em>{i + 1}</em>
                    <div className="tops__meta">
                      <Link to={`/artist/${encodeURIComponent(a.name)}`} className="tops__link">
                        <b>{a.name}</b>
                      </Link>
                    </div>
                    <span className="tops__n">
                      {a.plays}× · {fmtDur(a.ms)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <button className="stats__clear" onClick={clear}>
              Clear history
            </button>
          </>
        )}
      </div>
    </div>
  );
}
