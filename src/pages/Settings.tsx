import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { branding } from "../branding";
import { LANG_NAMES, useT, type MsgKey } from "../i18n";
import { LYRIC_ANIMS } from "../lyricanim";
import { THEMES, presetVar } from "../themes";
import {
  bridge,
  subscribe,
  DEFAULT_SETTINGS,
  EQ_FREQS,
  EQ_PRESETS,
  type LicenseState,
  type ListenStatus,
  type NowPlaying,
  type Settings,
} from "../bridge";

export default function Settings() {
  const t = useT();
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [outputs, setOutputs] = useState<string[]>([]);
  const [license, setLicense] = useState<LicenseState>({ state: "unlicensed" });
  const [key, setKey] = useState("");
  const [activating, setActivating] = useState(false);
  const activate = () => {
    if (activating || !key.trim()) return;
    setActivating(true);
    bridge.activateLicense(key.trim())
      .then(setLicense)
      .finally(() => setActivating(false));
  };
  const [profileName, setProfileName] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [lst, setLst] = useState<ListenStatus | null>(null);
  const [joinAddr, setJoinAddr] = useState("");
  const [joinErr, setJoinErr] = useState("");

  useEffect(() => {
    void bridge.getNowPlaying().then(setNp).catch(() => {});
    return subscribe<NowPlaying>("now-playing", setNp);
  }, []);

  useEffect(() => {
    void bridge.listenStatus().then(setLst).catch(() => {});
    return subscribe<ListenStatus>("listen", setLst);
  }, []);

  const joinSession = () => {
    const addr = joinAddr.trim();
    if (!addr) return;
    setJoinErr("");
    bridge.listenJoin(addr).then(setLst).catch((e) => setJoinErr(String(e?.message ?? e)));
  };

  useEffect(() => {
    Promise.all([
      bridge.getSettings(),
      bridge.getLicenseState(),
      bridge.listOutputs(),
    ]).then(([st, lic, outs]) => {
      setS(st);
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

  const saveAsProfile = () => {
    const name = profileName.trim();
    if (!name) return;
    setProfileName("");
    void bridge.saveProfile(name);
  };

  if (!loaded) return <div className="glass" />;

  return (
    <div className="glass">
      <div className="settings">
        <div className="pagehead" style={{ padding: "0 0 4px" }}>
          <div className="pagehead__top">
            <span className="art__kicker">Control</span>
            <span className="pagehead__links">
              <Link to="/" className="pagehead__link">
                {t("nav.back")}
              </Link>
            </span>
          </div>
          <h1 className="pagehead__name">{t("set.title")}</h1>
        </div>

        <div className="row">
          <span>{t("set.lyrics")}</span>
          <div className="seg">
            <button
              className={s.lyricsMode === "lines" ? "on" : ""}
              onClick={() => patch({ lyricsMode: "lines" })}
            >
              {t("set.lines")}
            </button>
            <button
              className={s.lyricsMode === "karaoke" ? "on" : ""}
              onClick={() => patch({ lyricsMode: "karaoke" })}
            >
              {t("set.karaoke")}
            </button>
          </div>
        </div>

        {s.lyricsMode === "karaoke" && (
          <div className="row">
            <span>{t("set.lyricAnim")}</span>
            <select
              value={s.lyricAnim}
              onChange={(e) => patch({ lyricAnim: e.target.value })}
            >
              {LYRIC_ANIMS.map((a) => (
                <option key={a} value={a}>
                  {t(`anim.${a}` as MsgKey)}
                </option>
              ))}
            </select>
          </div>
        )}

        {s.lyricsMode === "karaoke" && (
          <div className="row">
            <span>{t("set.videoBackdrop")}</span>
            <button
              className={`toggle ${s.videoBackdrop ? "on" : ""}`}
              aria-label="Music video backdrop"
              onClick={() => patch({ videoBackdrop: !s.videoBackdrop })}
            />
          </div>
        )}

        <div className="field">
          <span>{t("set.theme")}</span>
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
            <span>{t("set.accent")}</span>
            <input
              type="color"
              value={s.theme.accent ?? presetVar(s.theme.name, "--accent")}
              onChange={(e) => patch({ theme: { ...s.theme, accent: e.target.value } })}
            />
          </div>
          <div className="field">
            <span>{t("set.accent2")}</span>
            <input
              type="color"
              value={s.theme.accent2 ?? presetVar(s.theme.name, "--accent2")}
              onChange={(e) => patch({ theme: { ...s.theme, accent2: e.target.value } })}
            />
          </div>
        </div>

        <div className="field">
          <span>{t("set.eq")}</span>
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

        <div className="field">
          <span>{t("set.profiles")}</span>
          {s.profiles.length > 0 && (
            <div className="profiles">
              {s.profiles.map((p) => (
                <div
                  key={p.id}
                  className={`profile ${s.activeProfile === p.id ? "on" : ""}`}
                >
                  <button
                    className="profile__name"
                    title={`${p.theme.name} · ${p.eqPreset}`}
                    onClick={() => void bridge.applyProfile(p.id)}
                  >
                    {p.name}
                  </button>
                  <button
                    className="profile__del"
                    aria-label={`${t("set.deleteProfile")} ${p.name}`}
                    onClick={() => void bridge.deleteProfile(p.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="profile__save">
            <input
              type="text"
              placeholder={t("set.profileName")}
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveAsProfile()}
            />
            <button disabled={!profileName.trim()} onClick={saveAsProfile}>
              {t("set.saveCurrent")}
            </button>
          </div>
          {s.profiles.length === 0 && (
            <span className="share__note">
              {t("set.profilesNote")}
            </span>
          )}
        </div>

        {outputs.length > 0 && (
          <div className="field">
            <span>{t("set.audioOutput")}</span>
            <select
              value={s.audioOutput ?? ""}
              onChange={(e) => {
                const name = e.target.value || null;
                setS({ ...s, audioOutput: name });
                void bridge.setOutputDevice(name);
              }}
            >
              <option value="">{t("set.systemDefault")}</option>
              {outputs.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="field">
          <span>
            Crossfade · {s.crossfadeMs > 0 ? `${(s.crossfadeMs / 1000).toFixed(1)}s` : t("set.off")}
          </span>
          <input
            type="range" min={0} max={12000} step={500} value={s.crossfadeMs}
            onChange={(e) => patch({ crossfadeMs: +e.target.value })}
          />
        </div>

        <div className="field">
          <span>{t("set.sleepTimer")}</span>
          <select
            value={s.sleepTimerEndsMs === null ? "" : "armed"}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "armed") return;
              void bridge.setSleepTimer(v === "" ? null : Number(v));
            }}
          >
            <option value="">{t("set.off")}</option>
            {s.sleepTimerEndsMs !== null && <option value="armed">{t("set.armed")}</option>}
            <option value="15">{t("set.minutes15")}</option>
            <option value="30">{t("set.minutes30")}</option>
            <option value="45">{t("set.minutes45")}</option>
            <option value="60">{t("set.minutes60")}</option>
            <option value="90">{t("set.minutes90")}</option>
          </select>
          {s.sleepTimerEndsMs !== null && (
            <span className="share__note">
              {t("set.pausesAt")} {new Date(s.sleepTimerEndsMs).toLocaleTimeString()}
            </span>
          )}
        </div>
        <div className="row">
          <span>{t("set.resumeOnLaunch")}</span>
          <button
            className={`toggle ${s.resumeOnLaunch ? "on" : ""}`}
            aria-label="Resume playback on launch"
            onClick={() => patch({ resumeOnLaunch: !s.resumeOnLaunch })}
          />
        </div>
        <div className="row">
          <span>{t("set.notifyTrack")}</span>
          <button
            className={`toggle ${s.notifyTrackChange ? "on" : ""}`}
            aria-label="Notify when the track changes"
            onClick={() => patch({ notifyTrackChange: !s.notifyTrackChange })}
          />
        </div>
        {branding.discordClientId !== "" && (
          <div className="row">
            <span>{t("set.discordRpc")}</span>
            <button
              className={`toggle ${s.discordRpc ? "on" : ""}`}
              aria-label="Discord Rich Presence"
              onClick={() => patch({ discordRpc: !s.discordRpc })}
            />
          </div>
        )}

        <div className="field">
          <span>{t("set.musicFolder")}</span>
          <input
            type="text"
            placeholder="~/Music"
            value={s.musicDir ?? ""}
            onChange={(e) => patch({ musicDir: e.target.value || null })}
          />
        </div>

        <div className="field">
          <span>{t("set.sources")}</span>
          <span className="share__note">
            {np?.source?.includes(".") ? (
              <>
                <span className="srcdot" /> {t("set.sourceLive")} · {np.source}
              </>
            ) : np?.source === "local" || np?.source === "demo" ? (
              <>{branding.productName} · {np.source}</>
            ) : (
              <>{t("set.sourceSys")}{np?.source ? ` · ${np.source}` : ""}</>
            )}
          </span>
          {!np?.source?.includes(".") && (
            <span className="share__note">{t("set.sourceHint")}</span>
          )}
        </div>

        <div className="field">
          <span>{t("set.listen")}</span>
          {lst?.hosting ? (
            <>
              <span className="share__note">
                <span className="srcdot" /> {t("set.listenHosting")}
                {lst.hostAddr ? ` · ${lst.hostAddr}` : ""}
                {lst.peers > 0 ? ` · ${lst.peers} ${t("set.listenPeers")}` : ""}
              </span>
              <div className="seg">
                <button onClick={() => bridge.listenHostStop().then(setLst)}>
                  {t("set.listenStop")}
                </button>
              </div>
            </>
          ) : lst?.following ? (
            <>
              <span className="share__note">
                <span className="srcdot" /> {t("set.listenFollowing")}
                {lst.hostName ? ` ${lst.hostName}` : ""} · {lst.following}
              </span>
              {lst.missingTrack && (
                <span className="share__note">
                  {t("set.listenMissing")}: {lst.missingTrack}
                </span>
              )}
              {lst.lastError && <span className="share__note">{lst.lastError}</span>}
              <div className="seg">
                <button onClick={() => bridge.listenLeave().then(setLst)}>
                  {t("set.listenLeave")}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="listen__row">
                <input
                  type="text"
                  placeholder={t("set.listenAddrPh")}
                  value={joinAddr}
                  onChange={(e) => setJoinAddr(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && joinSession()}
                />
                <div className="seg">
                  <button disabled={!joinAddr.trim()} onClick={joinSession}>
                    {t("set.listenJoin")}
                  </button>
                  <button onClick={() => bridge.listenHostStart().then(setLst).catch((e) => setJoinErr(String(e?.message ?? e)))}>
                    {t("set.listenHost")}
                  </button>
                </div>
              </div>
              {joinErr && (
                <span className="share__note">
                  {t("set.listenErr")} — {joinErr}
                </span>
              )}
            </>
          )}
        </div>

        <div className="field">
          <span>{t("set.ytdlpPath")}</span>
          <input
            type="text"
            placeholder="/usr/local/bin/yt-dlp"
            value={s.ytdlpPath ?? ""}
            onChange={(e) => patch({ ytdlpPath: e.target.value || null })}
          />
        </div>

        <div className="row">
          <span>{t("set.liveTrayIcon")}</span>
          <button
            className={`toggle ${s.trayLiveIcon ? "on" : ""}`}
            aria-label="Live tray icon"
            onClick={() => patch({ trayLiveIcon: !s.trayLiveIcon })}
          />
        </div>
        <div className="row">
          <span>{t("set.floatingHud")}</span>
          <button
            className={`toggle ${s.hudEnabled ? "on" : ""}`}
            aria-label="Floating HUD"
            onClick={() => patch({ hudEnabled: !s.hudEnabled })}
          />
        </div>
        <div className="row">
          <span>{t("set.hudOnTop")}</span>
          <button
            className={`toggle ${s.hudAlwaysOnTop ? "on" : ""}`}
            aria-label="Keep HUD on top"
            onClick={() => patch({ hudAlwaysOnTop: !s.hudAlwaysOnTop })}
          />
        </div>
        <div className="row">
          <span>{t("set.desktopLyrics")}</span>
          <button
            className={`toggle ${s.deskLyricsEnabled ? "on" : ""}`}
            aria-label="Desktop lyrics overlay"
            onClick={() => patch({ deskLyricsEnabled: !s.deskLyricsEnabled })}
          />
        </div>

        <div className="row">
          <span>{t("set.language")}</span>
          <select
            value={s.language}
            onChange={(e) => patch({ language: e.target.value })}
          >
            {(Object.keys(LANG_NAMES) as Array<keyof typeof LANG_NAMES>).map((l) => (
              <option key={l} value={l}>{LANG_NAMES[l]}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <span>{t("set.license")}</span>
          {license.state === "valid" && (
            <span className="license-ok">
              {t("set.licensed")}{license.customer_email ? ` ${license.customer_email}` : ""}
            </span>
          )}
          {license.state === "offline" && <span className="license-ok">{t("set.licensedOffline")}</span>}
          {license.state === "invalid" && <span className="license-bad">{license.reason}</span>}
          {license.state !== "valid" && license.state !== "offline" && (
            <>
              <input
                type="text" placeholder={t("set.licenseKey")} value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && activate()}
              />
              <div className="seg">
                <button disabled={!key.trim() || activating} onClick={activate}>
                  {activating ? t("set.activating") : t("set.activate")}
                </button>
                <button onClick={() => bridge.openUrl(branding.checkoutUrl)}>
                  {t("set.buyLicense")}
                </button>
              </div>
            </>
          )}
          {(license.state === "valid" || license.state === "offline") && (
            <div className="seg">
              <button onClick={() => bridge.deactivateLicense().then(setLicense)}>
                {t("set.deactivate")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
