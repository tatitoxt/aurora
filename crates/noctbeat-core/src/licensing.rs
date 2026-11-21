//! License validation against the Lemon Squeezy license-key API.
//! Source builds work without a key; official signed builds call this on
//! activation and when grace needs refreshing. No keys live in the repo.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const GRACE_MS: u64 = 72 * 3_600_000; // 72h offline grace

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum LicenseState {
    /// Never activated or no key stored — source-build mode.
    Unlicensed,
    Valid {
        customer_email: Option<String>,
        last_validated_ms: u64,
    },
    Invalid {
        reason: String,
    },
    /// Last validation passed but we cannot reach the server now.
    Offline {
        grace_until_ms: u64,
    },
}

/// Injectable HTTP so tests never touch the network.
pub trait Http {
    fn post_json(&self, url: &str, body: &str) -> Result<String, String>;
}

pub struct UreqHttp;

impl Http for UreqHttp {
    fn post_json(&self, url: &str, body: &str) -> Result<String, String> {
        ureq::post(url)
            .set("Content-Type", "application/x-www-form-urlencoded")
            .set("Accept", "application/json")
            .send_string(body)
            .map_err(|e| e.to_string())?
            .into_string()
            .map_err(|e| e.to_string())
    }
}

pub struct LicenseClient<'a> {
    pub base_url: &'a str,
    pub http: &'a dyn Http,
    /// Where `license.json` (last good validation) is persisted.
    pub state_path: PathBuf,
    pub instance_name: String,
    /// Injectable clock for tests.
    pub now_ms: fn() -> u64,
}

#[derive(Serialize, Deserialize)]
struct StoredLicense {
    key: String,
    customer_email: Option<String>,
    last_validated_ms: u64,
}

impl<'a> LicenseClient<'a> {
    fn expected_product_id(&self) -> u64 {
        crate::branding::branding().license_product_id
    }

    pub fn new(http: &'a dyn Http, state_path: impl Into<PathBuf>) -> Self {
        Self {
            base_url: "https://api.lemonsqueezy.com",
            http,
            state_path: state_path.into(),
            instance_name: "noctbeat-desktop".into(),
            now_ms: crate::lyrics::unix_ms,
        }
    }

    /// Current state: check the stored license without contacting the vendor
    /// unless `revalidate` is set.
    pub fn state(&self) -> LicenseState {
        let Some(stored) = self.read() else {
            return LicenseState::Unlicensed;
        };
        LicenseState::Valid {
            customer_email: stored.customer_email,
            last_validated_ms: stored.last_validated_ms,
        }
    }

    /// Activate a key with the vendor. Persists success for offline grace.
    pub fn activate(&self, key: &str) -> LicenseState {
        let body = format!(
            "license_key={}&instance_name={}",
            urlencoded(key),
            urlencoded(&self.instance_name)
        );
        let url = format!("{}/v1/licenses/validate", self.base_url);
        match self.http.post_json(&url, &body) {
            Ok(text) => match parse_validate(&text, self.expected_product_id()) {
                Ok(Some(customer_email)) => {
                    let st = StoredLicense {
                        key: key.to_string(),
                        customer_email: customer_email.clone(),
                        last_validated_ms: (self.now_ms)(),
                    };
                    let _ = self.write(&st);
                    LicenseState::Valid {
                        customer_email,
                        last_validated_ms: st.last_validated_ms,
                    }
                }
                Ok(None) => LicenseState::Invalid {
                    reason: "license key is not valid".into(),
                },
                Err(reason) => LicenseState::Invalid { reason },
            },
            Err(net) => self.offline_or_invalid(&net),
        }
    }

    /// Periodic re-check: refresh grace when online, keep grace when offline.
    pub fn refresh(&self) -> LicenseState {
        let Some(stored) = self.read() else {
            return LicenseState::Unlicensed;
        };
        let body = format!(
            "license_key={}&instance_name={}",
            urlencoded(&stored.key),
            urlencoded(&self.instance_name)
        );
        let url = format!("{}/v1/licenses/validate", self.base_url);
        match self.http.post_json(&url, &body) {
            Ok(text) => match parse_validate(&text, self.expected_product_id()) {
                Ok(Some(email)) => {
                    let st = StoredLicense {
                        last_validated_ms: (self.now_ms)(),
                        customer_email: email.clone(),
                        ..stored
                    };
                    let _ = self.write(&st);
                    LicenseState::Valid {
                        customer_email: email,
                        last_validated_ms: st.last_validated_ms,
                    }
                }
                _ => {
                    let _ = std::fs::remove_file(&self.state_path);
                    LicenseState::Invalid {
                        reason: "license is no longer valid".into(),
                    }
                }
            },
            Err(net) => self.offline_or_invalid(&net),
        }
    }

