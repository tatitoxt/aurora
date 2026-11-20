//! Beat/energy analysis on raw PCM fed by whatever loopback capture is active.
//! Pure DSP, no I/O: silence -> rest, onsets -> `beat`, BPM from onset intervals.

use serde::Serialize;

const WINDOW: usize = 1024; // ~21ms at 48k
const ONSET_HISTORY: usize = 43; // ~0.9s window for adaptive threshold
const SMOOTH_ATTACK: f32 = 0.45;
const SMOOTH_RELEASE: f32 = 0.08;
const MAX_BPM_SAMPLES: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnergyUpdate {
    /// Smoothed loudness 0..1.
    pub level: f32,
    /// True on a detected onset frame.
    pub beat: bool,
    /// Rolling tempo estimate when enough onsets have been seen.
    pub bpm: Option<f32>,
}

/// Windowed-RMS + energy-flux onset detector with adaptive threshold.
pub struct BeatDetector {
    sample_rate: u32,
    buf: Vec<f32>,
    /// Recent short-window energies for the adaptive threshold.
    flux_hist: [f32; ONSET_HISTORY],
    flux_i: usize,
    prev_energy: f32,
    level: f32,
    onset_times_ms: Vec<u64>,
    cursor_ms: u64,
    last_beat_ms: u64,
    refractory_ms: u64,
}

impl BeatDetector {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            buf: Vec::with_capacity(WINDOW),
            flux_hist: [0.0; ONSET_HISTORY],
            flux_i: 0,
            prev_energy: 0.0,
            level: 0.0,
            onset_times_ms: Vec::with_capacity(MAX_BPM_SAMPLES),
            cursor_ms: 0,
            last_beat_ms: 0,
            refractory_ms: 160,
        }
    }

    /// Feed mono samples normalized to [-1, 1].
    pub fn push(&mut self, samples: &[f32]) -> EnergyUpdate {
        // Aggregate over all complete windows in this push: level/bpm from the
        // latest window, `beat` if any window had an onset (beats must not be
        // lost when a push spans several windows).
        let mut beat = false;
        for &s in samples {
            self.buf.push(s);
            if self.buf.len() == WINDOW {
                if self.process_window().beat {
                    beat = true;
                }
                self.buf.clear();
            }
        }
        EnergyUpdate {
            level: self.level.clamp(0.0, 1.0),
            beat,
            bpm: self.bpm(),
        }
    }

    fn process_window(&mut self) -> EnergyUpdate {
        let n = self.buf.len() as f32;
        let energy = (self.buf.iter().map(|s| s * s).sum::<f32>() / n).sqrt();
        self.cursor_ms += (WINDOW as u64 * 1000) / self.sample_rate as u64;

        // Smoothed level: fast attack, slow release.
        let k = if energy > self.level {
            SMOOTH_ATTACK
        } else {
            SMOOTH_RELEASE
        };
        self.level += (energy - self.level) * k;

        // Onset: positive flux vs. adaptive mean of recent flux.
        let flux = (energy - self.prev_energy).max(0.0);
        self.prev_energy = energy;
        let mean: f32 = self.flux_hist.iter().sum::<f32>() / ONSET_HISTORY as f32;
        self.flux_hist[self.flux_i] = flux;
        self.flux_i = (self.flux_i + 1) % ONSET_HISTORY;

        let threshold = mean * 1.7 + 0.01;
        let mut beat = false;
        if flux > threshold
            && energy > 0.02
            && self.cursor_ms.saturating_sub(self.last_beat_ms) > self.refractory_ms
        {
            beat = true;
            self.last_beat_ms = self.cursor_ms;
            self.onset_times_ms.push(self.cursor_ms);
            if self.onset_times_ms.len() > MAX_BPM_SAMPLES {
                self.onset_times_ms.remove(0);
            }
        }

        EnergyUpdate {
            level: self.level.clamp(0.0, 1.0),
            beat,
            bpm: self.bpm(),
        }
    }

    fn bpm(&self) -> Option<f32> {
        if self.onset_times_ms.len() < 3 {
            return None;
        }
        let mut deltas: Vec<u64> = self
            .onset_times_ms
            .windows(2)
            .map(|w| w[1] - w[0])
            .filter(|d| (200..2000).contains(d))
            .collect();
        if deltas.is_empty() {
            return None;
        }
        deltas.sort_unstable();
        let median = deltas[deltas.len() / 2] as f32;
        Some(60_000.0 / median)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, sr: u32, secs: f32) -> Vec<f32> {
        (0..(sr as f32 * secs) as usize)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / sr as f32).sin() * 0.5)
            .collect()
    }

    fn kick_train(sr: u32, bpm: f32, secs: f32) -> Vec<f32> {
        let n = (sr as f32 * secs) as usize;
        let period = sr as f32 * 60.0 / bpm;
        (0..n)
            .map(|i| {
                let phase = i as f32 % period;
                if phase < 0.02 * sr as f32 {
                    (-phase / (0.004 * sr as f32)).exp() * 0.9
                } else {
                    0.0
                }
            })
            .collect()
    }

    #[test]
    fn silence_rests() {
        let mut d = BeatDetector::new(48_000);
        let u = d.push(&vec![0.0f32; 48_000]);
        assert!(u.level < 0.01);
        assert!(!u.beat);
    }

    #[test]
    fn steady_sine_no_beats() {
        let mut d = BeatDetector::new(48_000);
        let sig = sine(440.0, 48_000, 2.0);
        let mut beats = 0;
        for chunk in sig.chunks(4096) {
            if d.push(chunk).beat {
                beats += 1;
            }
        }
        assert!(beats <= 1, "steady sine must not beat (got {beats})");
    }

    #[test]
    fn pulse_train_beats_and_bpm() {
        let sr = 48_000;
        let mut d = BeatDetector::new(sr);
        let sig = kick_train(sr, 120.0, 6.0);
        let mut beats = 0;
        let mut last_bpm = None;
        for chunk in sig.chunks(2048) {
            let u = d.push(chunk);
            if u.beat {
                beats += 1;
            }
            if u.bpm.is_some() {
                last_bpm = u.bpm;
            }
        }
        // 120bpm over 6s -> ~11-12 kicks; detection should see most.
        assert!((6..=14).contains(&beats), "beats={beats}");
        let bpm = last_bpm.expect("bpm estimate");
        assert!((100.0..=140.0).contains(&bpm), "bpm={bpm}");
    }

    #[test]
    fn level_eases_down() {
        let mut d = BeatDetector::new(48_000);
        d.push(&sine(200.0, 48_000, 0.5));
        let loud = d.push(&[0.0f32; 1024]).level;
        assert!(loud > 0.1);
        for _ in 0..100 {
            d.push(&[0.0f32; 1024]);
        }
        let quiet = d.push(&[0.0f32; 1024]).level;
        assert!(quiet < loud * 0.3, "level={quiet} after silence");
    }
}
