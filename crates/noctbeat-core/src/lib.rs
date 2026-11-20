//! noctbeat-core: platform logic for Noctbeat.
//!
//! Everything in this crate is UI-free and unit-testable without a display
//! server. The Tauri shell in `src-tauri` is a thin adapter over these modules.

pub mod branding;
pub mod energy;
pub mod library;
pub mod licensing;
pub mod lyrics;
pub mod media;
pub mod palette;
pub mod player;
pub mod providers;
pub mod settings;
