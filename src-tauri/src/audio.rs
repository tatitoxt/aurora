//! rodio-backed `AudioOut` for the local player. One OS output stream with a
//! single Player; `open` replaces its contents so `get_pos` stays correct.

use noctbeat_core::eq::{EqBank, EqState};
use noctbeat_core::player::AudioOut;
use rodio::cpal::traits::{DeviceTrait, HostTrait};
use rodio::{Decoder, Sample, Source};
use std::fs::File;
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct Inner {
    _sink: rodio::MixerDeviceSink,
    player: rodio::Player,
}

/// `Source` wrapper that applies the shared EQ bank to every sample.
struct EqSource<I> {
    inner: I,
    state: Arc<EqState>,
    bank: EqBank,
    /// Interleaved channel cursor, cycles 0..channels-1 per sample.
    channel: usize,
}

impl<I> EqSource<I>
where
    I: Source<Item = Sample>,
{
    fn wrap(inner: I, state: Arc<EqState>) -> Self {
        let bank = EqBank::new(
            inner.channels().get() as usize,
            inner.sample_rate().get() as f32,
        );
        Self {
            inner,
            state,
            bank,
            channel: 0,
        }
    }
}

impl<I> Iterator for EqSource<I>
where
    I: Source<Item = Sample>,
{
    type Item = Sample;

    #[inline]
    fn next(&mut self) -> Option<Sample> {
        let x = self.inner.next()?;
        self.bank.sync(&self.state);
        let ch = self.channel;
        self.channel = (self.channel + 1) % (self.inner.channels().get() as usize).max(1);
        Some(self.bank.process(ch, x))
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.inner.size_hint()
    }
}

impl<I> Source for EqSource<I>
where
    I: Source<Item = Sample>,
{
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> rodio::ChannelCount {
        self.inner.channels()
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        let r = self.inner.try_seek(pos);
        if r.is_ok() {
            // Drop filter memory so the seek doesn't click with stale state.
            self.bank = EqBank::new(
                self.inner.channels().get() as usize,
                self.inner.sample_rate().get() as f32,
            );
            self.channel = 0;
        }
        r
    }
}

/// Mono PCM tap shared with the analysis poller: `next` appends, the
/// poller drains — the real spectrum source for the visualizer.
pub struct Tap {
    pub mono: Mutex<Vec<f32>>,
    /// Sample rate of the last wrapped source (0 before any open).
    pub rate: std::sync::atomic::AtomicU32,
}

/// `Source` wrapper that copies a mono downmix of passing samples into
/// the shared tap; playback samples are untouched.
struct TapSource<I> {
    inner: I,
    tap: Arc<Tap>,
    /// Running sum for the frame being downmixed.
    acc: f32,
    ch: usize,
}

impl<I> TapSource<I>
where
    I: Source<Item = Sample>,
{
    fn wrap(inner: I, tap: Arc<Tap>) -> Self {
        tap.rate.store(
            inner.sample_rate().get(),
            std::sync::atomic::Ordering::Relaxed,
        );
        Self {
            inner,
            tap,
            acc: 0.0,
            ch: 0,
        }
    }
}

impl<I> Iterator for TapSource<I>
where
    I: Source<Item = Sample>,
{
    type Item = Sample;

    #[inline]
    fn next(&mut self) -> Option<Sample> {
        let x = self.inner.next()?;
        self.acc += x;
        self.ch += 1;
        if self.ch >= self.inner.channels().get() as usize {
            let mono = self.acc / self.ch as f32;
            self.acc = 0.0;
            self.ch = 0;
            if let Ok(mut v) = self.tap.mono.lock() {
                // Bound the backlog at ~2 s at 48 kHz. Clear (O(1)), never
                // drain-and-shift — when the poller isn't reading (demo
                // mode), per-sample drains would copy megabytes a second.
                if v.len() >= 96_000 {
                    v.clear();
                }
                v.push(mono);
            }
        }
        Some(x)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.inner.size_hint()
    }
}

impl<I> Source for TapSource<I>
where
    I: Source<Item = Sample>,
{
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> rodio::ChannelCount {
        self.inner.channels()
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.inner.try_seek(pos)
    }
}

pub struct RodioOut {
    inner: Mutex<Option<Inner>>,
    /// Position to report after `seek` (rodio counts source position, and a
    /// `try_seek` can fail silently on some codecs — clamp honestly).
    fallback_pos: Mutex<Option<Duration>>,
    /// Live EQ gains shared with every wrapped source.
    eq: Arc<EqState>,
    /// Shared analysis tap for the beat/spectrum poller.
    tap: Arc<Tap>,
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
            eq: Arc::new(EqState::new()),
            tap: Arc::new(Tap {
                mono: Mutex::new(Vec::new()),
                rate: std::sync::atomic::AtomicU32::new(0),
            }),
        })
    }

    /// Shared EQ handle — `set` retunes every source live.
    pub fn eq(&self) -> Arc<EqState> {
        self.eq.clone()
    }

    /// Analysis tap: drains mono samples and reports the current rate so
    /// the poller can rebuild its detector when the rate changes.
    pub fn tap_take(&self) -> (Vec<f32>, u32) {
        let buf = self
            .tap
            .mono
            .lock()
            .map(|mut v| std::mem::take(&mut *v))
            .unwrap_or_default();
        let rate = self.tap.rate.load(std::sync::atomic::Ordering::Relaxed);
        (buf, rate)
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
        inner.player.append(TapSource::wrap(
            EqSource::wrap(decoder, self.eq.clone()),
            self.tap.clone(),
        ));
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
