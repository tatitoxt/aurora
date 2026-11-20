//! Windows SMTC source (implemented in the core-media branch).

use super::{MediaError, NowPlayingSource};

pub struct SmtcSource;

impl SmtcSource {
    pub fn new() -> Result<Self, MediaError> {
        Err(MediaError::Unsupported)
    }
}

impl NowPlayingSource for SmtcSource {
    fn name(&self) -> &'static str {
        "smtc"
    }
    fn poll(&mut self) -> Result<super::NowPlaying, MediaError> {
        Err(MediaError::Unsupported)
    }
    fn control(&mut self, _cmd: super::Control) -> Result<(), MediaError> {
        Err(MediaError::Unsupported)
    }
}
