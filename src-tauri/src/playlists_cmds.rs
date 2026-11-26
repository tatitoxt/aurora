//! Playlist commands: import/export, CRUD and track mutation of
//! .m3u/.m3u8 files in the music dir. Extracted from lib.rs — the
//! commands stay registered in the same invoke_handler.

use crate::{emit_queue, resolve_music_dir, AppState};
use tauri::State;

#[derive(serde::Serialize)]
pub(crate) struct ImportResult {
    pub(crate) imported: u32,
    pub(crate) remote: u32,
    pub(crate) missing: u32,
}

/// Parse a playlist file (.m3u/.m3u8/.pls/.xspf) and enqueue every local
/// track it lists. Remote URLs are counted, not dropped silently — the UI
/// reports them as needing provider support.
#[tauri::command]
pub(crate) fn import_playlist(
    app: tauri::AppHandle,
    state: State<AppState>,
    path: String,
) -> Result<ImportResult, String> {
    let file = std::path::PathBuf::from(&path);
    let content = std::fs::read_to_string(&file).map_err(|e| format!("read {path}: {e}"))?;
    let entries = noctbeat_core::playlists::parse(&file, &content);
    let mut player = state.player.lock().map_err(|e| e.to_string())?;
    let mut res = ImportResult {
        imported: 0,
        remote: 0,
        missing: 0,
    };
    for entry in entries {
        match entry {
            noctbeat_core::playlists::PlaylistEntry::File {
                path,
                title,
                artist,
                duration_ms,
            } => {
                if !path.is_file() {
                    res.missing += 1;
                    continue;
                }
                let name = path.to_string_lossy().into_owned();
                // Tag probing fills duration/artist/album the playlist lacks,
                // so imported tracks stay seekable.
                let mut track = noctbeat_core::library::tag_track(&path);
                track.id = name.clone();
                if let Some(t) = title {
                    track.title = t;
                }
                if let Some(a) = artist {
                    track.artist = a;
                }
                if let Some(d) = duration_ms {
                    track.duration_ms = d;
                }
                player.add(noctbeat_core::player::QueueItem { track, path: name });
                res.imported += 1;
            }
            noctbeat_core::playlists::PlaylistEntry::Remote(_) => res.remote += 1,
        }
    }
    drop(player);
    emit_queue(&app, &state);
    Ok(res)
}

/// Outcome of `export_playlist`: where the .m3u8 landed, how many local
/// tracks were written and how many remote items were skipped.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportResult {
    pub(crate) path: String,
    pub(crate) exported: u32,
    pub(crate) skipped_remote: u32,
}

/// `<dir>/<safe-stem>.m3u8` — the stem is reduced to filename-safe
/// chars; an existing file gets `-2`, `-3`, … appended.
pub(crate) fn unique_playlist_path(dir: &str, name: &str) -> std::path::PathBuf {
    let stem = std::path::Path::new(name.trim())
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("playlist");
    let stem: String = stem
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || " _-()".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let stem = if stem.is_empty() {
        "playlist"
    } else {
        stem.as_str()
    };
    let dir_path = std::path::Path::new(dir);
    let mut file = dir_path.join(format!("{stem}.m3u8"));
    let mut n = 2u32;
    while file.exists() {
        file = dir_path.join(format!("{stem}-{n}.m3u8"));
        n += 1;
    }
    file
}

