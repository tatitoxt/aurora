//! rodio-backed `AudioOut` for the local player. One OS output stream with a
//! single Player; `open` replaces its contents so `get_pos` stays correct.

use noctbeat_core::player::AudioOut;
use rodio::{Decoder, Source};
use std::fs::File;
use std::sync::Mutex;
use std::time::Duration;

struct Inner {
    _sink: rodio::MixerDeviceSink,
    player: rodio::Player,
}

pub struct RodioOut {
    inner: Mutex<Option<Inner>>,
    /// Position to report after `seek` (rodio counts source position, and a
    /// `try_seek` can fail silently on some codecs — clamp honestly).
    fallback_pos: Mutex<Option<Duration>>,
}

impl RodioOut {
    /// Try to open the default output device. Returns None when no device
    /// exists (CI, headless) — callers fall back to NullAudio.
    pub fn open_default() -> Option<Self> {
        let sink = rodio::DeviceSinkBuilder::open_default_sink().ok()?;
        let player = rodio::Player::connect_new(sink.mixer());
        Some(Self {
            inner: Mutex::new(Some(Inner {
                _sink: sink,
                player,
            })),
            fallback_pos: Mutex::new(None),
        })
    }
}

impl AudioOut for RodioOut {
    fn open(&self, path: &str) -> Result<Option<u64>, String> {
        let file = File::open(path).map_err(|e| format!("open {path}: {e}"))?;
        let decoder = Decoder::try_from(file).map_err(|e| e.to_string())?;
        let dur = decoder.total_duration().map(|d| d.as_millis() as u64);
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        let inner = guard.as_mut().ok_or("no audio device")?;
        inner.player.clear();
        inner.player.append(decoder);
        *self.fallback_pos.lock().map_err(|e| e.to_string())? = Some(Duration::ZERO);
        Ok(dur)
    }
    fn play(&self) {
        if let Ok(g) = self.inner.lock() {
            if let Some(i) = g.as_ref() {
                i.player.play();
            }
        }
    }
    fn pause(&self) {
        if let Ok(g) = self.inner.lock() {
            if let Some(i) = g.as_ref() {
                i.player.pause();
            }
        }
    }
    fn position_ms(&self) -> u64 {
        if let Ok(g) = self.inner.lock() {
            if let Some(i) = g.as_ref() {
                return i.player.get_pos().as_millis() as u64;
            }
        }
        0
    }
    fn seek(&self, position_ms: u64) -> Result<(), String> {
        let guard = self.inner.lock().map_err(|e| e.to_string())?;
        let inner = guard.as_ref().ok_or("no audio device")?;
        inner
            .player
            .try_seek(Duration::from_millis(position_ms))
            .map_err(|e| e.to_string())
    }
    fn set_volume(&self, volume: f32) {
        if let Ok(g) = self.inner.lock() {
            if let Some(i) = g.as_ref() {
                i.player.set_volume(volume);
            }
        }
    }
    fn is_finished(&self) -> bool {
        if let Ok(g) = self.inner.lock() {
            if let Some(i) = g.as_ref() {
                return i.player.empty();
            }
        }
        false
    }
}
