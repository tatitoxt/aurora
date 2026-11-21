//! Parametric equalizer: a fixed bank of peaking biquad filters (RBJ
//! cookbook) applied to the decoded sample stream. `EqState` is the shared
//! gain store — cheap atomic writes let the UI retune the live source chain
//! without restarting the track.

use std::f32::consts::PI;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

/// Number of EQ bands (and sliders in the UI).
pub const EQ_BANDS: usize = 5;
/// Center frequency of each band, Hz.
pub const EQ_FREQS: [f32; EQ_BANDS] = [60.0, 250.0, 1_000.0, 4_000.0, 12_000.0];
const Q: f32 = 1.1;

/// Shared EQ gain state (dB per band). Cloneable handle — clones share the
/// same atomics.
#[derive(Debug)]
pub struct EqState {
    gains: [AtomicU32; EQ_BANDS],
    /// Bumped on every `set`; the source compares it with the generation it
    /// last built coefficients for, so retunes are O(bands) and lock-free.
    generation: AtomicU64,
}

impl Default for EqState {
    fn default() -> Self {
        Self::new()
    }
}

impl EqState {
    pub fn new() -> Self {
        Self {
            gains: [const { AtomicU32::new(0) }; EQ_BANDS],
            generation: AtomicU64::new(0),
        }
    }

    /// Set band gains in dB (clamped to ±18 dB).
    pub fn set(&self, bands: &[f32]) {
        for (i, g) in self.gains.iter().enumerate() {
            let db = bands.get(i).copied().unwrap_or(0.0).clamp(-18.0, 18.0);
            g.store(db.to_bits(), Ordering::Relaxed);
        }
        self.generation.fetch_add(1, Ordering::Release);
    }

    pub fn bands(&self) -> [f32; EQ_BANDS] {
        std::array::from_fn(|i| f32::from_bits(self.gains[i].load(Ordering::Relaxed)))
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }
}

