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

/// `uri`: true when `loc` is a URI reference (XSPF `<location>`) whose
/// percent-encoding must be decoded even without a `file://` scheme.
fn file_entry(
    base: &Path,
    loc: &str,
    title: Option<String>,
    artist: Option<String>,
    duration_ms: Option<u64>,
    uri: bool,
) -> PlaylistEntry {
    let loc = loc.trim();
    if is_remote(loc) {
        return PlaylistEntry::Remote(loc.to_string());
    }
    // `file://` URIs and XSPF locations are percent-encoded; plain M3U/PLS
    // paths are not — decoding them would rename files with literal '%'
    // sequences (e.g. "100%fA.mp3").
    let file_uri = loc.starts_with("file://");
    let raw = loc.strip_prefix("file://").unwrap_or(loc);
    // Windows URIs decode to `/C:/...`; the leading slash is URI syntax,
    // not part of the drive path.
    let decoded = if file_uri || uri {
        strip_drive_slash(percent_decode(raw))
    } else {
        raw.to_string()
    };
    let p = PathBuf::from(&decoded);
    let path = if p.is_absolute() { p } else { base.join(p) };
    PlaylistEntry::File {
        path,
        title,
        artist,
        duration_ms,
    }
}

/// One writable playlist row: absolute path + display metadata.
pub struct M3uItem {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub duration_ms: u64,
}

/// Serialize entries as extended M3U (UTF-8 — save as `.m3u8`).
pub fn write_m3u(items: &[M3uItem]) -> String {
    // M3U is line-based: embedded CR/LF in tags would split into bogus
    // track rows on reimport, so collapse them to spaces.
    let single_line = |s: &str| -> String {
        s.split(['\r', '\n'])
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let mut out = String::from("#EXTM3U\n");
    for it in items {
        let path = single_line(&it.path);
        let title = single_line(&it.title);
        let artist = single_line(&it.artist);
        let secs = (it.duration_ms as f64 / 1000.0).round() as i64;
        let meta = match (artist.is_empty(), title.is_empty()) {
            (false, false) => format!("{artist} - {title}"),
            (true, false) => title,
            _ => path.rsplit(['/', '\\']).next().unwrap_or(&path).to_string(),
        };
        out.push_str(&format!("#EXTINF:{secs},{meta}\n{path}\n"));
    }
    out
}

/// Playlist files directly inside `dir` (.m3u/.m3u8/.pls/.xspf),
/// sorted by path.
pub fn list(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.is_file()
                        && matches!(
                            p.extension()
                                .and_then(|e| e.to_str())
                                .map(|e| e.to_ascii_lowercase())
                                .as_deref(),
                            Some("m3u") | Some("m3u8") | Some("pls") | Some("xspf")
                        )
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            // Compare on bytes, not str slices: `s[i+1..i+3]` can cut a
            // multi-byte UTF-8 char (e.g. `100%🎵.mp3`) and panic.
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn strip_drive_slash(s: String) -> String {
    let b = s.as_bytes();
    if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        s[1..].to_string()
    } else {
        s
    }
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
        out.push(file_entry(base, line, title, artist, dur, false));
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
            file_entry(base, &loc, title, None, duration_ms, false)
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
                true,
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
          <track><location>music/a%20b.mp3</location></track>
          <track><location>https://x.test/s</location></track>
        </trackList></playlist>"#;
        let out = parse(Path::new("/x/list.xspf"), content);
        assert_eq!(out.len(), 4);
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
        // XSPF locations are URI references: percent-decoded even relative.
        assert_eq!(file(&out[2]), &PathBuf::from("/x/music/a b.mp3"));
        assert!(matches!(out[3], PlaylistEntry::Remote(_)));
    }

    #[test]
    fn xspf_malformed_is_empty_not_panic() {
        assert!(parse(Path::new("/x.xspf"), "<playlist><track><oops").is_empty());
    }

    #[test]
    fn m3u_unicode_percent_decoding() {
        // Literal '%' followed by a multi-byte char must not panic or eat it.
        let out = parse(
            Path::new("/m.xspf"),
            "100%🎵.mp3\nfile:///m/100%F0%9F%8E%B5.mp3\n",
        );
        assert_eq!(out.len(), 2);
        assert_eq!(file(&out[0]), &PathBuf::from("/100%🎵.mp3"));
        assert_eq!(file(&out[1]), &PathBuf::from("/m/100🎵.mp3"));
    }

    #[test]
    fn write_m3u_round_trips_through_parse() {
        let items = vec![
            M3uItem {
                path: "/music/a b.mp3".into(),
                title: "A B".into(),
                artist: "Me".into(),
                duration_ms: 60_000,
            },
            M3uItem {
                path: "/music/c.flac".into(),
                title: "Solo".into(),
                artist: String::new(),
                duration_ms: 0,
            },
        ];
        let text = write_m3u(&items);
        assert!(text.starts_with("#EXTM3U"));
        let out = parse(Path::new("/x/list.m3u8"), &text);
        assert_eq!(file(&out[0]), &PathBuf::from("/music/a b.mp3"));
        match &out[0] {
            PlaylistEntry::File {
                title,
                artist,
                duration_ms,
                ..
            } => {
                assert_eq!(title.as_deref(), Some("A B"));
                assert_eq!(artist.as_deref(), Some("Me"));
                assert_eq!(*duration_ms, Some(60_000));
            }
            _ => panic!("expected File"),
        }
        assert_eq!(file(&out[1]), &PathBuf::from("/music/c.flac"));
    }

    #[test]
    fn write_m3u_sanitizes_line_breaks_and_keeps_plain_percent() {
        let items = vec![M3uItem {
            path: "/music/100%fA mix.mp3".into(),
            title: "Line\nBreak".into(),
            artist: "A\r\nB".into(),
            duration_ms: 1_000,
        }];
        let text = write_m3u(&items);
        // header + one EXTINF + one path — no stray rows from the newlines.
        assert_eq!(text.lines().count(), 3);
        let out = parse(Path::new("/x/l.m3u8"), &text);
        assert_eq!(out.len(), 1);
        assert_eq!(file(&out[0]), &PathBuf::from("/music/100%fA mix.mp3"));
    }

    #[test]
    fn windows_drive_uri_strips_slash() {
        // `file:///C:/...` decodes to `/C:/...`; the leading slash is URI
        // syntax. (On Windows the stripped path is absolute and kept.)
        assert_eq!(
            strip_drive_slash("/C:/Music/a.mp3".to_string()),
            "C:/Music/a.mp3"
        );
        assert_eq!(
            strip_drive_slash("/unix/path.mp3".to_string()),
            "/unix/path.mp3"
        );
    }
}
