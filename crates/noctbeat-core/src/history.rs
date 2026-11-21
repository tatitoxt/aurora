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
