//! Dominant + accent colors from artwork pixels.
//! Deterministic: fixed subsample stride, fixed k-means seeding.

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Rgb(pub u8, pub u8, pub u8);

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Palette {
    pub dominant: Rgb,
    /// Up to 4 accent colors, most vibrant first.
    pub accents: Vec<Rgb>,
}

const K: usize = 6;
const ITERS: usize = 12;
const SAMPLE_STRIDE: usize = 4;

fn srgb_to_lin(v: u8) -> f32 {
    let c = v as f32 / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn luminance(c: Rgb) -> f32 {
    0.2126 * srgb_to_lin(c.0) + 0.7152 * srgb_to_lin(c.1) + 0.0722 * srgb_to_lin(c.2)
}

fn saturation(c: Rgb) -> f32 {
    let max = c.0.max(c.1).max(c.2) as f32;
    let min = c.0.min(c.1).min(c.2) as f32;
    if max == 0.0 {
        0.0
    } else {
        (max - min) / max
    }
}

/// "Vibrancy weight": penalize near-black, near-white and gray pixels.
fn vibrancy(c: Rgb) -> f32 {
    let lum = luminance(c);
    let lum_ok = (lum * 4.0).min(1.0) * ((1.0 - lum) * 4.0).min(1.0);
    saturation(c) * lum_ok
}

/// Extract a palette from RGB8 pixels (`pixels.len() == width*height*3`).
/// Deterministic for identical inputs.
pub fn extract_palette(pixels: &[u8], width: u32, height: u32) -> Palette {
    let count = (width as usize) * (height as usize);
    let mut pts: Vec<[f32; 3]> = Vec::with_capacity(count / SAMPLE_STRIDE + 1);
    for i in (0..count).step_by(SAMPLE_STRIDE) {
        let b = i * 3;
        if b + 2 < pixels.len() {
            pts.push([pixels[b] as f32, pixels[b + 1] as f32, pixels[b + 2] as f32]);
        }
    }
    if pts.is_empty() {
        return Palette {
            dominant: Rgb(0, 0, 0),
            accents: vec![],
        };
    }

    // Deterministic seeds: evenly spaced points sorted by luminance.
    let mut sorted = pts.clone();
    sorted.sort_by(|a, b| {
        (a[0] * 0.3 + a[1] * 0.6 + a[2] * 0.1)
            .partial_cmp(&(b[0] * 0.3 + b[1] * 0.6 + b[2] * 0.1))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut centers: Vec<[f32; 3]> = (0..K).map(|i| sorted[i * sorted.len() / K]).collect();

    let mut sums = [[0f32; 3]; K];
    let mut n = [0u32; K];
    for _ in 0..ITERS {
        sums.iter_mut().for_each(|s| *s = [0.0; 3]);
        n.iter_mut().for_each(|x| *x = 0);
        for p in &pts {
            let mut best = 0usize;
            let mut best_d = f32::MAX;
            for (k, c) in centers.iter().enumerate() {
                let d = (p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2) + (p[2] - c[2]).powi(2);
                if d < best_d {
                    best_d = d;
                    best = k;
                }
            }
            sums[best][0] += p[0];
            sums[best][1] += p[1];
            sums[best][2] += p[2];
            n[best] += 1;
        }
        for k in 0..K {
            if n[k] > 0 {
                centers[k] = [
                    sums[k][0] / n[k] as f32,
                    sums[k][1] / n[k] as f32,
                    sums[k][2] / n[k] as f32,
                ];
            }
        }
    }

    // Dominant = cluster with most members.
    let dom_idx = n
        .iter()
        .enumerate()
        .max_by_key(|(_, c)| *c)
        .map(|(i, _)| i)
        .unwrap_or(0);
    let to_rgb = |c: [f32; 3]| {
        Rgb(
            c[0].round().clamp(0.0, 255.0) as u8,
            c[1].round().clamp(0.0, 255.0) as u8,
            c[2].round().clamp(0.0, 255.0) as u8,
        )
    };
    let dominant = to_rgb(centers[dom_idx]);

    let mut accents: Vec<(f32, Rgb)> = centers
        .iter()
        .enumerate()
        .map(|(i, c)| (vibrancy(to_rgb(*c)) * (n[i] as f32).sqrt(), to_rgb(*c)))
        .filter(|(v, _)| *v > 0.05)
        .collect();
    accents.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let accents: Vec<Rgb> = accents
        .into_iter()
        .map(|(_, c)| c)
        .filter(|c| *c != dominant)
        .take(4)
        .collect();

    Palette { dominant, accents }
}

/// Decode image bytes (png/jpeg) and extract a palette.
pub fn extract_palette_bytes(bytes: &[u8]) -> Result<Palette, image::ImageError> {
    let img = image::load_from_memory(bytes)?.to_rgb8();
    let (w, h) = img.dimensions();
    Ok(extract_palette(img.as_raw(), w, h))
}

pub fn to_hex(c: Rgb) -> String {
    format!("#{:02x}{:02x}{:02x}", c.0, c.1, c.2)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(c: Rgb, w: u32, h: u32) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 3) as usize);
        for _ in 0..w * h {
            v.extend_from_slice(&[c.0, c.1, c.2]);
        }
        v
    }

    #[test]
    fn solid_color_dominates() {
        let px = solid(Rgb(200, 30, 60), 32, 32);
        let p = extract_palette(&px, 32, 32);
        assert_eq!(p.dominant, Rgb(200, 30, 60));
    }

    #[test]
    fn two_regions_both_present() {
        let (w, h) = (32u32, 32u32);
        let mut px = vec![0u8; (w * h * 3) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 3) as usize;
                if x < w / 2 {
                    px[i..i + 3].copy_from_slice(&[220, 40, 40]);
                } else {
                    px[i..i + 3].copy_from_slice(&[40, 40, 220]);
                }
            }
        }
        let p = extract_palette(&px, w, h);
        let hexes: Vec<String> = std::iter::once(p.dominant)
            .chain(p.accents.iter().copied())
            .map(to_hex)
            .collect();
        let has = |r: u8, g: u8, b: u8| {
            hexes.iter().any(|h| {
                let c = (
                    u8::from_str_radix(&h[1..3], 16).unwrap(),
                    u8::from_str_radix(&h[3..5], 16).unwrap(),
                    u8::from_str_radix(&h[5..7], 16).unwrap(),
                );
                (c.0 as i32 - r as i32).abs() < 40
                    && (c.1 as i32 - g as i32).abs() < 40
                    && (c.2 as i32 - b as i32).abs() < 40
            })
        };
        assert!(has(220, 40, 40), "red region missing: {hexes:?}");
        assert!(has(40, 40, 220), "blue region missing: {hexes:?}");
    }

    #[test]
    fn degenerate_inputs_dont_panic() {
        extract_palette(&[], 0, 0);
        extract_palette(&[255], 1, 1);
    }

    #[test]
    fn hex_format() {
        assert_eq!(to_hex(Rgb(255, 0, 128)), "#ff0080");
    }

    #[test]
    fn deterministic() {
        let px = solid(Rgb(10, 200, 90), 16, 16);
        assert_eq!(
            extract_palette(&px, 16, 16).dominant,
            extract_palette(&px, 16, 16).dominant
        );
    }
}
