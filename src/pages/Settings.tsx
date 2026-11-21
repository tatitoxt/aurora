import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { THEMES, presetVar } from "../themes";
import {
  bridge,
  subscribe,
  DEFAULT_SETTINGS,
  EQ_FREQS,
  EQ_PRESETS,
  type DisplayInfo,
  type LicenseState,
  type Settings,
} from "../bridge";

export default function Settings() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [outputs, setOutputs] = useState<string[]>([]);
  const [license, setLicense] = useState<LicenseState>({ state: "unlicensed" });
  const [key, setKey] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      bridge.getSettings(),
      bridge.listDisplays(),
      bridge.getLicenseState(),
      bridge.listOutputs(),
    ]).then(([st, ds, lic, outs]) => {
      setS(st);
      setDisplays(ds);
      setLicense(lic);
      setOutputs(outs);
      setLoaded(true);
    });
  }, []);

  // Other surfaces (palette, tray, HUD pin) also save settings — keep the
  // form's copy current or the next save would silently undo them. Each
  // updateSettings echoes a `settings` event back, so echoes of our own
  // saves are skipped: an older save's echo arriving mid-typing would
  // revert newer characters.
  const ownSaves = useRef<Settings[]>([]);
  useEffect(
    () =>
      subscribe<Settings>("settings", (inc) => {
        const i = ownSaves.current.findIndex(
          (o) => JSON.stringify(o) === JSON.stringify(inc),
        );
        if (i >= 0) {
          ownSaves.current.splice(i, 1);
          return;
        }
        setS(inc);
      }),
    [],
  );

  const save = (next: Settings) => {
    setS(next);
    ownSaves.current.push(next);
    if (ownSaves.current.length > 20) ownSaves.current.shift();
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
          <span>Edge thickness · {s.edgeThicknessPx}px</span>
          <input
            type="range" min={8} max={64} value={s.edgeThicknessPx}
            onChange={(e) => patch({ edgeThicknessPx: +e.target.value })}
          />
        </div>
        <div className="field">
          <span>Glow · {Math.round(s.glowStrength * 100)}%</span>
          <input
            type="range" min={0} max={100} value={s.glowStrength * 100}
            onChange={(e) => patch({ glowStrength: +e.target.value / 100 })}
          />
        </div>
        <div className="field">
          <span>Brightness · {Math.round(s.brightness * 100)}%</span>
          <input
            type="range" min={0} max={100} value={s.brightness * 100}
            onChange={(e) => patch({ brightness: +e.target.value / 100 })}
          />
        </div>

        <div className="row">
          <span>Lyrics</span>
          <div className="seg">
            <button
              className={s.lyricsMode === "lines" ? "on" : ""}
              onClick={() => patch({ lyricsMode: "lines" })}
            >
              Lines
            </button>
            <button
              className={s.lyricsMode === "karaoke" ? "on" : ""}
              onClick={() => patch({ lyricsMode: "karaoke" })}
            >
              Karaoke
            </button>
          </div>
        </div>

        {s.lyricsMode === "karaoke" && (
          <div className="row">
            <span>Music video backdrop</span>
            <button
              className={`toggle ${s.videoBackdrop ? "on" : ""}`}
              aria-label="Music video backdrop"
              onClick={() => patch({ videoBackdrop: !s.videoBackdrop })}
            />
          </div>
        )}

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
              value={s.theme.accent ?? presetVar(s.theme.name, "--accent")}
              onChange={(e) => patch({ theme: { ...s.theme, accent: e.target.value } })}
            />
          </div>
          <div className="field">
            <span>Accent 2</span>
            <input
              type="color"
              value={s.theme.accent2 ?? presetVar(s.theme.name, "--accent2")}
              onChange={(e) => patch({ theme: { ...s.theme, accent2: e.target.value } })}
            />
          </div>
        </div>

        <div className="field">
          <span>Equalizer</span>
          <div className="seg">
            {[...Object.keys(EQ_PRESETS), "custom"].map((p) => (
              <button
                key={p}
                className={s.eqPreset === p ? "on" : ""}
                onClick={() => {
                  if (p === "custom") return;
                  const bands = EQ_PRESETS[p];
                  setS({ ...s, eqPreset: p, eqBands: bands });
                  void bridge.setEq(p, bands);
                }}
              >
                {p[0].toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
          <div className="eq-bands">
            {EQ_FREQS.map((freq, i) => (
              <label key={freq} className="eq-band">
                <input
                  type="range"
                  min={-18}
                  max={18}
                  step={0.5}
                  value={s.eqBands[i] ?? 0}
                  onChange={(e) => {
                    const bands = EQ_FREQS.map((_, j) =>
                      j === i ? Number(e.target.value) : (s.eqBands[j] ?? 0),
                    );
                    setS({ ...s, eqPreset: "custom", eqBands: bands });
                    void bridge.setEq("custom", bands);
                  }}
                />
                <span>{freq >= 1000 ? `${freq / 1000}k` : freq}</span>
                <em>{(s.eqBands[i] ?? 0).toFixed(1)}</em>
              </label>
            ))}
          </div>
        </div>

        {outputs.length > 0 && (
          <div className="field">
            <span>Audio output</span>
            <select
              value={s.audioOutput ?? ""}
              onChange={(e) => {
                const name = e.target.value || null;
                setS({ ...s, audioOutput: name });
                void bridge.setOutputDevice(name);
              }}
            >
              <option value="">System default</option>
              {outputs.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
        )}

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
          <span>Desktop lyrics overlay</span>
          <button
            className={`toggle ${s.deskLyricsEnabled ? "on" : ""}`}
            aria-label="Desktop lyrics overlay"
            onClick={() => patch({ deskLyricsEnabled: !s.deskLyricsEnabled })}
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
