//! Remote music providers resolved through an external `yt-dlp` binary.
//!
//! Search, metadata and download are delegated to yt-dlp so the app ships no
//! provider SDKs or API keys. The binary is optional: providers are simply
//! unavailable when it is not installed. The UI surfaces that state instead
//! of failing.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Prefer formats rodio/symphonia decodes without the opus/mkv feature set
/// (aac/m4a, mp3, flac, wav, ogg-vorbis) — a plain `bestaudio` fallback can
/// pick Opus/WebM over an available MP3 and produce an undecodable file.
const FORMAT_SELECTOR: &str = concat!(
    "ba[ext=m4a]/ba[acodec^=mp4a]/",
    "ba[ext=mp3]/ba[acodec^=mp3]/",
    "ba[ext=flac]/ba[ext=wav]/",
    "ba[ext=ogg]/ba[acodec^=vorbis]/",
    "ba/b",
);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTrack {
    pub id: String,
    /// Provider key: "youtube" | "soundcloud".
    pub source: String,
    pub title: String,
    pub artist: String,
    pub duration_ms: u64,
    pub url: String,
    pub artwork_url: String,
}

/// Video selector for the karaoke backdrop: prefer an h264 progressive or
/// video-only mp4 under 480p (every webview decodes avc; av1/vp9 support is
/// uneven), then any <=480p video, then whatever is available. Video-only
/// streams are fine — the backdrop is muted and blurred, so quality matters
/// less than size.
const VIDEO_SELECTOR: &str = concat!(
    "b[ext=mp4][vcodec^=avc][height<=480]/bv*[ext=mp4][vcodec^=avc][height<=480]/",
    "b[vcodec^=avc][height<=480]/bv*[vcodec^=avc][height<=480]/",
    "b[ext=mp4][height<=480]/bv*[ext=mp4][height<=480]/",
    "b[height<=480]/bv*[height<=480]/",
    "b/bv*",
);

/// Provider prefix understood by yt-dlp (`<prefix><N>:<query>`).
pub fn search_prefix(source: &str) -> Option<&'static str> {
    match source {
        "youtube" | "ytmusic" => Some("ytsearch"),
        "soundcloud" => Some("scsearch"),
        _ => None,
    }
}

/// A located yt-dlp executable.
#[derive(Debug, Clone)]
pub struct YtDlp {
    bin: PathBuf,
}

impl YtDlp {
    /// Find a usable yt-dlp: explicit `path` from settings, else PATH.
    pub fn detect(explicit: Option<&str>) -> Option<Self> {
        if let Some(p) = explicit {
            let p = PathBuf::from(p);
            if p.is_file() {
                return Some(Self { bin: p });
            }
        }
        for name in ["yt-dlp", "yt-dlp.exe", "ytdlp"] {
            if let Some(found) = which(name) {
                return Some(Self { bin: found });
            }
        }
        None
    }

