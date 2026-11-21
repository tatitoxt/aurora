//! rodio-backed `AudioOut` for the local player. One OS output stream;
//! `open` replaces the main channel's contents so `get_pos` stays correct.
//! `crossfade_to` runs the next track on a second channel of the same
//! mixer and fades the two volumes across `fade_ms`.

use noctbeat_core::eq::{EqBank, EqState};
use noctbeat_core::player::AudioOut;
use rodio::cpal::traits::{DeviceTrait, HostTrait};
use rodio::{Decoder, Sample, Source};
use std::fs::File;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct Inner {
    _sink: rodio::MixerDeviceSink,
    mixer: rodio::mixer::Mixer,
    player: rodio::Player,
    /// Second channel fading the next track in during a crossfade.
    b_player: Option<rodio::Player>,
}

/// Cancellation token for an in-flight crossfade; the ramp thread
/// polls it between volume steps.
struct Fade {
    cancel: Arc<AtomicBool>,
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
    inner: Arc<Mutex<Option<Inner>>>,
    /// Position to report after `seek` (rodio counts source position, and a
    /// `try_seek` can fail silently on some codecs — clamp honestly).
    fallback_pos: Mutex<Option<Duration>>,
    /// Live EQ gains shared with every wrapped source.
    eq: Arc<EqState>,
    /// Shared analysis tap for the beat/spectrum poller.
    tap: Arc<Tap>,
    /// User volume (f32 bits) — the ramp thread targets this so a volume
    /// change mid-fade still lands on the latest value.
    base_volume: Arc<AtomicU32>,
    /// Live crossfade job, if any.
    fade: Mutex<Option<Fade>>,
    /// (path, duration) the second channel is fading in; consumed by
    /// `take_crossfaded` when the player cursor catches up.
    armed: Mutex<Option<(String, Option<u64>)>>,
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
            inner: Arc::new(Mutex::new(Some(Inner {
                mixer: sink.mixer().clone(),
                _sink: sink,
                player,
                b_player: None,
            }))),
            fallback_pos: Mutex::new(None),
            eq: Arc::new(EqState::new()),
            tap: Arc::new(Tap {
                mono: Mutex::new(Vec::new()),
                rate: std::sync::atomic::AtomicU32::new(0),
            }),
            base_volume: Arc::new(AtomicU32::new(1.0f32.to_bits())),
            fade: Mutex::new(None),
            armed: Mutex::new(None),
        })
    }

    /// Cancel an in-flight crossfade: the ramp thread restores the main
    /// channel's volume and the second channel is dropped.
    fn disarm(&self) {
        if let Ok(mut f) = self.fade.lock() {
            if let Some(fade) = f.take() {
                fade.cancel.store(true, Ordering::Relaxed);
            }
        }
        if let Ok(mut a) = self.armed.lock() {
            *a = None;
        }
        if let Ok(mut g) = self.inner.lock() {
            if let Some(inner) = g.as_mut() {
                inner.b_player = None;
                inner
                    .player
                    .set_volume(f32::from_bits(self.base_volume.load(Ordering::Relaxed)));
            }
        }
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
        self.disarm();
        let sink = Self::open_sink(name).ok_or("audio device unavailable")?;
        let player = rodio::Player::connect_new(sink.mixer());
        *self.inner.lock().map_err(|e| e.to_string())? = Some(Inner {
            mixer: sink.mixer().clone(),
            _sink: sink,
            player,
            b_player: None,
        });
        Ok(())
    }
}

