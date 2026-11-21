//! Branding read from the repository-root `branding.json`.
//! The product name is intentionally NOT final; see RENAMING.md.

use serde::Deserialize;

const BRANDING_JSON: &str = include_str!("../../../branding.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Branding {
    pub product_name: String,
    pub short_name: String,
    pub bundle_id: String,
    pub domain: String,
    pub alt_domain: String,
    pub tagline: String,
    pub description: String,
    pub version: String,
    pub author: String,
    pub homepage: String,
    pub repository: String,
    pub checkout_url: String,
    pub license_vendor: String,
    #[serde(default)]
    pub license_product_id: u64,
    /// Discord application id for Rich Presence. Empty disables the
    /// feature (no client to register against); the Settings toggle only
    /// appears once a real id is configured.
    #[serde(default)]
    pub discord_client_id: String,
    pub copyright: String,
}

static CACHED: std::sync::OnceLock<Branding> = std::sync::OnceLock::new();

/// Parsed branding. The JSON is compiled into the binary, so this cannot fail.
pub fn branding() -> &'static Branding {
    CACHED.get_or_init(|| serde_json::from_str(BRANDING_JSON).expect("branding.json is valid"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branding_parses() {
        let b = branding();
        assert_eq!(b.product_name, "Noctbeat");
        assert!(b.bundle_id.starts_with("com."));
        assert!(b.checkout_url.starts_with("https://"));
    }
}
