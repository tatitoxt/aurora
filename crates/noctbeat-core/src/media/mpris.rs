//! Linux MPRIS source (implemented in the core-media branch).

use super::{MediaError, NowPlayingSource};

pub struct MprisSource;

impl MprisSource {
    pub fn new() -> Result<Self, MediaError> {
        Err(MediaError::Unsupported)
    }
}

impl NowPlayingSource for MprisSource {
    fn name(&self) -> &'static str {
        "mpris"
    }
    fn poll(&mut self) -> Result<super::NowPlaying, MediaError> {
        Err(MediaError::Unsupported)
    }
    fn control(&mut self, _cmd: super::Control) -> Result<(), MediaError> {
        Err(MediaError::Unsupported)
    }
}
