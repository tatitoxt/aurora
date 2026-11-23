//! Persisted user settings: JSON file, versioned, corrupt-proof.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::Path;

pub const CURRENT_VERSION: u32 = 1;

fn default_dynamic() -> bool {
    true
}

/// User theme: a preset name plus optional accent overrides applied on top.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSettings {
    pub name: String,
    #[serde(default)]
    pub accent: Option<String>,
    #[serde(default)]
    pub accent2: Option<String>,
    /// Accent colors follow the playing track's artwork palette. Manual
    /// accent/accent2 picks always win over the artwork colors.
    #[serde(default = "default_dynamic")]
    pub dynamic: bool,
}

impl Default for ThemeSettings {
    fn default() -> Self {
        Self {
            name: "noct".into(),
            accent: None,
            accent2: None,
            dynamic: true,
        }
    }
}

/// A named personalization bundle: what one person saved of their look
/// and sound so they can come back to it or share the machine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub theme: ThemeSettings,
    pub eq_preset: String,
    pub eq_bands: Vec<f32>,
    pub lyrics_mode: String,
    pub video_backdrop: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    /// Show the track artwork with a beat/progress ring in the tray icon.
    #[serde(default = "default_true")]
    pub tray_live_icon: bool,
    #[serde(default)]
    pub license_key: Option<String>,
    /// Floating HUD mini-player window.
    #[serde(default = "default_true")]
    pub hud_enabled: bool,
    /// Pin the HUD above other windows; false lets it sink behind them.
    #[serde(default = "default_true")]
    pub hud_always_on_top: bool,
    /// Last on-screen position, restored on launch.
    #[serde(default)]
    pub hud_position: Option<(i32, i32)>,
    /// Folder the local library scans on demand.
    #[serde(default)]
    pub music_dir: Option<String>,
    /// Visual theme preset + accent overrides.
    #[serde(default)]
    pub theme: ThemeSettings,
    /// Lyrics presentation: "lines" (scrolling list) or "karaoke" (word fill).
    #[serde(default = "default_lyrics_mode")]
    pub lyrics_mode: String,
    /// Stage backdrop plays the track's official music video when one is
    /// known (YouTube tab via the Bridge); false keeps the artwork backdrop.
    #[serde(default = "default_true")]
    pub video_backdrop: bool,
    /// Animated "liquid" gradient blobs behind player surfaces, tinted by
    /// the artwork palette; false keeps the static backdrop.
    #[serde(default = "default_true")]
    pub ambient_bg: bool,
    /// Stage draws no backdrop of its own, so the desktop wallpaper shows
    /// through the transparent window (macOS/Windows; Linux stays opaque).
    #[serde(default)]
    pub transparent_bg: bool,
    /// Glass panel opacity 0-100; lower lets more of the desktop show through.
    #[serde(default = "default_glass_opacity")]
    pub glass_opacity: u32,
    /// Audio output device name (e.g. a Bluetooth speaker); None = OS default.
    #[serde(default)]
    pub audio_output: Option<String>,
    /// Crossfade length in ms applied to the natural track advance;
    /// 0 keeps the hard cut between tracks.
    #[serde(default = "default_crossfade")]
    pub crossfade_ms: u64,
    /// Name of the active EQ preset ("flat", "bass", "vocal", "treble",
    /// "custom" when the user moved a slider).
    #[serde(default = "default_eq_preset")]
    pub eq_preset: String,
    /// Per-band gain in dB (5 bands: 60/250/1k/4k/12k Hz). Empty = flat.
    #[serde(default)]
    pub eq_bands: Vec<f32>,
    /// Master sound effect: "off" (default), "reverb", "8d", "echo" —
    /// applied live in the decode chain.
    #[serde(default = "default_sound_fx")]
    pub sound_fx: String,
    /// UI language: "en" | "es" | "pt" | "fr" | "de" | "it" | "ja" | "zh" | "ko".
    #[serde(default = "default_language")]
    pub language: String,
    /// Karaoke lyric animation: "fade" (default), "slide", "pop",
    /// "typewriter", "pulse", "none".
    #[serde(default = "default_lyric_anim")]
    pub lyric_anim: String,
    /// Floating always-on-top desktop lyrics overlay.
    #[serde(default)]
    pub desk_lyrics_enabled: bool,
    /// Last on-screen position of the lyrics overlay, restored on launch.
    #[serde(default)]
    pub desk_lyrics_position: Option<(i32, i32)>,
    /// Saved personalization profiles.
    #[serde(default)]
    pub profiles: Vec<Profile>,
    /// Id of the last applied profile; edits after applying don't
    /// re-save into it (explicit save does).
    #[serde(default)]
    pub active_profile: Option<String>,
    /// Absolute epoch ms when the sleep timer fires and playback pauses.
    /// Persisted so a relaunched app still honors a running timer.
    #[serde(default)]
    pub sleep_timer_ends_ms: Option<u64>,
    /// Restore the last queue paused at the saved position on launch
    /// (the "Continue Playing" state).
    #[serde(default = "default_true")]
    pub resume_on_launch: bool,
    /// Desktop notification when the track changes.
    #[serde(default = "default_true")]
    pub notify_track_change: bool,
    /// Publish now-playing to Discord Rich Presence. Only takes effect
    /// when branding.json carries a real `discordClientId`.
    #[serde(default = "default_true")]
    pub discord_rpc: bool,
}

