//! Playlist import: parse .m3u/.m3u8, .pls and .xspf into queue entries.
//! Track paths resolve relative to the playlist file; http(s) entries come
//! back as `Remote` for the provider layer instead of being silently dropped.

use std::path::{Path, PathBuf};

/// One parsed entry: a local file candidate or a remote stream URL.
#[derive(Debug, Clone, PartialEq)]
pub enum PlaylistEntry {
    File {
        path: PathBuf,
        title: Option<String>,
        artist: Option<String>,
        duration_ms: Option<u64>,
    },
    Remote(String),
}

/// Parse `content` of the playlist at `path`. Format is sniffed: XML/XSPF,
/// `[playlist]` (.pls), otherwise M3U (plain or extended).
pub fn parse(path: &Path, content: &str) -> Vec<PlaylistEntry> {
    let head = content.trim_start();
    if head.starts_with("<?xml") || head.starts_with("<playlist") {
        parse_xspf(path, content)
    } else if head.contains("[playlist]") {
        parse_pls(path, content)
    } else {
        parse_m3u(path, content)
    }
}

fn is_remote(loc: &str) -> bool {
    loc.starts_with("http://") || loc.starts_with("https://")
}

fn file_entry(
    base: &Path,
    loc: &str,
    title: Option<String>,
    artist: Option<String>,
    duration_ms: Option<u64>,
) -> PlaylistEntry {
    let loc = loc.trim();
    if is_remote(loc) {
        return PlaylistEntry::Remote(loc.to_string());
    }
    // `file://` URIs may be percent-encoded; a plain path may be relative.
    let raw = loc.strip_prefix("file://").unwrap_or(loc);
    let decoded = percent_decode(raw);
    let p = PathBuf::from(&decoded);
    let path = if p.is_absolute() { p } else { base.join(p) };
    PlaylistEntry::File {
        path,
        title,
        artist,
        duration_ms,
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(hex);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// M3U / M3U8: `#EXTINF:seconds,artist - title` precedes each path line;
/// other `#` lines are directives and skipped.
fn parse_m3u(path: &Path, content: &str) -> Vec<PlaylistEntry> {
    let base = path.parent().unwrap_or(Path::new("."));
    let mut out = Vec::new();
    let mut pending: Option<(Option<String>, Option<String>, Option<u64>)> = None;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            let (secs, meta) = rest.split_once(',').unwrap_or((rest, ""));
            let duration_ms = secs
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|s| *s > 0.0)
                .map(|s| (s * 1000.0) as u64);
            // Convention: "Artist - Title"; absent = whole string is the title.
            let (artist, title) = match meta.trim().split_once(" - ") {
                Some((a, t)) => (
                    (!a.trim().is_empty()).then(|| a.trim().to_string()),
                    (!t.trim().is_empty()).then(|| t.trim().to_string()),
                ),
                None => (
                    None,
                    (!meta.trim().is_empty()).then(|| meta.trim().to_string()),
                ),
            };
            pending = Some((title, artist, duration_ms));
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let (title, artist, dur) = pending.take().unwrap_or_default();
        out.push(file_entry(base, line, title, artist, dur));
    }
    out
}

/// Winamp .pls: `[playlist]` section with `FileN=` / `TitleN=` / `LengthN=`
/// (seconds). Values may appear in any order, so collect by index first.
fn parse_pls(path: &Path, content: &str) -> Vec<PlaylistEntry> {
    let base = path.parent().unwrap_or(Path::new("."));
    let mut files: Vec<(usize, String)> = Vec::new();
    let mut titles: Vec<(usize, String)> = Vec::new();
    let mut lengths: Vec<(usize, String)> = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        let Some((key, val)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let val = val.trim();
        for (prefix, sink) in [
            ("File", &mut files),
            ("Title", &mut titles),
            ("Length", &mut lengths),
        ] {
            if let Some(idx) = key.strip_prefix(prefix) {
                if let Ok(n) = idx.parse::<usize>() {
                    sink.push((n, val.to_string()));
                }
            }
        }
    }
    files.sort_by_key(|(n, _)| *n);
    files
        .into_iter()
        .map(|(n, loc)| {
            let title = titles.iter().find(|(i, _)| *i == n).map(|(_, t)| t.clone());
            let duration_ms = lengths
                .iter()
                .find(|(i, _)| *i == n)
                .and_then(|(_, s)| s.trim().parse::<f64>().ok())
                .filter(|s| *s > 0.0)
                .map(|s| (s * 1000.0) as u64);
            file_entry(base, &loc, title, None, duration_ms)
        })
        .collect()
}