impl AudioOut for RodioOut {
    fn open(&self, path: &str) -> Result<Option<u64>, String> {
        self.disarm();
        let file = File::open(path).map_err(|e| format!("open {path}: {e}"))?;
        let decoder = Decoder::try_from(file).map_err(|e| e.to_string())?;
        let dur = decoder.total_duration().map(|d| d.as_millis() as u64);
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        let inner = guard.as_mut().ok_or("no audio device")?;
        inner.player.clear();
        // A fade may have left the main channel turned down — restore it.
        inner
            .player
            .set_volume(f32::from_bits(self.base_volume.load(Ordering::Relaxed)));
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
                if let Some(b) = i.b_player.as_ref() {
                    b.play();
                }
            }
        }
    }
    fn pause(&self) {
        if let Ok(g) = self.inner.lock() {
            if let Some(i) = g.as_ref() {
                i.player.pause();
                if let Some(b) = i.b_player.as_ref() {
                    b.pause();
                }
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
        // Seeking back kills a pending fade — the track is staying.
        self.disarm();
        let guard = self.inner.lock().map_err(|e| e.to_string())?;
        let inner = guard.as_ref().ok_or("no audio device")?;
        inner
            .player
            .try_seek(Duration::from_millis(position_ms))
            .map_err(|e| e.to_string())
    }
    fn set_volume(&self, volume: f32) {
        self.base_volume.store(volume.to_bits(), Ordering::Relaxed);
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

    /// Start `path` on a second mixer channel at volume 0 and spawn the
    /// ramp: main channel fades base→0 while the new one fades 0→base,
    /// then the old channel is cleared (which is what `is_finished`
    /// reports, driving the queue advance).
    fn crossfade_to(&self, path: &str, fade_ms: u64) -> Result<Option<u64>, String> {
        if fade_ms == 0 {
            return Err("crossfade disabled".into());
        }
        let file = File::open(path).map_err(|e| format!("open {path}: {e}"))?;
        let decoder = Decoder::try_from(file).map_err(|e| e.to_string())?;
        let dur = decoder.total_duration().map(|d| d.as_millis() as u64);
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        let inner = guard.as_mut().ok_or("no audio device")?;
        // Replace any earlier armed fade.
        if let Ok(mut f) = self.fade.lock() {
            if let Some(prev) = f.take() {
                prev.cancel.store(true, Ordering::Relaxed);
            }
        }
        inner.b_player = None;
        let b = rodio::Player::connect_new(&inner.mixer);
        b.append(TapSource::wrap(
            EqSource::wrap(decoder, self.eq.clone()),
            self.tap.clone(),
        ));
        b.set_volume(0.0);
        b.play();
        inner.b_player = Some(b);
        let cancel = Arc::new(AtomicBool::new(false));
        *self.fade.lock().map_err(|e| e.to_string())? = Some(Fade {
            cancel: cancel.clone(),
        });
        *self.armed.lock().map_err(|e| e.to_string())? = Some((path.to_string(), dur));
        let base_volume = self.base_volume.clone();
        let inner2 = self.inner.clone();
        std::thread::spawn(move || {
            let steps = 30u32;
            let step = Duration::from_millis((fade_ms / steps as u64).max(10));
            for i in 1..=steps {
                {
                    let Ok(mut g) = inner2.lock() else { return };
                    let Some(inner) = g.as_mut() else { return };
                    let base = f32::from_bits(base_volume.load(Ordering::Relaxed));
                    if cancel.load(Ordering::Relaxed) {
                        // Cancel path: whichever channel is in `player`
                        // (a swap may already have put B there) goes to
                        // full volume and the extra channel is dropped.
                        inner.player.set_volume(base);
                        inner.b_player = None;
                        return;
                    }
                    let t = i as f32 / steps as f32;
                    inner.player.set_volume(base * (1.0 - t));
                    if let Some(b) = inner.b_player.as_ref() {
                        b.set_volume(base * t);
                    }
                }
                std::thread::sleep(step);
            }
            // Fade finished: empty the old channel so `is_finished`
            // drives the queue advance; `take_crossfaded` swaps B in.
            if !cancel.load(Ordering::Relaxed) {
                if let Ok(mut g) = inner2.lock() {
                    if let Some(inner) = g.as_mut() {
                        inner.player.clear();
                    }
                }
            }
        });
        Ok(dur)
    }

    /// When `path` is the track the second channel is fading in, make it
    /// the live channel (the fading-out player is dropped) and report
    /// its duration. The player's `open` is then skipped.
    fn take_crossfaded(&self, path: &str) -> Option<u64> {
        let armed = self.armed.lock().ok()?.clone()?;
        if armed.0 != path {
            return None;
        }
        *self.armed.lock().ok()? = None;
        // Stop the ramp first — on cancel the thread normalizes whatever
        // sits in `player` to full volume and clears `b_player`.
        if let Ok(mut f) = self.fade.lock() {
            if let Some(fade) = f.take() {
                fade.cancel.store(true, Ordering::Relaxed);
            }
        }
        if let Ok(mut g) = self.inner.lock() {
            if let Some(inner) = g.as_mut() {
                if let Some(b) = inner.b_player.take() {
                    let _old = std::mem::replace(&mut inner.player, b);
                }
            }
        }
        Some(armed.1.unwrap_or(0))
    }
}