/// One peaking biquad in transposed direct-form II.
#[derive(Debug, Clone, Copy)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    /// RBJ peaking EQ: `gain_db` boost/cut around `f0` Hz at sample rate `fs`.
    /// Falls back to a pass-through filter when `f0` reaches the Nyquist
    /// edge, where the coefficients would go unstable on low-rate tracks.
    pub fn peaking(f0: f32, fs: f32, gain_db: f32, q: f32) -> Self {
        if f0 * 2.0 >= fs * 0.9 || !f0.is_finite() || !fs.is_finite() || fs <= 0.0 {
            return Self::identity();
        }
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * PI * f0 / fs;
        let alpha = w0.sin() / (2.0 * q);
        let cos_w0 = w0.cos();
        let a0 = 1.0 + alpha / a;
        Self {
            b0: (1.0 + alpha * a) / a0,
            b1: (-2.0 * cos_w0) / a0,
            b2: (1.0 - alpha * a) / a0,
            a1: (-2.0 * cos_w0) / a0,
            a2: (1.0 - alpha / a) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    /// Pass-through filter: output == input, no state.
    pub fn identity() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// Per-channel bank: one `Biquad` per band per channel.
pub struct EqBank {
    /// `filters[ch][band]` — interleaved stereo needs independent states.
    filters: Vec<Vec<Biquad>>,
    gains: [f32; EQ_BANDS],
    fs: f32,
    generation: u64,
}

impl EqBank {
    pub fn new(channels: usize, fs: f32) -> Self {
        Self {
            filters: vec![Vec::new(); channels.max(1)],
            gains: [0.0; EQ_BANDS],
            fs,
            generation: u64::MAX, // force a rebuild on first retune check
        }
    }

    /// Rebuild coefficients when the shared state changed.
    pub fn sync(&mut self, state: &EqState) {
        // Read the generation first and record THAT value: if `set` lands
        // between here and `bands()`, the next sync still sees a generation
        // bump and rebuilds — gains can never be silently stale.
        let gen = state.generation();
        if gen == self.generation {
            return;
        }
        self.gains = state.bands();
        self.generation = gen;
        for ch in &mut self.filters {
            *ch = (0..EQ_BANDS)
                .map(|b| Biquad::peaking(EQ_FREQS[b], self.fs, self.gains[b], Q))
                .collect();
        }
    }

    #[inline]
    pub fn process(&mut self, channel: usize, x: f32) -> f32 {
        let last = self.filters.len() - 1;
        let ch = &mut self.filters[channel.min(last)];
        ch.iter_mut().fold(x, |acc, f| f.process(acc))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, fs: f32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * PI * freq * i as f32 / fs).sin())
            .collect()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn flat_is_transparent() {
        let fs = 48_000.0;
        let mut b = Biquad::peaking(1_000.0, fs, 0.0, Q);
        let input = sine(440.0, fs, 4096);
        let out: Vec<f32> = input.iter().map(|&x| b.process(x)).collect();
        // Steady-state: identical after transient.
        for (i, o) in input[256..].iter().zip(&out[256..]) {
            assert!((i - o).abs() < 1e-5);
        }
    }

    #[test]
    fn boost_at_center_frequency() {
        let fs = 48_000.0;
        let mut b = Biquad::peaking(1_000.0, fs, 6.0, Q);
        let input = sine(1_000.0, fs, 8192);
        let out: Vec<f32> = input.iter().map(|&x| b.process(x)).collect();
        let gain = rms(&out[4096..]) / rms(&input[4096..]);
        let expect = 10f32.powf(6.0 / 20.0);
        assert!((gain - expect).abs() < 0.15, "gain {gain} vs {expect}");
    }

    #[test]
    fn cut_at_center_frequency() {
        let fs = 48_000.0;
        let mut b = Biquad::peaking(1_000.0, fs, -9.0, Q);
        let input = sine(1_000.0, fs, 8192);
        let out: Vec<f32> = input.iter().map(|&x| b.process(x)).collect();
        let gain = rms(&out[4096..]) / rms(&input[4096..]);
        let expect = 10f32.powf(-9.0 / 20.0);
        assert!((gain - expect).abs() < 0.1, "gain {gain} vs {expect}");
    }

    #[test]
    fn out_of_band_signal_passes_mostly() {
        let fs = 48_000.0;
        let mut b = Biquad::peaking(60.0, fs, 12.0, Q);
        let input = sine(10_000.0, fs, 8192);
        let out: Vec<f32> = input.iter().map(|&x| b.process(x)).collect();
        let gain = rms(&out[4096..]) / rms(&input[4096..]);
        assert!((gain - 1.0).abs() < 0.25, "out-of-band gain {gain}");
    }

    #[test]
    fn state_clamps_and_reports() {
        let s = EqState::new();
        s.set(&[3.0, 99.0, -99.0]);
        let b = s.bands();
        assert_eq!(b[0], 3.0);
        assert_eq!(b[1], 18.0);
        assert_eq!(b[2], -18.0);
        assert_eq!(b[4], 0.0); // missing -> flat
    }

    #[test]
    fn band_above_nyquist_is_identity() {
        // A 12 kHz band on a 22.05 kHz stream would build unstable
        // coefficients; it must pass audio through instead of blowing up.
        let fs = 22_050.0;
        let mut b = Biquad::peaking(12_000.0, fs, 12.0, Q);
        let input = sine(2_000.0, fs, 2048);
        let out: Vec<f32> = input.iter().map(|&x| b.process(x)).collect();
        for (i, o) in input.iter().zip(&out) {
            assert!((i - o).abs() < 1e-6, "expected pass-through");
            assert!(o.is_finite());
        }
    }

    #[test]
    fn bank_rebuilds_only_on_generation_change() {
        let fs = 48_000.0;
        let s = EqState::new();
        let mut bank = EqBank::new(2, fs);
        bank.sync(&s);
        assert_eq!(bank.generation, s.generation());
        s.set(&[6.0; EQ_BANDS]);
        bank.sync(&s);
        assert_eq!(bank.generation, s.generation());
        assert_eq!(bank.filters.len(), 2);
    }
}