fn default_sound_fx() -> String {
    "off".into()
}

fn default_language() -> String {
    "en".into()
}

fn default_lyric_anim() -> String {
    "fade".into()
}
fn default_eq_preset() -> String {
    "flat".into()
}

fn default_crossfade() -> u64 {
    3_000
}

fn default_true() -> bool {
    true
}

fn default_glass_opacity() -> u32 {
    68
}

fn default_lyrics_mode() -> String {
    "lines".into()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            tray_live_icon: true,
            license_key: None,
            hud_enabled: true,
            hud_always_on_top: true,
            hud_position: None,
            music_dir: None,
            theme: ThemeSettings::default(),
            lyrics_mode: default_lyrics_mode(),
            video_backdrop: true,
            ambient_bg: true,
            transparent_bg: false,
            glass_opacity: default_glass_opacity(),
            audio_output: None,
            crossfade_ms: default_crossfade(),
            eq_preset: default_eq_preset(),
            eq_bands: Vec::new(),
            sound_fx: default_sound_fx(),
            language: default_language(),
            lyric_anim: default_lyric_anim(),
            desk_lyrics_enabled: false,
            desk_lyrics_position: None,
            profiles: Vec::new(),
            active_profile: None,
            sleep_timer_ends_ms: None,
            resume_on_launch: true,
            notify_track_change: true,
            discord_rpc: true,
        }
    }
}

impl Settings {
    /// Load from `path`. Missing file, unreadable or corrupt JSON all yield
    /// defaults — settings must never crash the app.
    pub fn load(path: &Path) -> Self {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Self::default();
        };
        let Ok(mut s) = serde_json::from_str::<serde_json::Value>(&text) else {
            return Self::default();
        };
        if !s.is_object() {
            return Self::default();
        }
        let version = s.get("version").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        if version < CURRENT_VERSION {
            // Migration path: fill anything missing with defaults.
            let defaults = serde_json::to_value(Self::default()).unwrap();
            merge_missing(&mut s, &defaults);
            s["version"] = serde_json::json!(CURRENT_VERSION);
        }
        serde_json::from_value(s).unwrap_or_default()
    }

    /// Capture the current personalization as a named profile. Same name
    /// overwrites that profile (upsert); returns its id.
    pub fn save_profile(&mut self, name: &str, id_seed: u64) -> String {
        let bundle = |id: String, name: String| Profile {
            id,
            name,
            theme: self.theme.clone(),
            eq_preset: self.eq_preset.clone(),
            eq_bands: self.eq_bands.clone(),
            lyrics_mode: self.lyrics_mode.clone(),
            video_backdrop: self.video_backdrop,
        };
        if let Some(p) = self
            .profiles
            .iter_mut()
            .find(|p| p.name.eq_ignore_ascii_case(name))
        {
            let id = p.id.clone();
            *p = bundle(id.clone(), name.to_string());
            self.active_profile = Some(id.clone());
            return id;
        }
        let id = format!("p{id_seed}");
        self.profiles.push(bundle(id.clone(), name.to_string()));
        self.active_profile = Some(id.clone());
        id
    }

    /// Copy a profile's bundle into the live settings. Returns false for
    /// an unknown id.
    pub fn apply_profile(&mut self, id: &str) -> bool {
        let Some(p) = self.profiles.iter().find(|p| p.id == id).cloned() else {
            return false;
        };
        self.theme = p.theme;
        self.eq_preset = p.eq_preset;
        self.eq_bands = p.eq_bands;
        self.lyrics_mode = p.lyrics_mode;
        self.video_backdrop = p.video_backdrop;
        self.active_profile = Some(id.to_string());
        true
    }

    /// Remove a profile; clears `active_profile` if it pointed at it.
    pub fn delete_profile(&mut self, id: &str) -> bool {
        let before = self.profiles.len();
        self.profiles.retain(|p| p.id != id);
        if self.active_profile.as_deref() == Some(id) {
            self.active_profile = None;
        }
        self.profiles.len() != before
    }

    /// Atomic-ish write: tmp file then rename.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(tmp, path)
    }
}

