//! Sound FX: shared effect-mode state plus the DSP primitives the live
//! chain applies — a small Schroeder-style comb reverb, a feedback echo,
//! and an equal-power 8D auto-pan. Like the EQ, `FxState` is atomics so
//! the UI switches modes on the running source without restarting audio.

use std::f32::consts::PI;
use std::sync::atomic::{AtomicU32, AtomicU8, Ordering};

/// Stable mode ids for persisted settings.
pub const FX_OFF: u8 = 0;
pub const FX_REVERB: u8 = 1;
pub const FX_EIGHT_D: u8 = 2;
pub const FX_ECHO: u8 = 3;

/// Settings string → mode id (unknown names become Off).
pub fn mode_from_name(name: &str) -> u8 {
    match name {
        "reverb" => FX_REVERB,
        "8d" => FX_EIGHT_D,
        "echo" => FX_ECHO,
        _ => FX_OFF,
    }
}

/// Mode id → persisted settings string.
pub fn mode_name(mode: u8) -> &'static str {
    match mode {
        FX_REVERB => "reverb",
        FX_EIGHT_D => "8d",
        FX_ECHO => "echo",
        _ => "off",
    }
}

/// Shared FX state. Cloneable handle — clones share the same atomics.
#[derive(Debug)]
pub struct FxState {
    mode: AtomicU8,
    /// Wet mix 0..1 shared across modes (f32 bits).
    wet: AtomicU32,
}

impl Default for FxState {
    fn default() -> Self {
        Self::new()
    }
}

impl FxState {
    pub fn new() -> Self {
        Self {
            mode: AtomicU8::new(FX_OFF),
            wet: AtomicU32::new(0.35f32.to_bits()),
        }
    }

    /// Switch modes by settings name; unknown names turn FX off.
    pub fn set(&self, name: &str) {
        self.mode.store(mode_from_name(name), Ordering::Relaxed);
    }

    pub fn mode(&self) -> u8 {
        self.mode.load(Ordering::Relaxed)
    }

    pub fn wet(&self) -> f32 {
        f32::from_bits(self.wet.load(Ordering::Relaxed))
    }
}

/// Feedback comb filter: `y[n] = x[n-D] + fb·y[n-D]` written back into the
/// line, so an impulse rings out as an exponentially decaying pulse
/// train — the body of a small-room reverb or a slap echo.
pub struct Comb {
    buf: Vec<f32>,
    pos: usize,
    feedback: f32,
}

impl Comb {
    pub fn new(delay_ms: f32, rate: u32, feedback: f32) -> Self {
        let n = ((delay_ms / 1000.0) * rate as f32).round().max(1.0) as usize;
        Self {
            buf: vec![0.0; n],
            pos: 0,
            feedback,
        }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let out = self.buf[self.pos];
        self.buf[self.pos] = x + out * self.feedback;
        self.pos = (self.pos + 1) % self.buf.len();
        out
    }
}

/// Reverb delay taps per channel (Freeverb-scale stereo combs, ms).
const REVERB_MS: [f32; 4] = [29.7, 37.1, 41.1, 43.7];
const REVERB_FB: f32 = 0.78;
const ECHO_MS: f32 = 280.0;
const ECHO_FB: f32 = 0.42;
/// 8D pan LFO frequency, Hz — a slow ~8 s orbit.
const PAN_HZ: f32 = 0.13;

/// Per-channel effect bank for one wrapped source. Holds delay lines for
/// the active mode; `sync` rebuilds when the shared mode changes so stale
/// tails never leak into a different effect.
pub struct FxBank {
    mode: u8,
    channels: usize,
    rate: u32,
    /// `combs[ch]` — one echo line or 4 reverb combs per channel.
    combs: Vec<Vec<Comb>>,
    /// 8D pan phase 0..1 (full circle = one L/R orbit).
    pan_phase: f32,
}

impl FxBank {
    pub fn new(channels: usize, rate: u32, mode: u8) -> Self {
        let ch = channels.max(1);
        let combs = (0..ch)
            .map(|_| match mode {
                FX_REVERB => REVERB_MS
                    .iter()
                    .map(|&d| Comb::new(d, rate, REVERB_FB))
                    .collect(),
                FX_ECHO => vec![Comb::new(ECHO_MS, rate, ECHO_FB)],
                _ => Vec::new(),
            })
            .collect();
        Self {
            mode,
            channels: ch,
            rate,
            combs,
            pan_phase: 0.0,
        }
    }

    pub fn mode(&self) -> u8 {
        self.mode
    }

