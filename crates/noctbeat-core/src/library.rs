//! Local library scan: walk a folder, read tags, produce queue items.

use crate::media::Track;
use crate::player::QueueItem;
use std::path::{Path, PathBuf};

const AUDIO_EXTS: &[&str] = &[
    "mp3", "flac", "ogg", "opus", "m4a", "aac", "wav", "wma", "aiff",
];

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// List audio files under `dir` (recursive, sorted). Pure filesystem walk —
/// no tag reads — so it is cheap and testable.
pub fn scan_paths(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if is_audio(&p) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

fn base_track(path: &Path) -> Track {
    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .replace('_', " ");
    Track {
        id: path.display().to_string(),
        title,
        artist: "Unknown artist".into(),
        album: path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            .unwrap_or("Local files")
            .into(),
        artwork_url: String::new(),
        duration_ms: 0,
    }
}

/// Read tags + duration with lofty; falls back to filename-derived fields.
fn tag_track(path: &Path) -> Track {
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::probe::Probe;
    use lofty::tag::Accessor;
    let mut t = base_track(path);
    let Ok(probed) = Probe::open(path).and_then(|p| p.read()) else {
        return t;
    };
    t.duration_ms = probed.properties().duration().as_millis() as u64;
    let tag = probed.primary_tag().or_else(|| probed.first_tag());
    if let Some(tag) = tag {
        if let Some(x) = tag.title() {
            if !x.is_empty() {
                t.title = x.into_owned();
            }
        }
        if let Some(x) = tag.artist() {
            if !x.is_empty() {
                t.artist = x.into_owned();
            }
        }
        if let Some(x) = tag.album() {
            if !x.is_empty() {
                t.album = x.into_owned();
            }
        }
        if let Some(pic) = tag.pictures().first() {
            // Cache artwork bytes next to the app data so the UI can file:// it.
            if let Ok(dir) = std::env::var("NOCTBEAT_ART_DIR") {
                let name = format!("{:x}.img", fxhash(&t.id));
                let out = Path::new(&dir).join(&name);
                if std::fs::create_dir_all(&dir).is_ok() && std::fs::write(&out, pic.data()).is_ok()
                {
                    t.artwork_url = format!("file://{}", out.display());
                }
            }
        }
    }
    t
}

fn fxhash(s: &str) -> u64 {
    // FNV-1a: deterministic, dependency-free.
    let mut h = 0xcbf29ce484222325u64;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Full scan: paths + tags → queue items.
pub fn scan(dir: &Path) -> Vec<QueueItem> {
    scan_paths(dir)
        .into_iter()
        .map(|p| QueueItem {
            track: tag_track(&p),
            path: p.display().to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), b"fake").unwrap();
    }

    #[test]
    fn scan_paths_finds_audio_recursively_sorted() {
        let root = std::env::temp_dir().join(format!("noctbeat-lib-{}", std::process::id()));
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        write(&root, "b.mp3");
        write(&root, "a.FLAC");
        write(&root, "skip.txt");
        write(&sub, "c.ogg");
        write(&sub, "cover.png");
        let paths = scan_paths(&root);
        let names: Vec<_> = paths
            .iter()
            .map(|p| p.file_name().unwrap().to_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["a.FLAC", "b.mp3", "c.ogg"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_dir_is_empty() {
        assert!(scan_paths(Path::new("/no/such/dir")).is_empty());
    }

    #[test]
    fn base_track_uses_filename() {
        let t = base_track(Path::new("/music/Blue_Skies.mp3"));
        assert_eq!(t.title, "Blue Skies");
        assert_eq!(t.album, "music");
    }

    #[test]
    fn scan_on_plain_files_uses_filename_fallback() {
        let root = std::env::temp_dir().join(format!("noctbeat-scan-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        write(&root, "Track_One.mp3");
        let items = scan(&root);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].track.title, "Track One");
        assert!(!items[0].path.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