fn merge_missing(target: &mut serde_json::Value, defaults: &serde_json::Value) {
    if let (Some(t), Some(d)) = (target.as_object_mut(), defaults.as_object()) {
        for (k, v) in d {
            t.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("noctbeat-settings-{}-{}", std::process::id(), name))
    }

    #[test]
    fn missing_file_is_defaults() {
        let s = Settings::load(&tmp("nope.json"));
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn corrupt_file_is_defaults() {
        let p = tmp("corrupt.json");
        std::fs::write(&p, "{not json").unwrap();
        assert_eq!(Settings::load(&p), Settings::default());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn roundtrip() {
        let p = tmp("round.json");
        let s = Settings {
            crossfade_ms: 4000,
            license_key: Some("K".into()),
            ..Default::default()
        };
        s.save(&p).unwrap();
        assert_eq!(Settings::load(&p), s);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn old_version_migrates() {
        let p = tmp("old.json");
        // v0 file without version/license; removed edge-glow keys are ignored.
        std::fs::write(
            &p,
            r##"{"edgeThicknessPx":12,"glowStrength":0.5,"brightness":0.9,
               "colorMode":{"mode":"artwork"},"customColor":"#111111",
               "batterySaver":true,"hideInFullscreen":false}"##,
        )
        .unwrap();
        let s = Settings::load(&p);
        assert_eq!(s.version, CURRENT_VERSION);
        assert!(s.license_key.is_none());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn profile_upsert_apply_and_delete() {
        let mut s = Settings::default();
        s.theme.name = "ember".into();
        s.eq_preset = "bass".into();
        s.eq_bands = vec![6.0, 4.0, 0.0, -2.0, -4.0];
        let id = s.save_profile("Fausto", 42);
        assert_eq!(id, "p42");
        assert_eq!(s.profiles.len(), 1);
        assert_eq!(s.active_profile.as_deref(), Some("p42"));

        // Diverging doesn't touch the saved bundle.
        s.theme.name = "glacier".into();
        s.eq_preset = "flat".into();
        assert_eq!(s.profiles[0].theme.name, "ember");

        // Apply restores it.
        assert!(s.apply_profile("p42"));
        assert_eq!(s.theme.name, "ember");
        assert_eq!(s.eq_preset, "bass");

        // Upsert by name keeps the id.
        s.theme.name = "mono".into();
        let id2 = s.save_profile("fausto", 43);
        assert_eq!(id2, "p42");
        assert_eq!(s.profiles.len(), 1);
        assert_eq!(s.profiles[0].theme.name, "mono");

        assert!(s.delete_profile("p42"));
        assert!(s.profiles.is_empty());
        assert_eq!(s.active_profile, None);
        assert!(!s.apply_profile("p42"));
        assert!(!s.delete_profile("p42"));
    }

    #[test]
    fn profiles_roundtrip() {
        let p = tmp("profiles.json");
        let mut s = Settings::default();
        s.save_profile("Night", 7);
        s.save(&p).unwrap();
        let back = Settings::load(&p);
        assert_eq!(back.profiles.len(), 1);
        assert_eq!(back.profiles[0].name, "Night");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn v1_file_without_hud_fields_gets_hud_defaults() {
        let p = tmp("v1nohud.json");
        std::fs::write(&p, r##"{"version":1,"licenseKey":null}"##).unwrap();
        let s = Settings::load(&p);
        assert!(s.hud_enabled);
        assert!(s.hud_always_on_top);
        assert_eq!(s.hud_position, None);
        let _ = std::fs::remove_file(&p);
    }
}