/// XSPF (.xspf): `<trackList><track>` with `location`, `title`, `creator`,
/// `duration` (ms). Parsed with roxmltree, tolerating missing namespaces.
fn parse_xspf(path: &Path, content: &str) -> Vec<PlaylistEntry> {
    let base = path.parent().unwrap_or(Path::new("."));
    let Ok(doc) = roxmltree::Document::parse(content) else {
        return Vec::new();
    };
    doc.descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "track")
        .map(|track| {
            let text_of = |name: &str| {
                track
                    .children()
                    .find(|c| c.is_element() && c.tag_name().name() == name)
                    .and_then(|c| c.text())
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty())
            };
            let Some(location) = text_of("location") else {
                return PlaylistEntry::Remote(String::new());
            };
            file_entry(
                base,
                &location,
                text_of("title"),
                text_of("creator"),
                text_of("duration").and_then(|d| d.parse::<u64>().ok()),
            )
        })
        .filter(|e| e != &PlaylistEntry::Remote(String::new()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(e: &PlaylistEntry) -> &PathBuf {
        match e {
            PlaylistEntry::File { path, .. } => path,
            _ => panic!("expected File"),
        }
    }

    #[test]
    fn m3u_extended_metadata_and_relative_paths() {
        let content = "#EXTM3U\n\
            #EXTINF:214,Violet Sector - Neon Reversal\nmusic/neon.mp3\n\
            #EXTINF:187,Slow Meridian\nsub/dir/../slow.flac\n\
            https://example.com/stream\n";
        let out = parse(Path::new("/lists/mix.m3u"), content);
        assert_eq!(out.len(), 3);
        match &out[0] {
            PlaylistEntry::File {
                path,
                title,
                artist,
                duration_ms,
            } => {
                assert_eq!(path, &PathBuf::from("/lists/music/neon.mp3"));
                assert_eq!(title.as_deref(), Some("Neon Reversal"));
                assert_eq!(artist.as_deref(), Some("Violet Sector"));
                assert_eq!(*duration_ms, Some(214_000));
            }
            _ => panic!("expected File"),
        }
        assert!(matches!(out[2], PlaylistEntry::Remote(_)));
    }

    #[test]
    fn m3u_crlf_and_missing_extinf() {
        let out = parse(Path::new("/a/b.m3u8"), "#EXTM3U\r\nsong.mp3\r\n");
        assert_eq!(out.len(), 1);
        assert_eq!(file(&out[0]), &PathBuf::from("/a/song.mp3"));
    }

    #[test]
    fn m3u_absolute_paths_kept() {
        let out = parse(Path::new("/l/x.m3u"), "/music/a.mp3\n");
        assert_eq!(file(&out[0]), &PathBuf::from("/music/a.mp3"));
    }

    #[test]
    fn pls_numbered_entries() {
        let content = "[playlist]\n\
            NumberOfEntries=2\n\
            Title2=Second\nFile2=/m/two.ogg\nLength2=95\n\
            File1=one.mp3\nTitle1=First\nLength1=-1\n";
        let out = parse(Path::new("/p/list.pls"), content);
        assert_eq!(out.len(), 2);
        match &out[0] {
            PlaylistEntry::File {
                path,
                title,
                duration_ms,
                ..
            } => {
                assert_eq!(path, &PathBuf::from("/p/one.mp3"));
                assert_eq!(title.as_deref(), Some("First"));
                assert_eq!(*duration_ms, None); // -1 = unknown
            }
            _ => panic!("expected File"),
        }
        match &out[1] {
            PlaylistEntry::File {
                title, duration_ms, ..
            } => {
                assert_eq!(title.as_deref(), Some("Second"));
                assert_eq!(*duration_ms, Some(95_000));
            }
            _ => panic!("expected File"),
        }
    }

    #[test]
    fn xspf_tracks() {
        let content = r#"<?xml version="1.0"?>
        <playlist xmlns="http://xspf.org/ns/0/"><trackList>
          <track><location>file:///music/a%20b.mp3</location><title>A B</title><creator>Me</creator><duration>60000</duration></track>
          <track><location>rel/c.mp3</location><title>C</title></track>
          <track><location>https://x.test/s</location></track>
        </trackList></playlist>"#;
        let out = parse(Path::new("/x/list.xspf"), content);
        assert_eq!(out.len(), 3);
        match &out[0] {
            PlaylistEntry::File {
                path,
                title,
                artist,
                duration_ms,
            } => {
                assert_eq!(path, &PathBuf::from("/music/a b.mp3"));
                assert_eq!(title.as_deref(), Some("A B"));
                assert_eq!(artist.as_deref(), Some("Me"));
                assert_eq!(*duration_ms, Some(60_000));
            }
            _ => panic!("expected File"),
        }
        assert_eq!(file(&out[1]), &PathBuf::from("/x/rel/c.mp3"));
        assert!(matches!(out[2], PlaylistEntry::Remote(_)));
    }

    #[test]
    fn xspf_malformed_is_empty_not_panic() {
        assert!(parse(Path::new("/x.xspf"), "<playlist><track><oops").is_empty());
    }
}
