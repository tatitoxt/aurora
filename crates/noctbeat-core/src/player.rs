//! Local playback engine: a queue of real audio files behind the same
//! `NowPlayingSource` interface as external players. Audio output is behind
//! the `AudioOut` trait so this module stays headless and unit-testable;
//! the Tauri shell provides a rodio implementation.

use crate::media::{
    now_ms, Control, MediaError, NowPlaying, NowPlayingSource, PlaybackStatus, Track,
};

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub track: Track,
    /// Absolute path on disk. Empty for tracks resolved on demand (e.g. streams).
    pub path: String,
}

/// Audio device abstraction. Implementations must keep their own position
/// clock; `position_ms` is monotonic within the current `open` call.
pub trait AudioOut: Send + Sync {
    /// Open a file for playback; returns its duration in ms when known.
    fn open(&self, path: &str) -> Result<Option<u64>, String>;
    fn play(&self);
    fn pause(&self);
    fn position_ms(&self) -> u64;
    fn seek(&self, position_ms: u64) -> Result<(), String>;
    fn set_volume(&self, volume: f32);
    /// True once the current file has finished playing.
    fn is_finished(&self) -> bool;
}

/// Queue repeat behaviour: `Off` stops at the end, `All` wraps to the
/// first item, `One` replays the current item when it finishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepeatMode {
    Off,
    All,
    One,
}

/// A silent `AudioOut` for tests and platforms without a device yet.
pub struct NullAudio {
    position_ms: std::sync::atomic::AtomicU64,
    playing: std::sync::atomic::AtomicBool,
    anchor_ms: std::sync::atomic::AtomicU64,
    duration_ms: std::sync::atomic::AtomicU64,
}

impl Default for NullAudio {
    fn default() -> Self {
        Self::new()
    }
}

impl NullAudio {
    pub fn new() -> Self {
        Self {
            position_ms: 0.into(),
            playing: false.into(),
            anchor_ms: now_ms().into(),
            duration_ms: 0.into(),
        }
    }
}