/// Save the current queue as an extended M3U (`<music dir>/<name>.m3u8`).
/// `name` is reduced to a safe file stem; an existing file gets `-2`,
/// `-3`, … appended. Remote (not-yet-downloaded) items can't round-trip
/// through a local playlist and are skipped.
#[tauri::command]
pub(crate) fn export_playlist(state: State<AppState>, name: String) -> Result<ExportResult, String> {
    let dir = resolve_music_dir(&state, None)?;
    let file = unique_playlist_path(&dir, &name);
    let player = state.player.lock().map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    let mut skipped = 0u32;
    for it in player.queue() {
        if it.path.starts_with("remote:") {
            skipped += 1;
            continue;
        }
        // Playlists land in the music dir, but queue paths can be relative
        // to the launch cwd — anchor them absolute so reimport resolves
        // against the playlist's own directory-independent location.
        let path = match std::fs::canonicalize(&it.path) {
            Ok(p) => p.to_string_lossy().into_owned(),
            Err(_) => {
                let p = std::path::Path::new(&it.path);
                if p.is_absolute() {
                    it.path.clone()
                } else {
                    std::env::current_dir()
                        .map(|cwd| cwd.join(p).to_string_lossy().into_owned())
                        .unwrap_or_else(|_| it.path.clone())
                }
            }
        };
        items.push(noctbeat_core::playlists::M3uItem {
            path,
            title: it.track.title.clone(),
            artist: it.track.artist.clone(),
            duration_ms: it.track.duration_ms,
        });
    }
    if items.is_empty() {
        return Err("nothing to export — the queue has no local tracks".into());
    }
    let exported = items.len() as u32;
    std::fs::write(&file, noctbeat_core::playlists::write_m3u(&items))
        .map_err(|e| format!("write {}: {e}", file.display()))?;
    Ok(ExportResult {
        path: file.to_string_lossy().into_owned(),
        exported,
        skipped_remote: skipped,
    })
}

/// One playlist file discovered in the music folder.
#[derive(serde::Serialize)]
pub(crate) struct PlaylistFile {
    pub(crate) name: String,
    pub(crate) path: String,
}

/// Playlist files sitting at the top level of the configured music dir.
#[tauri::command]
pub(crate) fn list_playlists(state: State<AppState>) -> Result<Vec<PlaylistFile>, String> {
    let dir = resolve_music_dir(&state, None)?;
    Ok(noctbeat_core::playlists::list(std::path::Path::new(&dir))
        .into_iter()
        .map(|p| PlaylistFile {
            name: p
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| p.to_string_lossy().into_owned()),
            path: p.to_string_lossy().into_owned(),
        })
        .collect())
}

/// Create an empty playlist file (the rail's "+" button) — same naming
/// rules as `export_playlist`, which shares `unique_playlist_path`.
#[tauri::command]
pub(crate) fn create_playlist(state: State<AppState>, name: String) -> Result<PlaylistFile, String> {
    let dir = resolve_music_dir(&state, None)?;
    let file = unique_playlist_path(&dir, &name);
    std::fs::write(&file, "#EXTM3U\n")
        .map_err(|e| format!("write {}: {e}", file.display()))?;
    Ok(PlaylistFile {
        name: file
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| name.clone()),
        path: file.to_string_lossy().into_owned(),
    })
}

/// Guard for the playlist-management commands: resolve `path` (a
/// display string from `list_playlists`) back to the real discovered
/// file. Display names are lossy — non-UTF-8 bytes become `�` — so the
/// incoming string is only a lookup key, never a filesystem path: an
/// `a\xFF.m3u8` and a literal `a�.m3u8` collapse to the same display
/// string, and acting on the string could hit the wrong file. No match
/// or more than one → refuse; exactly one → act on the discovered
/// `PathBuf` (the real bytes).
pub(crate) fn playlist_path_checked(
    state: &State<AppState>,
    path: &str,
) -> Result<std::path::PathBuf, String> {
    let dir = resolve_music_dir(state, None)?;
    let matches: Vec<std::path::PathBuf> =
        noctbeat_core::playlists::list(std::path::Path::new(&dir))
            .into_iter()
            .filter(|p| p.to_string_lossy() == path)
            .collect();
    match matches.as_slice() {
        // Make it absolute without resolving links — `parse`'s base dir
        // must be absolute so relative entries don't double-prefix on
        // rewrite, but canonicalize would point delete/rename at the
        // symlink's target instead of the link itself.
        [one] => std::path::absolute(one).map_err(|e| e.to_string()),
        [] => Err("not a playlist in the music folder".into()),
        _ => Err("name isn't representable — rename it in a file manager first".into()),
    }
}

#[tauri::command]
pub(crate) fn delete_playlist(state: State<AppState>, path: String) -> Result<(), String> {
    let file = playlist_path_checked(&state, &path)?;
    std::fs::remove_file(&file).map_err(|e| e.to_string())
}

