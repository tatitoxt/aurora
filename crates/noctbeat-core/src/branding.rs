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
    pub copyright: String,
}

static mut CACHED: Option<Branding> = None;

/// Parsed branding. The JSON is compiled into the binary, so this cannot fail.
pub fn branding() -> &'static Branding {
    unsafe {
        if CACHED.is_none() {
            CACHED = Some(serde_json::from_str(BRANDING_JSON).expect("branding.json is valid"));
        }
        CACHED.as_ref().unwrap()
    }
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
