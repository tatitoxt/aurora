//! macOS osascript source (implemented in the core-media branch).

use super::{MediaError, NowPlayingSource};

pub struct OsascriptSource;

impl OsascriptSource {
    pub fn new() -> Self {
        Self
    }
}

impl NowPlayingSource for OsascriptSource {
    fn name(&self) -> &'static str {
        "osascript"
    }
    fn poll(&mut self) -> Result<super::NowPlaying, MediaError> {
        Err(MediaError::Unsupported)
    }
    fn control(&mut self, _cmd: super::Control) -> Result<(), MediaError> {
        Err(MediaError::Unsupported)
    }
}