    /// Process one sample on `channel` in the current mode.
    #[inline]
    pub fn process(&mut self, channel: usize, x: f32, state: &FxState) -> f32 {
        let ch = channel % self.channels;
        match self.mode {
            FX_REVERB => {
                let wet = state.wet();
                let sum: f32 = self.combs[ch].iter_mut().map(|c| c.process(x)).sum();
                x + wet * sum / self.combs[ch].len().max(1) as f32
            }
            FX_ECHO => {
                let wet = state.wet();
                x + wet * self.combs[ch][0].process(x)
            }
            FX_EIGHT_D => {
                // Equal-power pan: advance the orbit once per frame
                // (on channel 0) so both channels share the angle.
                if ch == 0 {
                    self.pan_phase = (self.pan_phase + PAN_HZ / self.rate.max(1) as f32) % 1.0;
                }
                // Mono can't pan — applying only the left gain would
                // periodically fade the track to silence.
                if self.channels == 1 {
                    return x;
                }
                let theta = self.pan_phase * 2.0 * PI;
                let pan = (theta.sin() + 1.0) * 0.5; // 0 = left, 1 = right
                let angle = pan * PI / 2.0;
                let gain = if ch.is_multiple_of(2) {
                    angle.cos()
                } else {
                    angle.sin()
                };
                x * gain
            }
            _ => x,
        }
    }

    /// Drop all delay-line memory (mode change or seek) so stale tails
    /// don't ring into the new state.
    pub fn reset(&mut self, mode: u8) {
        *self = FxBank::new(self.channels, self.rate, mode);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_roundtrip() {
        assert_eq!(mode_from_name("reverb"), FX_REVERB);
        assert_eq!(mode_from_name("8d"), FX_EIGHT_D);
        assert_eq!(mode_from_name("echo"), FX_ECHO);
        assert_eq!(mode_from_name("bogus"), FX_OFF);
        assert_eq!(mode_name(FX_EIGHT_D), "8d");
    }

    #[test]
    fn off_is_transparent() {
        let s = FxState::new();
        let mut b = FxBank::new(2, 48_000, s.mode());
        for i in 0..1000 {
            let x = (i as f32 * 0.01).sin();
            assert_eq!(b.process(0, x, &s), x);
        }
    }

    #[test]
    fn echo_repeats_impulse() {
        let s = FxState::new();
        s.set("echo");
        let rate = 48_000u32;
        let mut b = FxBank::new(1, rate, s.mode());
        let mut out = Vec::new();
        for i in 0..rate as usize {
            let x = if i == 0 { 1.0 } else { 0.0 };
            out.push(b.process(0, x, &s));
        }
        let delay = (ECHO_MS / 1000.0 * rate as f32).round() as usize;
        // First repeat lands near the delay tap with wet×1 amplitude.
        assert!(out[delay].abs() > 0.2, "echo tap silent: {}", out[delay]);
        // Second repeat (delay²) is attenuated by feedback.
        let second = out.get(delay * 2).copied().unwrap_or(0.0);
        assert!(second.abs() > 0.02 && second.abs() < out[delay].abs());
    }

    #[test]
    fn reverb_rings_after_impulse() {
        let s = FxState::new();
        s.set("reverb");
        let rate = 48_000u32;
        let mut b = FxBank::new(1, rate, s.mode());
        let mut tail_energy = 0.0f32;
        for i in 0..rate as usize / 4 {
            let x = if i == 0 { 1.0 } else { 0.0 };
            tail_energy += b.process(0, x, &s).powi(2);
        }
        // A pass-through would only hold the impulse's own energy (~1);
        // the comb tail must add measurable energy after it.
        assert!(tail_energy > 1.02, "no reverb tail: {tail_energy}");
    }

    #[test]
    fn eight_d_pans_between_channels() {
        let s = FxState::new();
        s.set("8d");
        let rate = 48_000u32;
        let mut b = FxBank::new(2, rate, s.mode());
        // Early: pan starts center-left; later samples must move energy.
        let mut early_l = 0.0f32;
        let mut early_r = 0.0f32;
        let mut late_l = 0.0f32;
        let mut late_r = 0.0f32;
        for i in 0..rate as usize / 2 {
            for ch in 0..2 {
                let y = b.process(ch, 0.5, &s);
                if i < 1000 {
                    if ch == 0 {
                        early_l += y.abs();
                    } else {
                        early_r += y.abs();
                    }
                } else {
                    if ch == 0 {
                        late_l += y.abs();
                    } else {
                        late_r += y.abs();
                    }
                }
            }
        }
        // Energy distribution must actually orbit — the late window must
        // differ from the early one.
        let early_ratio = early_l / (early_l + early_r).max(1e-6);
        let late_ratio = late_l / (late_l + late_r).max(1e-6);
        assert!(
            (early_ratio - late_ratio).abs() > 0.05,
            "no panning: early {early_ratio} late {late_ratio}"
        );
    }

    #[test]
    fn eight_d_mono_is_transparent() {
        let s = FxState::new();
        s.set("8d");
        let mut b = FxBank::new(1, 48_000, s.mode());
        // A mono track must never fade out: output always equals input.
        for i in 0..20_000 {
            let x = 0.3 + (i as f32 * 0.001).sin();
            let y = b.process(0, x, &s);
            assert_eq!(x, y, "mono 8D faded at sample {i}");
        }
    }
}
