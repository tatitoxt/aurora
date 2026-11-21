import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { bridge, type Stats } from "../bridge";

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
        <div className="row">
          <h1>Listening stats</h1>
          <span>
            <Link to="/wrapped" className="wordmark" style={{ textDecoration: "none" }}>
              Recap
            </Link>
            {" · "}
            <Link to="/" className="wordmark" style={{ textDecoration: "none" }}>
              Back
            </Link>
          </span>
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

            <div className="field">
              <span>Last 14 days</span>
              <div className="days">
                {stats.days.map((d) => (
                  <div
                    key={d.date}
                    className="days__bar"
                    title={`${d.date} · ${d.plays} plays · ${fmtDur(d.ms)}`}
                    style={{ height: `${Math.max(6, (d.ms / maxMs) * 100)}%` }}
                  />
                ))}
              </div>
            </div>

            <div className="field">
              <span>Top tracks</span>
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

            <div className="field">
              <span>Top artists</span>
              <div className="tops">
                {stats.topArtists.map((a, i) => (
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

            <button className="stats__clear" onClick={clear}>
              Clear history
            </button>
          </>
        )}
      </div>
    </div>
  );
}