/// Rename keeps the original extension; the new file stays in the same
/// directory (the guard above) so only the stem changes.
#[tauri::command]
pub(crate) fn rename_playlist(
    state: State<AppState>,
    path: String,
    name: String,
) -> Result<PlaylistFile, String> {
    let file = playlist_path_checked(&state, &path)?;
    let name = name.trim();
    // `:` is banned on Windows only — `C:Name` parses drive-relative and
    // `:` isn't a valid filename char there anyway — while names like
    // "Live: 2025" are fine on Unix.
    if name.is_empty()
        || name.contains(['/', '\\'])
        || name.starts_with('.')
        || (cfg!(windows) && name.contains(':'))
    {
        return Err("invalid playlist name".into());
    }
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("m3u8");
    let target = file.with_file_name(format!("{name}.{ext}"));
    // Whatever the platform read into the name, the destination must
    // stay beside the original file.
    if target.parent() != file.parent() {
        return Err("invalid playlist name".into());
    }
    // symlink_metadata sees dangling links that Path::exists misses —
    // renaming onto one would silently replace it.
    if target.symlink_metadata().is_ok() {
        return Err("a playlist with that name already exists".into());
    }
    std::fs::rename(&file, &target).map_err(|e| e.to_string())?;
    Ok(PlaylistFile {
        name: name.to_string(),
        path: target.to_string_lossy().into_owned(),
    })
}

/// One row of a playlist opened for editing: display metadata, the
/// resolved path, and whether it is a remote stream URL.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaylistTrack {
    pub(crate) title: String,
    pub(crate) artist: String,
    pub(crate) duration_ms: u64,
    pub(crate) path: String,
    pub(crate) remote: bool,
}

/// Contents of a discovered playlist file, one row per entry, in order.
/// Remote URLs are included (marked `remote`) so a removal index always
/// lines up with what the file actually lists.
#[tauri::command]
pub(crate) fn playlist_tracks(state: State<AppState>, path: String) -> Result<Vec<PlaylistTrack>, String> {
    let file = playlist_path_checked(&state, &path)?;
    let content = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    Ok(noctbeat_core::playlists::parse(&file, &content)
        .iter()
        .map(|e| match e {
            noctbeat_core::playlists::PlaylistEntry::File {
                path,
                title,
                artist,
                duration_ms,
            } => PlaylistTrack {
                title: title.clone().unwrap_or_default(),
                artist: artist.clone().unwrap_or_default(),
                duration_ms: duration_ms.unwrap_or(0),
                path: path.to_string_lossy().into_owned(),
                remote: false,
            },
            noctbeat_core::playlists::PlaylistEntry::Remote(url) => PlaylistTrack {
                title: String::new(),
                artist: String::new(),
                duration_ms: 0,
                path: url.clone(),
                remote: true,
            },
        })
        .collect())
}

/// Editing rewrites the file as extended M3U, so only .m3u/.m3u8 are
/// writable; .pls and .xspf would lose their format (and metadata the
/// M3U serializer can't express).
pub(crate) fn m3u_editable(file: &std::path::Path) -> Result<(), String> {
    match file
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("m3u") | Some("m3u8") => Ok(()),
        _ => Err("editing works on .m3u/.m3u8 playlists".into()),
    }
}

