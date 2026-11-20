//! Persisted user settings: JSON file, versioned, corrupt-proof.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::Path;

pub const CURRENT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayRule {
    pub display_id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ColorMode {
    Artwork,
    Custom,
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
}

impl Default for ThemeSettings {
    fn default() -> Self {
        Self {
            name: "noct".into(),
            accent: None,
            accent2: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    pub edge_thickness_px: u32,
    pub glow_strength: f32,
    pub brightness: f32,
    pub color_mode: ColorMode,
    pub custom_color: String,
    pub battery_saver: bool,
    pub hide_in_fullscreen: bool,
    pub displays: Vec<DisplayRule>,
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
    /// Explicit yt-dlp binary path; PATH is searched when unset.
    #[serde(default)]
    pub ytdlp_path: Option<String>,
    /// Visual theme preset + accent overrides.
    #[serde(default)]
    pub theme: ThemeSettings,
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            edge_thickness_px: 24,
            glow_strength: 0.7,
            brightness: 0.8,
            color_mode: ColorMode::Artwork,
            custom_color: "#8b5cf6".into(),
            battery_saver: false,
            hide_in_fullscreen: true,
            displays: vec![],
            license_key: None,
            hud_enabled: true,
            hud_always_on_top: true,
            hud_position: None,
            music_dir: None,
            ytdlp_path: None,
            theme: ThemeSettings::default(),
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
            edge_thickness_px: 48,
            color_mode: ColorMode::Custom,
            custom_color: "#ff0080".into(),
            displays: vec![DisplayRule {
                display_id: "d1".into(),
                enabled: false,
            }],
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
        // v0 file without version/displays/license.
        std::fs::write(
            &p,
            r##"{"edgeThicknessPx":12,"glowStrength":0.5,"brightness":0.9,
               "colorMode":{"mode":"artwork"},"customColor":"#111111",
               "batterySaver":true,"hideInFullscreen":false}"##,
        )
        .unwrap();
        let s = Settings::load(&p);
        assert_eq!(s.version, CURRENT_VERSION);
        assert_eq!(s.edge_thickness_px, 12);
        assert!(s.battery_saver);
        assert_eq!(s.displays, vec![]);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn v1_file_without_hud_fields_gets_hud_defaults() {
        let p = tmp("v1nohud.json");
        std::fs::write(
            &p,
            r##"{"version":1,"edgeThicknessPx":24,"glowStrength":0.7,
               "brightness":0.8,"colorMode":{"mode":"artwork"},
               "customColor":"#8b5cf6","batterySaver":false,
               "hideInFullscreen":true,"displays":[],"licenseKey":null}"##,
        )
        .unwrap();
        let s = Settings::load(&p);
        assert!(s.hud_enabled);
        assert!(s.hud_always_on_top);
        assert_eq!(s.hud_position, None);
        let _ = std::fs::remove_file(&p);
    }
}
