fn main() {
    // WebKitGTK's DMA-BUF renderer falls back to a CPU repaint loop on
    // drivers without GBM support (VMs, some NVIDIA setups): ~450% CPU idle
    // vs ~30% with it off. Users can still opt back in by setting the var.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    noctbeat_app_lib::run();
}