/// Serialize entries back to `file` as extended M3U. Remote rows keep
/// their URL as the path (no metadata to preserve).
pub(crate) fn rewrite_playlist(
    file: &std::path::Path,
    entries: &[noctbeat_core::playlists::PlaylistEntry],
) -> Result<(), String> {
    let items: Vec<noctbeat_core::playlists::M3uItem> = entries
        .iter()
        .map(|e| match e {
            noctbeat_core::playlists::PlaylistEntry::File {
                path,
                title,
                artist,
                duration_ms,
            } => noctbeat_core::playlists::M3uItem {
                path: path.to_string_lossy().into_owned(),
                title: title.clone().unwrap_or_default(),
                artist: artist.clone().unwrap_or_default(),
                duration_ms: duration_ms.unwrap_or(0),
            },
            noctbeat_core::playlists::PlaylistEntry::Remote(url) => {
                noctbeat_core::playlists::M3uItem {
                    path: url.clone(),
                    title: String::new(),
                    artist: String::new(),
                    duration_ms: 0,
                }
            }
        })
        .collect();
    // Write-then-rename: a failed `write` (e.g. full disk) would leave
    // the original truncated, so stage the new content in a sibling
    // file and swap it in atomically. `create_new` (O_EXCL) picks a
    // name that cannot clobber an existing file — a fixed tmp name
    // could silently destroy an unrelated sibling.
    let body = noctbeat_core::playlists::write_m3u(&items);
    let stem = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "playlist".into());
    let mut tmp = None;
    for n in 0..100u32 {
        let candidate = file.with_file_name(format!(".{stem}.noctbeat-tmp{n}"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut f) => {
                use std::io::Write;
                if let Err(e) = f.write_all(body.as_bytes()) {
                    let _ = std::fs::remove_file(&candidate);
                    return Err(format!("write {}: {e}", candidate.display()));
                }
                tmp = Some(candidate);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("write {}: {e}", candidate.display())),
        }
    }
    let tmp = tmp.ok_or_else(|| "no free temp name beside the playlist".to_string())?;
    std::fs::rename(&tmp, file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("write {}: {e}", file.display())
    })
}

/// Drop the entry at `index` from a playlist and rewrite it in place.
/// The index counts every entry (files and remote rows) exactly as
/// `playlist_tracks` lists them.
#[tauri::command]
pub(crate) fn playlist_remove_track(state: State<AppState>, path: String, index: u32) -> Result<(), String> {
    let file = playlist_path_checked(&state, &path)?;
    m3u_editable(&file)?;
    let content = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let mut entries = noctbeat_core::playlists::parse(&file, &content);
    let i = index as usize;
    if i >= entries.len() {
        return Err("track index out of range".into());
    }
    entries.remove(i);
    rewrite_playlist(&file, &entries)
}

/// Move the entry at `from` to position `to` and rewrite the playlist.
/// Indexes count every entry exactly as `playlist_tracks` lists them.
#[tauri::command]
pub(crate) fn playlist_move_track(
    state: State<AppState>,
    path: String,
    from: u32,
    to: u32,
) -> Result<(), String> {
    let file = playlist_path_checked(&state, &path)?;
    m3u_editable(&file)?;
    let content = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let mut entries = noctbeat_core::playlists::parse(&file, &content);
    let (f, t) = (from as usize, to as usize);
    if f >= entries.len() || t >= entries.len() {
        return Err("track index out of range".into());
    }
    if f != t {
        let e = entries.remove(f);
        entries.insert(t, e);
    }
    rewrite_playlist(&file, &entries)
}

/// Append local files to a playlist and rewrite it. Returns how many
/// entries were added — paths that aren't real files are skipped (a
/// stale queue item or a `remote:` pseudo-path must not land in the
/// file, where it would import back as a broken row).
#[tauri::command]
pub(crate) fn playlist_add_tracks(
    state: State<AppState>,
    path: String,
    paths: Vec<String>,
) -> Result<u32, String> {
    let file = playlist_path_checked(&state, &path)?;
    m3u_editable(&file)?;
    let content = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let mut entries = noctbeat_core::playlists::parse(&file, &content);
    let mut added = 0u32;
    for p in paths {
        // Same anchoring as export: relative queue paths resolve against
        // the launch cwd so the row imports back correctly later.
        let abs = match std::fs::canonicalize(&p) {
            Ok(c) => c,
            Err(_) => {
                let rel = std::path::Path::new(&p);
                if rel.is_absolute() {
                    rel.to_path_buf()
                } else {
                    match std::env::current_dir() {
                        Ok(cwd) => cwd.join(rel),
                        Err(_) => continue,
                    }
                }
            }
        };
        if !abs.is_file() {
            continue;
        }
        let track = noctbeat_core::library::tag_track(&abs);
        entries.push(noctbeat_core::playlists::PlaylistEntry::File {
            path: abs,
            title: (!track.title.is_empty()).then_some(track.title),
            artist: (!track.artist.is_empty()).then_some(track.artist),
            duration_ms: (track.duration_ms > 0).then_some(track.duration_ms),
        });
        added += 1;
    }
    if added == 0 {
        return Err("no local files to add".into());
    }
    rewrite_playlist(&file, &entries)?;
    Ok(added)
}
