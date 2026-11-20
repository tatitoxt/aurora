//! Synced lyrics: LRC parsing, active-line lookup, LRCLIB fetch + disk cache.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LrcLine {
    pub at_ms: u64,
    pub text: String,
}

#[derive(Debug, Error)]
pub enum LyricsError {
    #[error("network error: {0}")]
    Network(String),
    #[error("bad response: {0}")]
    Parse(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

fn parse_ts(tag: &str) -> Option<u64> {
    // mm:ss.xx or mm:ss.xxx (also tolerates m:ss)
    let (m, rest) = tag.split_once(':')?;
    let mins: u64 = m.trim().parse().ok()?;
    let (s, frac) = rest.split_once('.').unwrap_or((rest, "0"));
    let secs: u64 = s.trim().parse().ok()?;
    let frac: f64 = format!("0.{frac}").parse().ok()?;
    Some(mins * 60_000 + secs * 1_000 + (frac * 1000.0) as u64)
}

/// Parse LRC text into sorted lines. Supports multiple timestamps per line
/// and the `[offset:±ms]` global offset tag.
pub fn parse_lrc(input: &str) -> Vec<LrcLine> {
    let mut offset_ms: i64 = 0;
    let mut lines = Vec::new();
    for raw in input.lines() {
        let mut rest = raw.trim();
        if let Some(tag) = rest
            .strip_prefix("[offset:")
            .and_then(|t| t.strip_suffix(']'))
        {
            if let Ok(v) = tag.trim().parse::<i64>() {
                offset_ms = v;
            }
            continue;
        }
        let mut stamps = Vec::new();
        while let Some(stripped) = rest.strip_prefix('[') {
            let Some(end) = stripped.find(']') else { break };
            let tag = &stripped[..end];
            if let Some(ms) = parse_ts(tag) {
                stamps.push(ms);
                rest = &stripped[end + 1..];
            } else {
                break; // metadata tag like [ar:...]
            }
        }
        if stamps.is_empty() {
            continue; // metadata or malformed
        }
        for ms in stamps {
            lines.push(LrcLine {
                at_ms: (ms as i64 + offset_ms).max(0) as u64,
                text: rest.trim().to_string(),
            });
        }
    }
    lines.sort_by_key(|l| l.at_ms);
    lines
}

/// Index of the line active at `pos_ms` (last line at or before position).
/// `None` when the position is before the first line or there are no lines.
pub fn active_line(lines: &[LrcLine], pos_ms: u64) -> Option<usize> {
    if lines.is_empty() || pos_ms < lines[0].at_ms {
        return None;
    }
    Some(lines.partition_point(|l| l.at_ms <= pos_ms) - 1)
}

fn cache_key(id: &str) -> String {
    let mut h = DefaultHasher::new();
    id.hash(&mut h);
    format!("{:016x}.lrc", h.finish())
}

/// Directory-based cache: one .lrc file per track, TTL-checked.
pub struct LyricsCache {
    dir: PathBuf,
    ttl: Duration,
}

impl LyricsCache {
    pub fn new(dir: impl Into<PathBuf>, ttl: Duration) -> Self {
        Self {
            dir: dir.into(),
            ttl,
        }
    }

    fn path_for(&self, track_id: &str) -> PathBuf {
        self.dir.join(cache_key(track_id))
    }

    pub fn get(&self, track_id: &str) -> Option<String> {
        let path = self.path_for(track_id);
        let meta = std::fs::metadata(&path).ok()?;
        let age = meta
            .modified()
            .ok()
            .and_then(|m| SystemTime::now().duration_since(m).ok())?;
        if age > self.ttl {
            return None;
        }
        std::fs::read_to_string(path).ok()
    }

    /// Store `content` (`None` caches a negative result as empty).
    pub fn put(&self, track_id: &str, content: Option<&str>) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        std::fs::write(self.path_for(track_id), content.unwrap_or(""))
    }
}

pub type GetFn = Box<dyn Fn(&str) -> Result<String, String> + Send + Sync>;

/// LRCLIB (https://lrclib.net) client. Free, no API key.
pub struct LrclibClient {
    pub base_url: String,
    /// Injectable for tests: (url) -> Result<body, error>
    pub get: Option<GetFn>,
    timeout: Duration,
}

impl Default for LrclibClient {
    fn default() -> Self {
        Self::new()
    }
}

impl LrclibClient {
    pub fn new() -> Self {
        Self {
            base_url: "https://lrclib.net".into(),
            get: None,
            timeout: Duration::from_secs(10),
        }
    }

    fn http_get(&self, url: &str) -> Result<String, LyricsError> {
        if let Some(f) = &self.get {
            return f(url).map_err(LyricsError::Network);
        }
        let body = ureq::get(url)
            .timeout(self.timeout)
            .call()
            .map_err(|e| LyricsError::Network(e.to_string()))?
            .into_string()
            .map_err(|e| LyricsError::Network(e.to_string()))?;
        Ok(body)
    }

