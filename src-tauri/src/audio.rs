//! rodio-backed `AudioOut` for the local player. One OS output stream with a
//! single Player; `open` replaces its contents so `get_pos` stays correct.

use noctbeat_core::player::AudioOut;
use rodio::cpal::traits::{DeviceTrait, HostTrait};
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

fn device_name(d: &rodio::cpal::Device) -> String {
    d.description()
        .map(|x| x.name().to_string())
        .unwrap_or_else(|_| "unknown".into())
}

impl RodioOut {
    fn open_sink(name: Option<&str>) -> Option<rodio::MixerDeviceSink> {
        match name {
            None => rodio::DeviceSinkBuilder::open_default_sink().ok(),
            Some(n) => {
                let dev = rodio::cpal::default_host()
                    .output_devices()
                    .ok()?
                    .find(|d| device_name(d) == n)?;
                rodio::DeviceSinkBuilder::from_device(dev)
                    .and_then(|b| b.open_stream())
                    .ok()
            }
        }
    }

    /// Names of the OS output devices (speakers, headphones, Bluetooth
    /// sinks) for the settings picker.
    pub fn list_outputs() -> Vec<String> {
        rodio::cpal::default_host()
            .output_devices()
            .map(|it| it.map(|d| device_name(&d)).collect())
            .unwrap_or_default()
    }

    /// Try to open the OS default output device. Returns None when no device
    /// exists (CI, headless) — callers fall back to NullAudio.
    pub fn open_default() -> Option<Self> {
        Self::open_named(None)
    }

    /// Open the output device named `name` (None = OS default).
    pub fn open_named(name: Option<&str>) -> Option<Self> {
        let sink = Self::open_sink(name)?;
        let player = rodio::Player::connect_new(sink.mixer());
        Some(Self {
            inner: Mutex::new(Some(Inner {
                _sink: sink,
                player,
            })),
            fallback_pos: Mutex::new(None),
        })
    }

    /// Re-point playback at the device `name` (None = OS default). The
    /// previous stream is dropped, so the caller must re-open the current
    /// track to resume it.
    pub fn set_device(&self, name: Option<&str>) -> Result<(), String> {
        let sink = Self::open_sink(name).ok_or("audio device unavailable")?;
        let player = rodio::Player::connect_new(sink.mixer());
        *self.inner.lock().map_err(|e| e.to_string())? = Some(Inner {
            _sink: sink,
            player,
        });
        Ok(())
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
