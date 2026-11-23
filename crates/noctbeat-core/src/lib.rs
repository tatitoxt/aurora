//! noctbeat-core: platform logic for Noctbeat.
//!
//! Everything in this crate is UI-free and unit-testable without a display
//! server. The Tauri shell in `src-tauri` is a thin adapter over these modules.

pub mod branding;
pub mod energy;
pub mod eq;
pub mod fx;
pub mod history;
pub mod library;
pub mod licensing;
pub mod listen;
pub mod lyrics;
pub mod media;
pub mod palette;
pub mod player;
pub mod playlists;
pub mod relay;
pub mod settings;
