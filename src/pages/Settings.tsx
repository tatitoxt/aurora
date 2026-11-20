import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { THEMES } from "../themes";
import {
  bridge,
  DEFAULT_SETTINGS,
  type DisplayInfo,
  type LicenseState,
  type Settings,
} from "../bridge";

export default function Settings() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [license, setLicense] = useState<LicenseState>({ state: "unlicensed" });
  const [key, setKey] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([bridge.getSettings(), bridge.listDisplays(), bridge.getLicenseState()]).then(
      ([st, ds, lic]) => {
        setS(st);
        setDisplays(ds);
        setLicense(lic);
        setLoaded(true);
      },
    );
  }, []);

  const save = (next: Settings) => {
    setS(next);
    void bridge.updateSettings(next);
  };
  const patch = (p: Partial<Settings>) => save({ ...s, ...p });

  const toggleDisplay = (id: string) => {
    const rules = [...s.displays];
    const i = rules.findIndex((r) => r.displayId === id);
    if (i >= 0) rules[i] = { ...rules[i], enabled: !rules[i].enabled };
    else rules.push({ displayId: id, enabled: false });
    patch({ displays: rules });
  };
  const displayEnabled = (id: string) =>
    s.displays.find((r) => r.displayId === id)?.enabled ?? true;

  if (!loaded) return <div className="glass" />;

  return (
    <div className="glass">
      <div className="settings">
        <div className="row">
          <h1>{bridge.productName} settings</h1>
          <Link to="/" className="wordmark" style={{ textDecoration: "none" }}>
            Back
          </Link>
        </div>

        <div className="field">
          <span>Edge thickness — {s.edgeThicknessPx}px</span>
          <input
            type="range" min={8} max={64} value={s.edgeThicknessPx}
            onChange={(e) => patch({ edgeThicknessPx: +e.target.value })}
          />
        </div>
        <div className="field">
          <span>Glow — {Math.round(s.glowStrength * 100)}%</span>
          <input
            type="range" min={0} max={100} value={s.glowStrength * 100}
            onChange={(e) => patch({ glowStrength: +e.target.value / 100 })}
          />
        </div>
        <div className="field">
          <span>Brightness — {Math.round(s.brightness * 100)}%</span>
          <input
            type="range" min={0} max={100} value={s.brightness * 100}
            onChange={(e) => patch({ brightness: +e.target.value / 100 })}
          />
        </div>

        <div className="row">
          <span>Colors</span>
          <div className="seg">
            <button
              className={s.colorMode.mode === "artwork" ? "on" : ""}
              onClick={() => patch({ colorMode: { mode: "artwork" } })}
            >
              Artwork
            </button>
            <button
              className={s.colorMode.mode === "custom" ? "on" : ""}
              onClick={() => patch({ colorMode: { mode: "custom" } })}
            >
              Custom
            </button>
          </div>
        </div>
        {s.colorMode.mode === "custom" && (
          <div className="field">
            <span>Custom color</span>
            <input
              type="color" value={s.customColor}
              onChange={(e) => patch({ customColor: e.target.value })}
            />
          </div>
        )}

        <div className="field">
          <span>Theme</span>
          <div className="seg">
            {THEMES.map((th) => (
              <button
                key={th.name}
                className={s.theme.name === th.name ? "on" : ""}
                onClick={() => patch({ theme: { ...s.theme, name: th.name } })}
              >
                {th.label}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <div className="field">
            <span>Accent</span>
            <input
              type="color"
              value={s.theme.accent ?? "#8b5cf6"}
              onChange={(e) => patch({ theme: { ...s.theme, accent: e.target.value } })}
            />
          </div>
          <div className="field">
            <span>Accent 2</span>
            <input
              type="color"
              value={s.theme.accent2 ?? "#22d3ee"}
              onChange={(e) => patch({ theme: { ...s.theme, accent2: e.target.value } })}
            />
          </div>
        </div>

        <div className="field">
          <span>Music folder</span>
          <input
            type="text"
            placeholder="~/Music"
            value={s.musicDir ?? ""}
            onChange={(e) => patch({ musicDir: e.target.value || null })}
          />
        </div>

        <div className="field">
          <span>yt-dlp path (streaming)</span>
          <input
            type="text"
            placeholder="/usr/local/bin/yt-dlp"
            value={s.ytdlpPath ?? ""}
            onChange={(e) => patch({ ytdlpPath: e.target.value || null })}
          />
        </div>

        <div className="row">
          <span>Battery saver (static glow)</span>
          <button
            className={`toggle ${s.batterySaver ? "on" : ""}`}
            aria-label="Battery saver"
            onClick={() => patch({ batterySaver: !s.batterySaver })}
          />
        </div>
        <div className="row">
          <span>Floating HUD</span>
          <button
            className={`toggle ${s.hudEnabled ? "on" : ""}`}
            aria-label="Floating HUD"
            onClick={() => patch({ hudEnabled: !s.hudEnabled })}
          />
        </div>
        <div className="row">
          <span>Keep HUD on top</span>
          <button
            className={`toggle ${s.hudAlwaysOnTop ? "on" : ""}`}
            aria-label="Keep HUD on top"
            onClick={() => patch({ hudAlwaysOnTop: !s.hudAlwaysOnTop })}
          />
        </div>
        <div className="row">
          <span>Hide while fullscreen</span>
          <button
            className={`toggle ${s.hideInFullscreen ? "on" : ""}`}
            aria-label="Hide in fullscreen"
            onClick={() => patch({ hideInFullscreen: !s.hideInFullscreen })}
          />
        </div>

        {displays.length > 0 && (
          <div className="field">
            <span>Displays</span>
            {displays.map((d) => (
              <div className="row" key={d.id}>
                <span>
                  {d.name}
                  {d.primary ? " (primary)" : ""}
                </span>
                <button
                  className={`toggle ${displayEnabled(d.id) ? "on" : ""}`}
                  aria-label={`Toggle ${d.name}`}
                  onClick={() => toggleDisplay(d.id)}
                />
              </div>
            ))}
          </div>
        )}

        <div className="field">
          <span>License</span>
          {license.state === "valid" && (
            <span className="license-ok">
              Licensed{license.customer_email ? ` to ${license.customer_email}` : ""}
            </span>
          )}
          {license.state === "offline" && <span className="license-ok">Licensed (offline grace)</span>}
          {license.state === "invalid" && <span className="license-bad">{license.reason}</span>}
          {license.state !== "valid" && license.state !== "offline" && (
            <>
              <input
                type="text" placeholder="License key" value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <div className="seg">
                <button
                  disabled={!key.trim()}
                  onClick={() => bridge.activateLicense(key.trim()).then(setLicense)}
                >
                  Activate
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