    /// Fetch synced lyrics for a track. `Ok(None)` = not found / unsynced only.
    pub fn fetch(&self, track: &crate::media::Track) -> Result<Option<Vec<LrcLine>>, LyricsError> {
        let url = format!(
            "{}/api/get?track_name={}&artist_name={}&album_name={}&duration={}",
            self.base_url,
            urlencode(&track.title),
            urlencode(&track.artist),
            urlencode(&track.album),
            track.duration_ms / 1000,
        );
        let body = match self.http_get(&url) {
            Ok(b) => b,
            Err(LyricsError::Network(e)) if e.contains("404") => return Ok(None),
            Err(e) => return Err(e),
        };
        let v: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| LyricsError::Parse(e.to_string()))?;
        if let Some(lrc) = v.get("syncedLyrics").and_then(|s| s.as_str()) {
            let lines = parse_lrc(lrc);
            if !lines.is_empty() {
                return Ok(Some(lines));
            }
        }
        Ok(None)
    }

    /// Fetch with caching: hit -> Some, miss -> fetch + store (incl. negative).
    pub fn fetch_cached(
        &self,
        track: &crate::media::Track,
        cache: &LyricsCache,
    ) -> Result<Option<Vec<LrcLine>>, LyricsError> {
        if let Some(body) = cache.get(&track.id) {
            if body.is_empty() {
                return Ok(None);
            }
            let lines = parse_lrc(&body);
            return Ok(if lines.is_empty() { None } else { Some(lines) });
        }
        let res = self.fetch(track)?;
        let text = res.as_ref().map(|ls| {
            ls.iter()
                .map(|l| {
                    let m = l.at_ms / 60000;
                    let s = (l.at_ms % 60000) / 1000;
                    let cs = (l.at_ms % 1000) / 10;
                    format!("[{m:02}:{s:02}.{cs:02}]{}", l.text)
                })
                .collect::<Vec<_>>()
                .join("\n")
        });
        cache.put(&track.id, text.as_deref())?;
        Ok(res)
    }
}

fn urlencode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}

pub fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LRC: &str = "\
[ti:Song]
[ar:Artist]
[00:01.00]First line
[00:02.50]Second line
[00:05.00][00:10.00]Repeated
[00:07.25]
[00:08.00]Last line";

    #[test]
    fn parses_multi_timestamp_and_metadata() {
        let lines = parse_lrc(LRC);
        assert_eq!(lines.len(), 6);
        assert_eq!(lines[0].at_ms, 1000);
        assert_eq!(lines[1].at_ms, 2500);
        assert_eq!(lines[3].at_ms, 7250);
        assert_eq!(lines[3].text, "");
        assert_eq!(lines[5].at_ms, 10_000);
        assert_eq!(lines[5].text, "Repeated");
    }

    #[test]
    fn offset_tag_shifts() {
        let lines = parse_lrc("[offset:+500]\n[00:01.00]Hi");
        assert_eq!(lines[0].at_ms, 1500);
        let lines = parse_lrc("[offset:-2000]\n[00:01.00]Hi");
        assert_eq!(lines[0].at_ms, 0);
    }

    #[test]
    fn active_line_boundaries() {
        let lines = parse_lrc(LRC);
        assert_eq!(active_line(&lines, 0), None);
        assert_eq!(active_line(&lines, 999), None);
        assert_eq!(active_line(&lines, 1000), Some(0));
        assert_eq!(active_line(&lines, 2499), Some(0));
        assert_eq!(active_line(&lines, 2500), Some(1));
        assert_eq!(active_line(&lines, 999_999), Some(5));
        assert_eq!(active_line(&[], 100), None);
    }

    #[test]
    fn cache_roundtrip_and_expiry() {
        let dir = std::env::temp_dir().join(format!("noctbeat-test-{}", std::process::id()));
        let cache = LyricsCache::new(&dir, Duration::from_millis(50));
        cache.put("t1", Some("[00:01.00]x")).unwrap();
        assert_eq!(cache.get("t1").unwrap(), "[00:01.00]x");
        std::thread::sleep(Duration::from_millis(60));
        assert!(cache.get("t1").is_none(), "expired entry must miss");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn track() -> crate::media::Track {
        crate::media::Track {
            id: "A — B".into(),
            title: "B".into(),
            artist: "A".into(),
            album: "C".into(),
            artwork_url: String::new(),
            duration_ms: 200_000,
        }
    }

    #[test]
    fn client_parses_synced_lyrics() {
        let mut c = LrclibClient::new();
        c.get = Some(Box::new(|_url| {
            Ok(
                r#"{"id":1,"syncedLyrics":"[00:01.00]Hello\n[00:02.00]World","plainLyrics":"x"}"#
                    .into(),
            )
        }));
        let lines = c.fetch(&track()).unwrap().unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "Hello");
    }

    #[test]
    fn client_plain_only_returns_none() {
        let mut c = LrclibClient::new();
        c.get = Some(Box::new(|_| {
            Ok(r#"{"syncedLyrics":null,"plainLyrics":"x"}"#.into())
        }));
        assert!(c.fetch(&track()).unwrap().is_none());
    }

    #[test]
    fn client_404_is_none() {
        let mut c = LrclibClient::new();
        c.get = Some(Box::new(|_| Err("404 Not Found".into())));
        assert!(c.fetch(&track()).unwrap().is_none());
    }
}
