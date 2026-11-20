//! Synced lyrics: LRC parsing, active-line lookup, LRCLIB fetch + disk cache.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LrcWord {
    pub at_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LrcLine {
    pub at_ms: u64,
    pub text: String,
    /// Enhanced-LRC (A2) word timestamps, when the source provides them —
    /// lets karaoke light words at their real times instead of an even split.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<LrcWord>>,
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
        let base_ms = stamps[0];
        for ms in stamps {
            // Word tags are written against the first occurrence; shift them
            // so repeated lines get their own syllable times.
            let word_offset = offset_ms + (ms as i64 - base_ms as i64);
            let line_at = (ms as i64 + offset_ms).max(0) as u64;
            let (text, words) = match parse_word_tags(rest.trim(), word_offset, line_at) {
                Some((t, w)) => (t, Some(w)),
                None => (rest.trim().to_string(), None),
            };
            lines.push(LrcLine {
                at_ms: line_at,
                text,
                words,
            });
        }
    }
    lines.sort_by_key(|l| l.at_ms);
    lines
}

/// Enhanced-LRC (A2) inline word tags: `<mm:ss.xx>` marks when the following
/// word is sung. `offset_ms` applies the global offset plus any shift for
/// repeated lines; `line_at_ms` is this occurrence's start, used to time any
/// leading text before the first tag. Returns the plain text (tags stripped)
/// and the timed segments; `None` when the line has no word tags.
fn parse_word_tags(rest: &str, offset_ms: i64, line_at_ms: u64) -> Option<(String, Vec<LrcWord>)> {
    if !rest.contains('<') {
        return None;
    }
    let mut s = rest;
    let mut plain = String::new();
    let mut words: Vec<LrcWord> = Vec::new();
    // Text before the first valid tag — becomes a segment timed at the line
    // start if a real tag exists, so karaoke doesn't drop it. A '<' that is
    // not a timestamp is literal text, not a tag.
    let mut pre = String::new();
    let mut seen_tag = false;
    let mut current: Option<LrcWord> = None;
    while let Some(lt) = s.find('<') {
        let (head, after_lt) = s.split_at(lt);
        plain.push_str(head);
        if let Some(w) = current.as_mut() {
            w.text.push_str(head);
        } else {
            pre.push_str(head);
        }
        let after = &after_lt[1..];
        let tag = after
            .find('>')
            .and_then(|gt| parse_ts(&after[..gt]).map(|ms| (gt, ms)));
        match tag {
            Some((gt, ms)) => {
                if let Some(w) = current.take() {
                    words.push(w);
                }
                if !seen_tag && !pre.trim().is_empty() {
                    words.push(LrcWord {
                        at_ms: line_at_ms,
                        text: std::mem::take(&mut pre),
                    });
                }
                seen_tag = true;
                current = Some(LrcWord {
                    at_ms: (ms as i64 + offset_ms).max(0) as u64,
                    text: String::new(),
                });
                s = &after[gt + 1..];
            }
            None => {
                // Unterminated or non-timestamp '<' — literal text.
                plain.push('<');
                if let Some(w) = current.as_mut() {
                    w.text.push('<');
                } else {
                    pre.push('<');
                }
                s = after;
            }
        }
    }
    plain.push_str(s);
    if let Some(w) = current.as_mut() {
        w.text.push_str(s);
    }
    if let Some(w) = current.take() {
        words.push(w);
    }
    // No real timestamp tag anywhere: the '<' was literal — plain LRC.
    if !seen_tag {
        return None;
    }
    // Segment text keeps its spacing verbatim — segments can be syllables
    // mid-word, so trimming/joining with spaces would corrupt the line.
    words.retain(|w| !w.text.is_empty());
    if words.is_empty() {
        None
    } else {
        Some((plain.trim().to_string(), words))
    }
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
        let text = res.as_ref().map(|ls| write_lrc(ls));
        cache.put(&track.id, text.as_deref())?;
        Ok(res)
    }
}

fn fmt_ts(ms: u64) -> String {
    format!(
        "{:02}:{:02}.{:02}",
        ms / 60000,
        (ms % 60000) / 1000,
        (ms % 1000) / 10
    )
}

