//! Listening history: persisted play records and aggregate stats.
//!
//! The shell feeds one `PlayRecord` per track once it counts as a play
//! (30 s heard, or the whole track when it is shorter). Records live in a
//! JSON file beside settings.json — corrupt-proof, capped, atomic writes.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io;
use std::path::Path;

/// Oldest records are dropped past this cap — a lifetime of plays never
/// grows the file unboundedly.
const MAX_RECORDS: usize = 5_000;
/// Wall-clock ms that counts a listen as a play (Spotify uses the same
/// threshold). Tracks shorter than this count in full.
pub const MIN_PLAY_MS: u64 = 30_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayRecord {
    pub track_id: String,
    pub title: String,
    pub artist: String,
    /// "local", "mpris", "demo", ... — where playback came from.
    pub source: String,
    pub duration_ms: u64,
    pub ms_listened: u64,
    /// Unix ms when the track started playing.
    pub played_at_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub records: Vec<PlayRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopEntry {
    pub name: String,
    /// Track artist; empty for artist entries.
    pub sub: String,
    pub plays: u64,
    pub ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayStat {
    /// "YYYY-MM-DD" (UTC).
    pub date: String,
    pub plays: u64,
    pub ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Wrapped {
    /// Calendar month the recap covers, "YYYY-MM".
    pub month: String,
    pub total_ms: u64,
    pub plays: u64,
    pub unique_tracks: u64,
    pub unique_artists: u64,
    /// Consecutive days with at least one play ending at the month's last
    /// listened day (or its last day).
    pub streak_days: u64,
    /// Most listened calendar day in the month.
    pub best_day: Option<DayStat>,
    pub top_tracks: Vec<TopEntry>,
    pub top_artists: Vec<TopEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistStats {
    pub artist: String,
    pub plays: u64,
    pub total_ms: u64,
    /// The artist's tracks ranked by plays (untruncated).
    pub tracks: Vec<TopEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub total_ms: u64,
    pub plays: u64,
    pub top_tracks: Vec<TopEntry>,
    pub top_artists: Vec<TopEntry>,
    /// One row per day ending today, oldest first.
    pub days: Vec<DayStat>,
}

/// `ms_listened` needed for a play to count.
pub fn play_threshold_ms(duration_ms: u64) -> u64 {
    if duration_ms == 0 {
        MIN_PLAY_MS
    } else {
        duration_ms.min(MIN_PLAY_MS)
    }
}

impl History {
    pub fn load(path: &Path) -> Self {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Self::default();
        };
        serde_json::from_str(&text).unwrap_or_default()
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

    pub fn record(&mut self, r: PlayRecord) {
        self.records.push(r);
        if self.records.len() > MAX_RECORDS {
            let drop = self.records.len() - MAX_RECORDS;
            self.records.drain(..drop);
        }
    }

    /// Aggregate: totals, top tracks/artists, and a `days`-long daily
    /// activity strip ending today.
    pub fn stats(&self, days: usize, now_ms: u64) -> Stats {
        let mut plays = 0u64;
        let mut total_ms = 0u64;
        let mut tracks: BTreeMap<(String, String), (u64, u64)> = BTreeMap::new();
        let mut artists: BTreeMap<String, (u64, u64)> = BTreeMap::new();
        let today = now_ms / 86_400_000;
        let mut by_day: BTreeMap<u64, (u64, u64)> = BTreeMap::new();
        for r in &self.records {
            plays += 1;
            total_ms += r.ms_listened;
            let e = tracks
                .entry((r.title.clone(), r.artist.clone()))
                .or_default();
            e.0 += 1;
            e.1 += r.ms_listened;
            if !r.artist.is_empty() {
                let a = artists.entry(r.artist.clone()).or_default();
                a.0 += 1;
                a.1 += r.ms_listened;
            }
            let d = r.played_at_ms / 86_400_000;
            if d + days as u64 > today {
                let e = by_day.entry(d).or_default();
                e.0 += 1;
                e.1 += r.ms_listened;
            }
        }
        let mut top_tracks: Vec<TopEntry> = tracks
            .into_iter()
            .map(|((title, artist), (plays, ms))| TopEntry {
                name: title,
                sub: artist,
                plays,
                ms,
            })
            .collect();
        top_tracks.sort_by(|a, b| b.plays.cmp(&a.plays).then(b.ms.cmp(&a.ms)));
        top_tracks.truncate(10);
        let mut top_artists: Vec<TopEntry> = artists
            .into_iter()
            .map(|(name, (plays, ms))| TopEntry {
                name,
                sub: String::new(),
                plays,
                ms,
            })
            .collect();
        top_artists.sort_by(|a, b| b.plays.cmp(&a.plays).then(b.ms.cmp(&a.ms)));
        top_artists.truncate(10);
        let first = today + 1 - days as u64;
        let days: Vec<DayStat> = (first..=today)
            .map(|d| {
                let (plays, ms) = by_day.get(&d).copied().unwrap_or((0, 0));
                DayStat {
                    date: civil_date(d),
                    plays,
                    ms,
                }
            })
            .collect();
        Stats {
            total_ms,
            plays,
            top_tracks,
            top_artists,
            days,
        }
    }

    /// Per-artist totals plus that artist's tracks ranked by plays —
    /// untruncated, unlike `stats`' global top-10 lists.
    pub fn artist_stats(&self, artist: &str) -> ArtistStats {
        let mut plays = 0u64;
        let mut total_ms = 0u64;
        let mut tracks: BTreeMap<String, (u64, u64)> = BTreeMap::new();
        for r in &self.records {
            if !r.artist.eq_ignore_ascii_case(artist) {
                continue;
            }
            plays += 1;
            total_ms += r.ms_listened;
            let e = tracks.entry(r.title.clone()).or_default();
            e.0 += 1;
            e.1 += r.ms_listened;
        }
        let mut top: Vec<TopEntry> = tracks
            .into_iter()
            .map(|(name, (plays, ms))| TopEntry {
                name,
                sub: artist.to_string(),
                plays,
                ms,
            })
            .collect();
        top.sort_by(|a, b| b.plays.cmp(&a.plays).then(b.ms.cmp(&a.ms)));
        ArtistStats {
            artist: artist.to_string(),
            plays,
            total_ms,
            tracks: top,
        }
    }

    /// Monthly recap for the calendar month containing `now_ms` (UTC):
    /// totals, uniques, listening streak, best day and top-5 lists.
    pub fn wrapped(&self, now_ms: u64) -> Wrapped {
        let month = civil_date(now_ms / 86_400_000)[..7].to_string();
        let mut plays = 0u64;
        let mut total_ms = 0u64;
        let mut track_ids = std::collections::HashSet::new();
        let mut artist_names = std::collections::HashSet::new();
        let mut tracks: BTreeMap<(String, String), (u64, u64)> = BTreeMap::new();
        let mut artists: BTreeMap<String, (u64, u64)> = BTreeMap::new();
        let mut by_day: BTreeMap<u64, (u64, u64)> = BTreeMap::new();
        for r in &self.records {
            let d = r.played_at_ms / 86_400_000;
            if !civil_date(d).starts_with(&month) {
                continue;
            }
            plays += 1;
            total_ms += r.ms_listened;
            track_ids.insert(r.track_id.clone());
            if !r.artist.is_empty() {
                artist_names.insert(r.artist.clone());
            }
            let e = tracks
                .entry((r.title.clone(), r.artist.clone()))
                .or_default();
            e.0 += 1;
            e.1 += r.ms_listened;
            if !r.artist.is_empty() {
                let a = artists.entry(r.artist.clone()).or_default();
                a.0 += 1;
                a.1 += r.ms_listened;
            }
            let e = by_day.entry(d).or_default();
            e.0 += 1;
            e.1 += r.ms_listened;
        }
        let mut streak_days = 0u64;
        if let Some(&last) = by_day.keys().next_back() {
            let mut d = last;
            while by_day.contains_key(&d) {
                streak_days += 1;
                if d == 0 {
                    break;
                }
                d -= 1;
            }
        }
        let best_day = by_day
            .iter()
            .max_by_key(|(_, (plays, ms))| (*plays, *ms))
            .map(|(d, (plays, ms))| DayStat {
                date: civil_date(*d),
                plays: *plays,
                ms: *ms,
            });
        let mut top_tracks: Vec<TopEntry> = tracks
            .into_iter()
            .map(|((title, artist), (plays, ms))| TopEntry {
                name: title,
                sub: artist,
                plays,
                ms,
            })
            .collect();
        top_tracks.sort_by(|a, b| b.plays.cmp(&a.plays).then(b.ms.cmp(&a.ms)));
        top_tracks.truncate(5);
        let mut top_artists: Vec<TopEntry> = artists
            .into_iter()
            .map(|(name, (plays, ms))| TopEntry {
                name,
                sub: String::new(),
                plays,
                ms,
            })
            .collect();
        top_artists.sort_by(|a, b| b.plays.cmp(&a.plays).then(b.ms.cmp(&a.ms)));
        top_artists.truncate(5);
        Wrapped {
            month,
            total_ms,
            plays,
            unique_tracks: track_ids.len() as u64,
            unique_artists: artist_names.len() as u64,
            streak_days,
            best_day,
            top_tracks,
            top_artists,
        }
    }
}

/// Days since the Unix epoch → "YYYY-MM-DD" (Hinnant's civil algorithm).
fn civil_date(z: u64) -> String {
    let z = z as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: &str, title: &str, artist: &str, ms: u64, at_ms: u64) -> PlayRecord {
        PlayRecord {
            track_id: id.into(),
            title: title.into(),
            artist: artist.into(),
            source: "local".into(),
            duration_ms: 200_000,
            ms_listened: ms,
            played_at_ms: at_ms,
        }
    }

    #[test]
    fn threshold_full_track_when_short() {
        assert_eq!(play_threshold_ms(0), 30_000);
        assert_eq!(play_threshold_ms(20_000), 20_000);
        assert_eq!(play_threshold_ms(240_000), 30_000);
    }

    #[test]
    fn civil_dates() {
        assert_eq!(civil_date(0), "1970-01-01");
        assert_eq!(civil_date(20_439), "2025-12-17");
        assert_eq!(civil_date(20_454), "2026-01-01");
        assert_eq!(civil_date(20_470), "2026-01-17");
    }

    #[test]
    fn aggregates_top_entries_and_days() {
        let day = 20_470 * 86_400_000;
        let mut h = History::default();
        for _ in 0..3 {
            h.record(rec("a", "Song A", "Artist X", 150_000, day));
        }
        h.record(rec("b", "Song B", "Artist Y", 90_000, day + 1000));
        h.record(rec("a", "Song A", "Artist X", 200_000, day - 86_400_000));
        // Far outside the 2-day window: excluded from `days` but still in totals.
        h.record(rec(
            "c",
            "Song C",
            "Artist Z",
            50_000,
            day - 20 * 86_400_000,
        ));
        let s = h.stats(2, day);
        assert_eq!(s.plays, 6);
        assert_eq!(s.top_tracks[0].name, "Song A");
        assert_eq!(s.top_tracks[0].plays, 4);
        assert_eq!(s.top_tracks[0].ms, 650_000);
        assert_eq!(s.top_artists[0].name, "Artist X");
        assert_eq!(s.days.len(), 2);
        assert_eq!(s.days[1].plays, 4);
        assert_eq!(s.days[0].plays, 1);
    }

    #[test]
    fn wrapped_counts_month_uniques_and_streak() {
        let day = |d: i64| (20_470 + d) as u64 * 86_400_000; // 2026-01-17 +d
        let mut h = History::default();
        // 3-day streak: Jan 15, 16, 17; a play on Jan 10 breaks it.
        h.record(rec("a", "Song A", "Artist X", 100_000, day(-2)));
        h.record(rec("b", "Song B", "Artist Y", 200_000, day(-1)));
        h.record(rec("a", "Song A", "Artist X", 150_000, day(0)));
        h.record(rec("a", "Song A", "Artist X", 150_000, day(0) + 500));
        h.record(rec("c", "Song C", "Artist Z", 50_000, day(-7)));
        // December: excluded.
        h.record(rec("d", "Song D", "Artist W", 999_000, day(-20)));
        let w = h.wrapped(day(0));
        assert_eq!(w.month, "2026-01");
        assert_eq!(w.plays, 5);
        assert_eq!(w.total_ms, 650_000);
        assert_eq!(w.unique_tracks, 3);
        assert_eq!(w.unique_artists, 3);
        assert_eq!(w.streak_days, 3);
        assert_eq!(w.best_day.as_ref().unwrap().date, "2026-01-17");
        assert_eq!(w.top_tracks[0].name, "Song A");
        assert_eq!(w.top_tracks[0].plays, 3);
        assert_eq!(w.top_artists[0].name, "Artist X");
        assert!(w.top_tracks.iter().all(|t| t.name != "Song D"));
    }

    #[test]
    fn artist_stats_is_per_artist_and_untruncated() {
        let day = 20_470 * 86_400_000;
        let mut h = History::default();
        // 15 tracks by Artist X — past stats()' top-10 truncation.
        for i in 0..15 {
            h.record(rec(
                &format!("x{i}"),
                &format!("Song {i:02}"),
                "Artist X",
                100_000 + i as u64,
                day,
            ));
        }
        h.record(rec("y", "Other", "Artist Y", 500_000, day));
        // Case-insensitive match.
        h.record(rec("z", "Case", "artist x", 60_000, day));
        let s = h.artist_stats("Artist X");
        assert_eq!(s.plays, 16);
        assert_eq!(s.tracks.len(), 16);
        assert_eq!(s.tracks[0].plays, 1);
        assert!(s.tracks.iter().all(|t| t.sub == "Artist X"));
        assert!(h.artist_stats("Nobody").tracks.is_empty());
    }

    #[test]
    fn wrapped_empty_month_is_zero() {
        let h = History::default();
        let w = h.wrapped(20_470 * 86_400_000);
        assert_eq!(w.plays, 0);
        assert_eq!(w.streak_days, 0);
        assert!(w.best_day.is_none());
        assert!(w.top_tracks.is_empty());
    }

    #[test]
    fn record_cap_drops_oldest() {
        let mut h = History::default();
        for i in 0..MAX_RECORDS + 5 {
            h.record(rec(&format!("{i}"), "T", "A", 1, i as u64));
        }
        assert_eq!(h.records.len(), MAX_RECORDS);
        assert_eq!(h.records[0].track_id, "5");
    }

    #[test]
    fn corrupt_file_is_empty_history() {
        let p = std::env::temp_dir().join(format!("noctbeat-hist-{}", std::process::id()));
        std::fs::write(&p, "{nope").unwrap();
        assert_eq!(History::load(&p), History::default());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn roundtrip() {
        let p = std::env::temp_dir().join(format!("noctbeat-hist2-{}", std::process::id()));
        let mut h = History::default();
        h.record(rec("a", "Song A", "Artist X", 100, 42));
        h.save(&p).unwrap();
        assert_eq!(History::load(&p), h);
        let _ = std::fs::remove_file(&p);
    }
}