impl AudioOut for NullAudio {
    fn open(&self, _path: &str) -> Result<Option<u64>, String> {
        self.position_ms
            .store(0, std::sync::atomic::Ordering::SeqCst);
        self.playing
            .store(false, std::sync::atomic::Ordering::SeqCst);
        Ok(None)
    }
    fn play(&self) {
        self.anchor_ms.store(
            now_ms() - self.position_ms.load(std::sync::atomic::Ordering::SeqCst),
            std::sync::atomic::Ordering::SeqCst,
        );
        self.playing
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    fn pause(&self) {
        self.position_ms
            .store(self.position_ms(), std::sync::atomic::Ordering::SeqCst);
        self.playing
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
    fn position_ms(&self) -> u64 {
        if self.playing.load(std::sync::atomic::Ordering::SeqCst) {
            now_ms() - self.anchor_ms.load(std::sync::atomic::Ordering::SeqCst)
        } else {
            self.position_ms.load(std::sync::atomic::Ordering::SeqCst)
        }
    }
    fn seek(&self, position_ms: u64) -> Result<(), String> {
        self.position_ms
            .store(position_ms, std::sync::atomic::Ordering::SeqCst);
        if self.playing.load(std::sync::atomic::Ordering::SeqCst) {
            self.anchor_ms
                .store(now_ms() - position_ms, std::sync::atomic::Ordering::SeqCst);
        }
        Ok(())
    }
    fn set_volume(&self, _volume: f32) {}
    fn is_finished(&self) -> bool {
        let dur = self.duration_ms.load(std::sync::atomic::Ordering::SeqCst);
        dur > 0 && self.position_ms() >= dur
    }
}

/// Turns a queue item into a playable file path — e.g. resolves a
/// `remote:` pseudo-path into a downloaded stream file. Err aborts the
/// play; the item stays queued for a retry.
pub type PathResolver = Box<dyn Fn(&QueueItem) -> Result<String, String> + Send + Sync>;

/// Player state machine: queue + transport, delegating I/O to `AudioOut`.
pub struct LocalPlayer {
    audio: std::sync::Arc<dyn AudioOut>,
    queue: Vec<QueueItem>,
    index: Option<usize>,
    status: PlaybackStatus,
    resolver: Option<PathResolver>,
    shuffle: bool,
    repeat: RepeatMode,
    volume: f32,
    /// xorshift64 state for shuffle picks — avoids pulling in `rand`
    /// for one call site.
    rng: u64,
}

impl LocalPlayer {
    pub fn new(audio: std::sync::Arc<dyn AudioOut>) -> Self {
        Self {
            audio,
            queue: Vec::new(),
            index: None,
            status: PlaybackStatus::Stopped,
            resolver: None,
            shuffle: false,
            repeat: RepeatMode::Off,
            volume: 1.0,
            rng: now_ms() | 1,
        }
    }

    pub fn set_shuffle(&mut self, on: bool) {
        self.shuffle = on;
    }

    pub fn shuffle(&self) -> bool {
        self.shuffle
    }

    pub fn set_repeat(&mut self, mode: RepeatMode) {
        self.repeat = mode;
    }

    pub fn repeat(&self) -> RepeatMode {
        self.repeat
    }

    pub fn volume(&self) -> f32 {
        self.volume
    }

    /// Next queue index under shuffle: any slot except the current one.
    fn shuffled_index(&mut self) -> usize {
        // xorshift64*
        self.rng ^= self.rng >> 12;
        self.rng ^= self.rng << 25;
        self.rng ^= self.rng >> 27;
        let r = (self.rng.wrapping_mul(0x2545F4914F6CDD1D) >> 32) as usize;
        let n = self.queue.len();
        let pick = r % n;
        if Some(pick) == self.index && n > 1 {
            (pick + 1) % n
        } else {
            pick
        }
    }

    /// Install a resolver consulted every time an item is opened — play,
    /// auto-advance and device-swap reopen alike. Without one the item's
    /// own `path` is used verbatim.
    pub fn set_resolver(&mut self, resolver: PathResolver) {
        self.resolver = Some(resolver);
    }

    /// The on-disk path `audio` should open for `item`.
    fn item_path(&self, item: &QueueItem) -> Result<String, String> {
        match &self.resolver {
            Some(r) => r(item),
            None => Ok(item.path.clone()),
        }
    }

    pub fn queue(&self) -> &[QueueItem] {
        &self.queue
    }

    pub fn current_index(&self) -> Option<usize> {
        self.index
    }

    pub fn status(&self) -> PlaybackStatus {
        self.status
    }

    pub fn set_queue(&mut self, items: Vec<QueueItem>) {
        // Stop any in-flight playback first: otherwise the old track keeps
        // sounding while the player reports Stopped.
        self.audio.pause();
        self.queue = items;
        self.index = None;
        self.status = PlaybackStatus::Stopped;
    }

    pub fn add(&mut self, item: QueueItem) {
        self.queue.push(item);
    }

    pub fn clear(&mut self) {
        self.audio.pause();
        self.queue.clear();
        self.index = None;
        self.status = PlaybackStatus::Stopped;
    }

    /// Load and start the queue item at `index`.
    pub fn play_index(&mut self, index: usize) -> Result<(), String> {
        let item = self
            .queue
            .get(index)
            .cloned()
            .ok_or_else(|| format!("no item at index {index}"))?;
        let path = self.item_path(&item)?;
        self.audio.open(&path)?;
        self.audio.play();
        self.index = Some(index);
        self.status = PlaybackStatus::Playing;
        Ok(())
    }

    pub fn seek(&self, position_ms: u64) -> Result<(), String> {
        self.audio.seek(position_ms)
    }

    /// Snapshot `(position_ms, was_playing)` of the current track. Must be
    /// taken before the audio stream is swapped — after `set_device` the new
    /// stream reports position 0.
    pub fn reopen_snapshot(&self) -> (u64, bool) {
        (
            self.audio.position_ms(),
            self.status == PlaybackStatus::Playing,
        )
    }

    /// Re-open the current track at `position_ms` after the output device
    /// was swapped. Resumes playback only when `playing` is true. Callers
    /// hold the player lock across the swap so the poller never observes
    /// the empty stream.
    pub fn reopen_current(&mut self, position_ms: u64, playing: bool) -> Result<(), String> {
        let Some(i) = self.index else { return Ok(()) };
        let Some(item) = self.queue.get(i).cloned() else {
            return Ok(());
        };
        if item.path.is_empty() {
            return Ok(());
        }
        let path = self.item_path(&item)?;
        self.audio.open(&path)?;
        self.audio.seek(position_ms)?;
        if playing {
            self.audio.play();
        }
        Ok(())
    }

    pub fn set_volume(&mut self, volume: f32) {
        self.volume = volume.clamp(0.0, 1.0);
        self.audio.set_volume(self.volume);
    }

    fn advance(&mut self, dir: i64) -> Result<(), String> {
        let Some(i) = self.index else {
            if self.queue.is_empty() {
                return Err("empty queue".into());
            }
            return self.play_index(0);
        };
        if dir == 1 && self.shuffle && self.queue.len() > 1 {
            let pick = self.shuffled_index();
            return self.play_index(pick);
        }
        let next = i as i64 + dir;
        if next < 0 || next as usize >= self.queue.len() {
            if dir == 1 && self.repeat == RepeatMode::All && !self.queue.is_empty() {
                return self.play_index(0);
            }
            return Err("end of queue".into());
        }
        self.play_index(next as usize)
    }

    /// Poll that also advances the queue when a track finished.
    pub fn tick(&mut self) -> NowPlaying {
        if self.status == PlaybackStatus::Playing && self.audio.is_finished() {
            if self.repeat == RepeatMode::One {
                if let Some(i) = self.index {
                    if self.play_index(i).is_err() {
                        self.status = PlaybackStatus::Stopped;
                    }
                }
            } else {
                let _ = self.advance(1).map_err(|_| {
                    self.status = PlaybackStatus::Stopped;
                });
            }
        }
        self.snapshot()
    }

    fn snapshot(&self) -> NowPlaying {
        NowPlaying {
            track: self
                .index
                .and_then(|i| self.queue.get(i))
                .map(|q| q.track.clone()),
            status: self.status,
            position_ms: self.audio.position_ms(),
            source: "local".into(),
            updated_at_ms: now_ms(),
        }
    }
}

impl NowPlayingSource for LocalPlayer {
    fn name(&self) -> &'static str {
        "local"
    }
    fn poll(&mut self) -> Result<NowPlaying, MediaError> {
        Ok(self.tick())
    }
    fn control(&mut self, cmd: Control) -> Result<(), MediaError> {
        match cmd {
            Control::PlayPause => match self.status {
                PlaybackStatus::Playing => {
                    self.audio.pause();
                    self.status = PlaybackStatus::Paused;
                    Ok(())
                }
                PlaybackStatus::Paused => {
                    self.audio.play();
                    self.status = PlaybackStatus::Playing;
                    Ok(())
                }
                PlaybackStatus::Stopped => self
                    .play_index(self.index.unwrap_or(0))
                    .map_err(MediaError::Control),
            },
            Control::Next => self
                .advance(1)
                .map_err(|e| MediaError::Control(e.to_string())),
            Control::Previous => {
                // Convention: >3s in, restart the track; else go back.
                if self.audio.position_ms() > 3_000 {
                    self.audio.seek(0).map_err(MediaError::Control)
                } else {
                    self.advance(-1)
                        .map_err(|e| MediaError::Control(e.to_string()))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    fn item(title: &str) -> QueueItem {
        QueueItem {
            track: Track {
                id: title.into(),
                title: title.into(),
                artist: "A".into(),
                album: "B".into(),
                artwork_url: String::new(),
                duration_ms: 60_000,
            },
            path: format!("/music/{title}.mp3"),
        }
    }

    struct FakeAudio {
        pos: AtomicU64,
        playing: std::sync::atomic::AtomicBool,
        finished: std::sync::atomic::AtomicBool,
        opened: std::sync::Mutex<Vec<String>>,
    }
    impl FakeAudio {
        fn new() -> Self {
            Self {
                pos: 0.into(),
                playing: false.into(),
                finished: false.into(),
                opened: vec![].into(),
            }
        }
    }
    impl AudioOut for FakeAudio {
        fn open(&self, path: &str) -> Result<Option<u64>, String> {
            self.opened.lock().unwrap().push(path.into());
            self.pos.store(0, Ordering::SeqCst);
            self.finished.store(false, Ordering::SeqCst);
            Ok(Some(60_000))
        }
        fn play(&self) {
            self.playing.store(true, Ordering::SeqCst);
        }
        fn pause(&self) {
            self.playing.store(false, Ordering::SeqCst);
        }
        fn position_ms(&self) -> u64 {
            self.pos.load(Ordering::SeqCst)
        }
        fn seek(&self, p: u64) -> Result<(), String> {
            self.pos.store(p, Ordering::SeqCst);
            Ok(())
        }
        fn set_volume(&self, _v: f32) {}
        fn is_finished(&self) -> bool {
            self.finished.load(Ordering::SeqCst)
        }
    }

    fn player() -> (LocalPlayer, Arc<FakeAudio>) {
        let audio = Arc::new(FakeAudio::new());
        (LocalPlayer::new(audio.clone()), audio)
    }

    #[test]
    fn empty_queue_reports_stopped() {
        let (mut p, _) = player();
        let np = p.tick();
        assert_eq!(np.status, PlaybackStatus::Stopped);
        assert!(np.track.is_none());
    }

    #[test]
    fn play_index_opens_file_and_reports_track() {
        let (mut p, audio) = player();
        p.set_queue(vec![item("one"), item("two")]);
        p.play_index(1).unwrap();
        assert_eq!(audio.opened.lock().unwrap()[0], "/music/two.mp3");
        let np = p.tick();
        assert_eq!(np.status, PlaybackStatus::Playing);
        assert_eq!(np.track.unwrap().title, "two");
    }

    #[test]
    fn play_index_out_of_range_errors() {
        let (mut p, _) = player();
        p.set_queue(vec![item("one")]);
        assert!(p.play_index(5).is_err());
    }

    #[test]
    fn play_pause_toggles() {
        let (mut p, audio) = player();
        p.set_queue(vec![item("one")]);
        p.play_index(0).unwrap();
        p.control(Control::PlayPause).unwrap();
        assert!(!audio.playing.load(Ordering::SeqCst));
        assert_eq!(p.tick().status, PlaybackStatus::Paused);
        p.control(Control::PlayPause).unwrap();
        assert!(audio.playing.load(Ordering::SeqCst));
    }

    #[test]
    fn next_and_previous_walk_the_queue() {
        let (mut p, _) = player();
        p.set_queue(vec![item("a"), item("b"), item("c")]);
        p.play_index(0).unwrap();
        p.control(Control::Next).unwrap();
        assert_eq!(p.tick().track.unwrap().title, "b");
        p.control(Control::Next).unwrap();
        assert_eq!(p.tick().track.unwrap().title, "c");
        assert!(p.control(Control::Next).is_err()); // end of queue
                                                    // Previous within 3s boundary: position 0 → go to previous track.
        p.control(Control::Previous).unwrap();
        assert_eq!(p.tick().track.unwrap().title, "b");
    }

    #[test]
    fn shuffle_advances_to_valid_varied_indices() {
        let (mut p, _) = player();
        p.set_queue(vec![item("a"), item("b"), item("c"), item("d"), item("e")]);
        p.play_index(0).unwrap();
        p.set_shuffle(true);
        let mut seen = std::collections::HashSet::new();
        for _ in 0..30 {
            p.control(Control::Next).unwrap();
            let i = p.current_index().unwrap();
            assert!(i < 5);
            seen.insert(i);
        }
        assert!(seen.len() > 1, "shuffle should visit more than one track");
    }

    #[test]
    fn previous_restarts_track_when_past_3s() {
        let (mut p, audio) = player();
        p.set_queue(vec![item("a"), item("b")]);
        p.play_index(1).unwrap();
        audio.pos.store(10_000, Ordering::SeqCst);
        p.control(Control::Previous).unwrap();
        assert_eq!(audio.position_ms(), 0);
        assert_eq!(p.tick().track.unwrap().title, "b");
    }

    #[test]
    fn finished_track_auto_advances() {
        let (mut p, audio) = player();
        p.set_queue(vec![item("a"), item("b")]);
        p.play_index(0).unwrap();
        audio.finished.store(true, Ordering::SeqCst);
        let np = p.tick();
        assert_eq!(np.track.unwrap().title, "b");
        assert_eq!(np.status, PlaybackStatus::Playing);
    }

    #[test]
    fn finished_last_track_stops() {
        let (mut p, audio) = player();
        p.set_queue(vec![item("a")]);
        p.play_index(0).unwrap();
        audio.finished.store(true, Ordering::SeqCst);
        assert_eq!(p.tick().status, PlaybackStatus::Stopped);
    }

    #[test]
    fn repeat_one_replays_finished_track() {
        let (mut p, audio) = player();
        p.set_queue(vec![item("a"), item("b")]);
        p.set_repeat(RepeatMode::One);
        p.play_index(0).unwrap();
        audio.finished.store(true, Ordering::SeqCst);
        let np = p.tick();
        assert_eq!(np.track.unwrap().title, "a");
        assert_eq!(np.status, PlaybackStatus::Playing);
        // Re-opened from the top.
        assert_eq!(audio.opened.lock().unwrap().len(), 2);
    }

    #[test]
    fn repeat_all_wraps_next_and_finish() {
        let (mut p, audio) = player();
        p.set_queue(vec![item("a"), item("b")]);
        p.set_repeat(RepeatMode::All);
        p.play_index(1).unwrap();
        // Manual next wraps to the head.
        p.control(Control::Next).unwrap();
        assert_eq!(p.tick().track.unwrap().title, "a");
        // Finishing the last track wraps too.
        p.play_index(1).unwrap();
        audio.finished.store(true, Ordering::SeqCst);
        assert_eq!(p.tick().track.unwrap().title, "a");
    }

    #[test]
    fn volume_is_tracked_and_clamped() {
        let (mut p, _) = player();
        p.set_volume(0.4);
        assert_eq!(p.volume(), 0.4);
        p.set_volume(7.0);
        assert_eq!(p.volume(), 1.0);
    }

    #[test]
    fn clear_stops_and_empties() {
        let (mut p, _) = player();
        p.set_queue(vec![item("a")]);
        p.play_index(0).unwrap();
        p.clear();
        assert!(p.queue().is_empty());
        assert_eq!(p.tick().status, PlaybackStatus::Stopped);
    }

    #[test]
    fn reopen_current_resumes_at_position() {
        let (mut p, audio) = player();
        p.set_queue(vec![item("a"), item("b")]);
        p.play_index(1).unwrap();
        audio.pos.store(12_000, Ordering::SeqCst);
        let (pos, playing) = p.reopen_snapshot();
        p.reopen_current(pos, playing).unwrap();
        assert_eq!(audio.opened.lock().unwrap().last().unwrap(), "/music/b.mp3");
        assert_eq!(audio.position_ms(), 12_000);
        assert!(audio.playing.load(Ordering::SeqCst));
        assert_eq!(p.tick().status, PlaybackStatus::Playing);
    }

    #[test]
    fn resolver_maps_item_path_before_open() {
        let (mut p, audio) = player();
        p.set_resolver(Box::new(|item| {
            if let Some(key) = item.path.strip_prefix("remote:") {
                Ok(format!("/cache/{key}.m4a"))
            } else {
                Ok(item.path.clone())
            }
        }));
        p.set_queue(vec![
            item("a"),
            QueueItem {
                track: Track {
                    id: "r".into(),
                    title: "remote".into(),
                    artist: String::new(),
                    album: String::new(),
                    artwork_url: String::new(),
                    duration_ms: 0,
                },
                path: "remote:yt-1".into(),
            },
        ]);
        p.play_index(1).unwrap();
        assert_eq!(audio.opened.lock().unwrap()[0], "/cache/yt-1.m4a");
        // A device-swap reopen goes through the resolver too.
        let (pos, playing) = p.reopen_snapshot();
        p.reopen_current(pos, playing).unwrap();
        assert_eq!(
            audio.opened.lock().unwrap().last().unwrap(),
            "/cache/yt-1.m4a"
        );
    }

    #[test]
    fn resolver_error_aborts_play() {
        let (mut p, _) = player();
        p.set_resolver(Box::new(|_| Err("download failed".into())));
        p.set_queue(vec![item("a")]);
        assert!(p.play_index(0).is_err());
        assert_eq!(p.tick().status, PlaybackStatus::Stopped);
    }

    #[test]
    fn reopen_current_stays_paused() {
        let (mut p, audio) = player();
        p.set_queue(vec![item("a")]);
        p.play_index(0).unwrap();
        audio.pos.store(5_000, Ordering::SeqCst);
        p.control(Control::PlayPause).unwrap();
        let (pos, playing) = p.reopen_snapshot();
        p.reopen_current(pos, playing).unwrap();
        assert!(!audio.playing.load(Ordering::SeqCst));
        assert_eq!(audio.position_ms(), 5_000);
        assert_eq!(p.tick().status, PlaybackStatus::Paused);
    }

    #[test]
    fn reopen_current_noop_when_stopped() {
        let (mut p, audio) = player();
        p.set_queue(vec![item("a")]);
        let (pos, playing) = p.reopen_snapshot();
        p.reopen_current(pos, playing).unwrap();
        assert!(audio.opened.lock().unwrap().is_empty());
    }
}
