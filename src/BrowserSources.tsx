import { useEffect, useState } from "react";
import { AmazonLogo, AppleLogo, ArrowUpRight, SpotifyLogo, SoundcloudLogo, TidalLogo, YoutubeLogo } from "@phosphor-icons/react";
import { bridge } from "./bridge";
import { useT } from "./i18n";

const services = [
  { name: "Spotify", url: "https://open.spotify.com", host: "open.spotify.com", icon: SpotifyLogo },
  { name: "Apple Music", url: "https://music.apple.com", host: "music.apple.com", icon: AppleLogo },
  { name: "YouTube Music", url: "https://music.youtube.com", host: "music.youtube.com", icon: YoutubeLogo },
  { name: "SoundCloud", url: "https://soundcloud.com", host: "soundcloud.com", icon: SoundcloudLogo },
  { name: "Tidal", url: "https://listen.tidal.com", host: "listen.tidal.com", icon: TidalLogo },
  { name: "Amazon Music", url: "https://music.amazon.com", host: "music.amazon.", icon: AmazonLogo },
];

/** Service accounts and playlists stay in their own tabs. The extension
 * reports the active song and routes transport commands back to that tab. */
export default function BrowserSources({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const native = bridge.isTauri();
  const [status, setStatus] = useState<{ tabs: number; provider: string | null } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!native) return;
    let live = true;
    const refresh = () => {
      void bridge.getExtStatus().then((next) => { if (live) setStatus(next); }).catch(() => {
        if (live) setStatus(null);
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { live = false; window.clearInterval(timer); };
  }, [native]);
  const connected = status !== null && status.tabs > 0;
  return (
    <div className={`sources ${compact ? "sources--compact" : ""}`}>
      <div className="sources__heading">
        <h2>{t("sources.heading")}</h2>
        <span className="sources__status" role="status">
          {connected && <i className="srcdot" />}
          {native ? t(connected ? "sources.live" : "sources.waiting") : t("sources.demo")}
        </span>
      </div>
      <div className="sources__grid">
        {services.map((service) => {
          const active = connected && status.provider?.startsWith(service.host);
          return (
            <button
              key={service.name}
              className={`sources__service ${active ? "sources__service--active" : ""}`}
              title={t("sources.open", { name: service.name })}
              onClick={() => {
                setError("");
                void bridge.openUrl(service.url).catch((err) => setError(String(err)));
              }}
            >
              <service.icon size={22} weight="fill" />
              <span>{service.name}</span>
              {active ? <i className="srcdot" /> : <ArrowUpRight size={14} />}
            </button>
          );
        })}
      </div>
      {!compact && <p className="note">{t("sources.playlists")}</p>}
      <details className="sources__setup">
        <summary>{t("sources.setup")}</summary>
        <p>{t("fs.extHint")}</p>
        <p>{t("fs.extStep1")}</p>
        <p>{t("fs.extStep2")}</p>
        {native ? (
          <button className="pagehead__link" onClick={() => {
            setError("");
            void bridge.openExtensionFolder().catch((err) => setError(String(err)));
          }}>{t("sources.folder")}</button>
        ) : (
          <a href="noctbeat-bridge.zip" download className="pagehead__link">{t("fs.extDownload")}</a>
        )}
      </details>
      {error && <p className="license-bad" role="alert">{error}</p>}
    </div>
  );
}