    /// `yt-dlp "<prefix><limit>:<query>" --dump-json` → one JSON object per line.
    pub fn search(
        &self,
        source: &str,
        query: &str,
        limit: u32,
    ) -> Result<Vec<RemoteTrack>, String> {
        let prefix = search_prefix(source).ok_or_else(|| format!("unknown source: {source}"))?;
        let spec = format!("{prefix}{limit}:{query}");
        let out = Command::new(&self.bin)
            .args([
                &spec,
                "--dump-json",
                "--no-warnings",
                "--no-playlist",
                "--skip-download",
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        Ok(stdout
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .filter_map(|v| parse_entry(source, &v))
            .collect())
    }

    /// Resolve a direct video stream URL for the track's music video, for the
    /// karaoke backdrop. Returns the `-g` URL (no download). First tries an
    /// "official video" search, then a bare title search.
    pub fn resolve_video(&self, artist: &str, title: &str) -> Result<Option<String>, String> {
        for suffix in [" official music video", ""] {
            let query = format!("{artist} {title}{suffix}");
            let spec = format!("ytsearch1:{query}");
            let out = Command::new(&self.bin)
                .args([
                    &spec,
                    "-f",
                    VIDEO_SELECTOR,
                    "-g",
                    "--no-playlist",
                    "--no-warnings",
                ])
                .output()
                .map_err(|e| e.to_string())?;
            if !out.status.success() {
                continue;
            }
            let url = String::from_utf8_lossy(&out.stdout)
                .lines()
                .find(|l| !l.trim().is_empty())
                .map(|l| l.trim().to_string());
            if let Some(u) = url {
                return Ok(Some(u));
            }
        }
        Ok(None)
    }

    /// Download the best decodable audio for `url` into `dest_dir` as
    /// `dest_name.<ext>`; returns the written file.
    pub fn download(&self, url: &str, dest_dir: &Path, dest_name: &str) -> Result<PathBuf, String> {
        std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
        let template = dest_dir.join(format!("{dest_name}.%(ext)s"));
        let out = Command::new(&self.bin)
            .args([
                "-f",
                FORMAT_SELECTOR,
                "-o",
                template.to_str().ok_or("bad dest path")?,
                "--no-playlist",
                "--no-warnings",
                url,
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        std::fs::read_dir(dest_dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .find(|p| {
                p.file_stem()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| s == dest_name)
            })
            .ok_or_else(|| "download finished but no file was written".into())
    }
}

/// Minimal PATH search (std has no `which`).
fn which(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    // Common user-local spots that may not be on the app's PATH.
    for dir in [".local/bin", ".cargo/bin"] {
        if let Some(home) = std::env::home_dir() {
            let cand = home.join(dir).join(name);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

/// Map one yt-dlp info JSON object to a RemoteTrack. Entries without an id or
/// title are dropped.
fn parse_entry(source: &str, v: &serde_json::Value) -> Option<RemoteTrack> {
    let id = v.get("id")?.as_str()?.to_string();
    let title = v.get("title")?.as_str()?.to_string();
    // `artist: null` is a present-but-null value: or_else would accept it and
    // suppress the populated fallbacks — pick the first non-null string.
    let artist = ["artist", "channel", "uploader"]
        .iter()
        .find_map(|k| v.get(k)?.as_str())
        .unwrap_or_default()
        .to_string();
    let duration_ms = v
        .get("duration")
        .and_then(|d| d.as_f64())
        .map(|s| (s * 1000.0) as u64)
        .unwrap_or(0);
    let url = ["webpage_url", "url"]
        .iter()
        .find_map(|k| v.get(k)?.as_str())
        .unwrap_or_default()
        .to_string();
    // Flat entries carry only an id; rebuild a watch/search URL per provider.
    let url = if url.is_empty() {
        match source {
            "soundcloud" => format!("https://soundcloud.com/{id}"),
            _ => format!("https://www.youtube.com/watch?v={id}"),
        }
    } else {
        url
    };
    let artwork_url = v
        .get("thumbnail")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or_else(|| {
            v.get("thumbnails")?
                .as_array()?
                .last()?
                .get("url")?
                .as_str()
                .map(String::from)
        })
        .unwrap_or_default();
    Some(RemoteTrack {
        id,
        source: source.to_string(),
        title,
        artist,
        duration_ms,
        url,
        artwork_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(json: &str) -> Option<RemoteTrack> {
        parse_entry("youtube", &serde_json::from_str(json).unwrap())
    }

    #[test]
    fn parses_full_entry() {
        let t = entry(
            r#"{"id":"abc123","title":"Song","uploader":"Artist","duration":212.5,
                "webpage_url":"https://youtube.com/watch?v=abc123","thumbnail":"https://i.ytimg.com/x.jpg"}"#,
        )
        .unwrap();
        assert_eq!(t.id, "abc123");
        assert_eq!(t.artist, "Artist");
        assert_eq!(t.duration_ms, 212_500);
        assert_eq!(t.url, "https://youtube.com/watch?v=abc123");
        assert_eq!(t.artwork_url, "https://i.ytimg.com/x.jpg");
    }

    #[test]
    fn flat_entry_rebuilds_url() {
        let t = entry(r#"{"id":"xyz","title":"Song"}"#).unwrap();
        assert_eq!(t.url, "https://www.youtube.com/watch?v=xyz");
        assert_eq!(t.duration_ms, 0);
    }

    #[test]
    fn soundcloud_flat_url() {
        let v: serde_json::Value = serde_json::from_str(r#"{"id":"42","title":"S"}"#).unwrap();
        let t = parse_entry("soundcloud", &v).unwrap();
        assert_eq!(t.url, "https://soundcloud.com/42");
    }

    #[test]
    fn drops_entry_without_title() {
        assert!(entry(r#"{"id":"x"}"#).is_none());
    }

    #[test]
    fn null_artist_falls_back_to_uploader() {
        let t = entry(r#"{"id":"a","title":"S","artist":null,"channel":null,"uploader":"DJ"}"#)
            .unwrap();
        assert_eq!(t.artist, "DJ");
    }

    #[test]
    fn null_webpage_url_falls_back() {
        let t = entry(r#"{"id":"a","title":"S","webpage_url":null,"url":"https://x/y"}"#).unwrap();
        assert_eq!(t.url, "https://x/y");
    }

    #[test]
    fn prefixes() {
        assert_eq!(search_prefix("ytmusic"), Some("ytsearch"));
        assert_eq!(search_prefix("soundcloud"), Some("scsearch"));
        assert_eq!(search_prefix("spotify"), None);
    }
}