/// Serialize lines back to LRC for the disk cache, preserving A2 word tags
/// (written against each line's own timestamp).
fn write_lrc(lines: &[LrcLine]) -> String {
    lines
        .iter()
        .map(|l| {
            let mut s = format!("[{}]", fmt_ts(l.at_ms));
            if let Some(words) = &l.words {
                for w in words {
                    s.push_str(&format!("<{}>{}", fmt_ts(w.at_ms), w.text));
                }
            } else {
                s.push_str(&l.text);
            }
            s
        })
        .collect::<Vec<_>>()
        .join("\n")
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
    fn parses_a2_word_tags() {
        // A2 marks syllable starts: "Hel"+"lo" is one word, two segments.
        let lines = parse_lrc("[00:01.00]<00:01.10>Hel<00:01.50>lo <00:02.00>world");
        assert_eq!(lines.len(), 1);
        let l = &lines[0];
        assert_eq!(l.text, "Hello world");
        let words = l.words.as_ref().unwrap();
        assert_eq!(words.len(), 3);
        assert_eq!(words[0].at_ms, 1100);
        assert_eq!(words[0].text, "Hel");
        assert_eq!(words[1].at_ms, 1500);
        assert_eq!(words[1].text, "lo ");
        assert_eq!(words[2].at_ms, 2000);
        assert_eq!(words[2].text, "world");
    }

    #[test]
    fn a2_respects_offset() {
        let lines = parse_lrc("[offset:+500]\n[00:01.00]<00:01.20>hey");
        let words = lines[0].words.as_ref().unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].at_ms, 1700);
        assert_eq!(words[0].text, "hey");
    }

    #[test]
    fn a2_leading_text_gets_line_time() {
        let lines = parse_lrc("[00:01.00]La <00:01.50>la");
        let words = lines[0].words.as_ref().unwrap();
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].at_ms, 1000);
        assert_eq!(words[0].text, "La ");
        assert_eq!(words[1].at_ms, 1500);
        assert_eq!(lines[0].text, "La la");
    }

    #[test]
    fn a2_repeated_lines_shift_word_times() {
        let lines = parse_lrc("[00:10.00][00:20.00]<00:10.50>word");
        assert_eq!(lines.len(), 2);
        assert_eq!(
            lines[0].words.as_ref().unwrap()[0].at_ms,
            10_500,
            "first occurrence"
        );
        assert_eq!(
            lines[1].words.as_ref().unwrap()[0].at_ms,
            20_500,
            "second occurrence shifted by line delta"
        );
    }

    #[test]
    fn write_lrc_preserves_word_tags() {
        let src = "[00:01.00]<00:01.10>Hel<00:01.50>lo <00:02.00>world\n[00:05.00]plain";
        let lines = parse_lrc(src);
        let out = write_lrc(&lines);
        let reparsed = parse_lrc(&out);
        assert_eq!(reparsed, lines);
    }

    #[test]
    fn literal_lt_is_not_a_tag() {
        // "I <3 you" has no real tag — plain LRC, no timed segments.
        let lines = parse_lrc("[00:01.00]I <3 you");
        assert_eq!(lines[0].words, None);
        assert_eq!(lines[0].text, "I <3 you");
    }

    #[test]
    fn literal_lt_before_first_tag_keeps_leading_text() {
        // "<3 <00:01.50>you": the "<3 " prefix is literal text timed at the
        // line start, not a tag.
        let lines = parse_lrc("[00:01.00]<3 <00:01.50>you");
        let words = lines[0].words.as_ref().unwrap();
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].at_ms, 1000);
        assert_eq!(words[0].text, "<3 ");
        assert_eq!(words[1].at_ms, 1500);
        assert_eq!(words[1].text, "you");
        // And it survives a cache write/read round-trip.
        let reparsed = parse_lrc(&write_lrc(&lines));
        assert_eq!(reparsed, lines);
    }

    #[test]
    fn line_without_word_tags_has_none() {
        let lines = parse_lrc("[00:01.00]plain line");
        assert_eq!(lines[0].words, None);
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
