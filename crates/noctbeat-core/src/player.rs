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

/// Player state machine: queue + transport, delegating I/O to `AudioOut`.
pub struct LocalPlayer {
    audio: std::sync::Arc<dyn AudioOut>,
    queue: Vec<QueueItem>,
    index: Option<usize>,
    status: PlaybackStatus,
}

impl LocalPlayer {
    pub fn new(audio: std::sync::Arc<dyn AudioOut>) -> Self {
        Self {
            audio,
            queue: Vec::new(),
            index: None,
            status: PlaybackStatus::Stopped,
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
        self.audio.open(&item.path)?;
        self.audio.play();
        self.index = Some(index);
        self.status = PlaybackStatus::Playing;
        Ok(())
    }

    pub fn seek(&self, position_ms: u64) -> Result<(), String> {
        self.audio.seek(position_ms)
    }

    pub fn set_volume(&self, volume: f32) {
        self.audio.set_volume(volume.clamp(0.0, 1.0));
    }

    fn advance(&mut self, dir: i64) -> Result<(), String> {
        let Some(i) = self.index else {
            if self.queue.is_empty() {
                return Err("empty queue".into());
            }
            return self.play_index(0);
        };
        let next = i as i64 + dir;
        if next < 0 || next as usize >= self.queue.len() {
            return Err("end of queue".into());
        }
        self.play_index(next as usize)
    }

    /// Poll that also advances the queue when a track finished.
    pub fn tick(&mut self) -> NowPlaying {
        if self.status == PlaybackStatus::Playing && self.audio.is_finished() {
            let _ = self.advance(1).map_err(|_| {
                self.status = PlaybackStatus::Stopped;
            });
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
    fn clear_stops_and_empties() {
        let (mut p, _) = player();
        p.set_queue(vec![item("a")]);
        p.play_index(0).unwrap();
        p.clear();
        assert!(p.queue().is_empty());
        assert_eq!(p.tick().status, PlaybackStatus::Stopped);
    }
}