    /// Remove the stored key. A missing file is fine; real I/O errors are
    /// returned so callers don't claim success while the key survives.
    pub fn deactivate(&self) -> std::io::Result<()> {
        match std::fs::remove_file(&self.state_path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    fn offline_or_invalid(&self, _net: &str) -> LicenseState {
        let Some(stored) = self.read() else {
            return LicenseState::Invalid {
                reason: "no network and no stored license".into(),
            };
        };
        let grace_until = stored.last_validated_ms + GRACE_MS;
        if (self.now_ms)() <= grace_until {
            LicenseState::Offline {
                grace_until_ms: grace_until,
            }
        } else {
            LicenseState::Invalid {
                reason: "offline grace period (72h) expired".into(),
            }
        }
    }

    fn read(&self) -> Option<StoredLicense> {
        let text = std::fs::read_to_string(&self.state_path).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn write(&self, st: &StoredLicense) -> std::io::Result<()> {
        if let Some(dir) = self.state_path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&self.state_path, serde_json::to_string(st)?)
    }
}

fn urlencoded(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}

/// Lemon Squeezy returns `{valid: bool, license_key: {status}, meta:{store_id},
/// customer_email?}` — success = valid && status=="active".
/// Returns Ok(Some(email)) valid, Ok(None) invalid, Err(reason) malformed.
fn parse_validate(text: &str, expected_product_id: u64) -> Result<Option<Option<String>>, String> {
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("bad response: {e}"))?;
    let valid = v.get("valid").and_then(|x| x.as_bool()).unwrap_or(false);
    let status = v
        .pointer("/license_key/status")
        .and_then(|s| s.as_str())
        .unwrap_or("");
    if !valid {
        return Ok(None);
    }
    if status != "active" {
        return Err(format!("license status is '{status}'"));
    }
    // A key is only valid for THIS product once a product id is configured.
    if expected_product_id != 0 {
        let pid = v
            .pointer("/license_key/product_id")
            .or_else(|| v.pointer("/meta/product_id"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0);
        if pid != expected_product_id {
            return Err("key belongs to a different product".to_string());
        }
    }
    let email = v
        .get("customer_email")
        .or_else(|| v.pointer("/meta/customer_email"))
        .and_then(|e| e.as_str())
        .map(|s| s.to_string());
    Ok(Some(email))
}

#[allow(dead_code)]
fn unused(_: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockHttp(Result<String, String>);
    impl Http for MockHttp {
        fn post_json(&self, _u: &str, _b: &str) -> Result<String, String> {
            self.0.clone()
        }
    }

    fn tmp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("noctbeat-lic-{}-{tag}", std::process::id()))
    }

    const VALID: &str =
        r#"{"valid":true,"license_key":{"status":"active"},"customer_email":"a@b.c"}"#;

    #[test]
    fn activate_valid_persists() {
        let http = MockHttp(Ok(VALID.into()));
        let dir = tmp("a");
        let c = LicenseClient::new(&http, dir.join("license.json"));
        match c.activate("KEY") {
            LicenseState::Valid { customer_email, .. } => {
                assert_eq!(customer_email.as_deref(), Some("a@b.c"))
            }
            s => panic!("expected Valid, got {s:?}"),
        }
        assert!(matches!(c.state(), LicenseState::Valid { .. }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn activate_invalid_key() {
        let http = MockHttp(Ok(
            r#"{"valid":false,"error":"license_key not found"}"#.into()
        ));
        let c = LicenseClient::new(&http, tmp("i").join("license.json"));
        assert!(matches!(c.activate("BAD"), LicenseState::Invalid { .. }));
    }

    #[test]
    fn suspended_key_is_invalid() {
        let http = MockHttp(Ok(
            r#"{"valid":true,"license_key":{"status":"disabled"}}"#.into()
        ));
        let c = LicenseClient::new(&http, tmp("s").join("license.json"));
        match c.activate("K") {
            LicenseState::Invalid { reason } => assert!(reason.contains("disabled")),
            s => panic!("expected Invalid, got {s:?}"),
        }
    }

    #[test]
    fn offline_within_grace() {
        let ok = MockHttp(Ok(VALID.into()));
        let dir = tmp("g");
        let path = dir.join("license.json");
        let good = LicenseClient::new(&ok, &path);
        static mut T: u64 = 1_000_000;
        fn now() -> u64 {
            unsafe { T }
        }
        let good = LicenseClient {
            now_ms: now,
            ..good
        };
        good.activate("KEY");
        // Offline 1h later: still within grace.
        unsafe { T += 3_600_000 };
        let bad = MockHttp(Err("network down".into()));
        let c = LicenseClient {
            http: &bad,
            now_ms: now,
            ..LicenseClient::new(&bad, &path)
        };
        match c.refresh() {
            LicenseState::Offline { grace_until_ms } => {
                assert_eq!(grace_until_ms, 1_000_000 + GRACE_MS)
            }
            s => panic!("expected Offline, got {s:?}"),
        }
        // Past grace: invalid.
        unsafe { T += GRACE_MS + 1 };
        match c.refresh() {
            LicenseState::Invalid { reason } => assert!(reason.contains("expired")),
            s => panic!("expected Invalid, got {s:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unlicensed_when_no_file() {
        let http = MockHttp(Err("net".into()));
        let c = LicenseClient::new(&http, tmp("u").join("license.json"));
        assert_eq!(c.state(), LicenseState::Unlicensed);
    }
}
