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
    /// Lemon Squeezy instance id minted by `licenses/activate`; needed by
    /// `licenses/deactivate`. None for licenses stored before this field.
    #[serde(default)]
    instance_id: Option<String>,
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

    /// Activate a key with the vendor: POST `licenses/activate` mints an
    /// instance bound to this machine name. Persists the key, the customer
    /// email and the instance id for offline grace and later deactivation.
    pub fn activate(&self, key: &str) -> LicenseState {
        let body = format!(
            "license_key={}&instance_name={}",
            urlencoded(key),
            urlencoded(&self.instance_name)
        );
        let url = format!("{}/v1/licenses/activate", self.base_url);
        match self.http.post_json(&url, &body) {
            Ok(text) => match parse_activate(&text, self.expected_product_id()) {
                Ok(Some(act)) => {
                    let prev = self.read();
                    let st = StoredLicense {
                        key: key.to_string(),
                        customer_email: act.customer_email.clone(),
                        last_validated_ms: (self.now_ms)(),
                        instance_id: act.instance_id,
                    };
                    if let Err(e) = self.write(&st) {
                        // Roll back the activation we just consumed so a
                        // retry can't exhaust the key's slots.
                        if let Some(id) = &st.instance_id {
                            self.post_deactivate(&st.key, id);
                        }
                        return LicenseState::Invalid {
                            reason: format!("could not save license: {e}"),
                        };
                    }
                    // Free the previous instance, if any — otherwise a
                    // second activation would strand its slot forever.
                    if let Some(prev) = prev {
                        if let Some(id) = &prev.instance_id {
                            if st.instance_id.as_deref() != Some(id.as_str()) {
                                self.post_deactivate(&prev.key, id);
                            }
                        }
                    }
                    LicenseState::Valid {
                        customer_email: st.customer_email.clone(),
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
    /// Sends the stored instance id when we have one so the vendor confirms
    /// this activation, not just the key.
    pub fn refresh(&self) -> LicenseState {
        let Some(stored) = self.read() else {
            return LicenseState::Unlicensed;
        };
        let body = match &stored.instance_id {
            Some(id) => format!(
                "license_key={}&instance_id={}",
                urlencoded(&stored.key),
                urlencoded(id)
            ),
            None => format!(
                "license_key={}&instance_name={}",
                urlencoded(&stored.key),
                urlencoded(&self.instance_name)
            ),
        };
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

    /// Free the vendor-side activation and remove the stored key. The
    /// `licenses/deactivate` call is best-effort (offline deactivation still
    /// clears this machine); a missing file is fine; real I/O errors are
    /// returned so callers don't claim success while the key survives.
    pub fn deactivate(&self) -> std::io::Result<()> {
        if let Some(stored) = self.read() {
            if let Some(id) = &stored.instance_id {
                self.post_deactivate(&stored.key, id);
            }
        }
        match std::fs::remove_file(&self.state_path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Best-effort `licenses/deactivate` for one instance. Errors are
    /// ignored: callers use it to free slots, never to decide state.
    fn post_deactivate(&self, key: &str, instance_id: &str) {
        let body = format!(
            "license_key={}&instance_id={}",
            urlencoded(key),
            urlencoded(instance_id)
        );
        let url = format!("{}/v1/licenses/deactivate", self.base_url);
        let _ = self.http.post_json(&url, &body);
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

struct Activation {
    customer_email: Option<String>,
    instance_id: Option<String>,
}

/// `licenses/activate` returns `{activated: bool, license_key:{status,
/// product_id}, instance:{id}, meta:{...}}` — success = activated &&
/// status=="active" and, once configured, the right product.
/// Returns Ok(Some(Activation)), Ok(None) not activated,
/// Err(reason) malformed.
fn parse_activate(text: &str, expected_product_id: u64) -> Result<Option<Activation>, String> {
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("bad response: {e}"))?;
    let activated = v
        .get("activated")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    if !activated {
        return Ok(None);
    }
    let status = v
        .pointer("/license_key/status")
        .and_then(|s| s.as_str())
        .unwrap_or("");
    if status != "active" {
        return Err(format!("license status is '{status}'"));
    }
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
    let instance_id = v
        .pointer("/instance/id")
        .and_then(|i| i.as_str())
        .map(|s| s.to_string());
    Ok(Some(Activation {
        customer_email: email,
        instance_id,
    }))
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

    /// Records every POST so tests can assert which endpoint was hit with
    /// what body.
    struct RecordingHttp {
        response: Result<String, String>,
        posts: std::cell::RefCell<Vec<(String, String)>>,
    }
    impl RecordingHttp {
        fn ok(body: &str) -> Self {
            Self {
                response: Ok(body.to_string()),
                posts: std::cell::RefCell::new(vec![]),
            }
        }
    }
    impl Http for RecordingHttp {
        fn post_json(&self, url: &str, body: &str) -> Result<String, String> {
            self.posts
                .borrow_mut()
                .push((url.to_string(), body.to_string()));
            self.response.clone()
        }
    }

    fn tmp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("noctbeat-lic-{}-{tag}", std::process::id()))
    }

    /// `licenses/activate` response shape; `valid:true` is harmless extra so
    /// the same mock can answer a follow-up `licenses/validate`.
    const ACT: &str = r#"{"activated":true,"valid":true,"license_key":{"status":"active"},
        "instance":{"id":"inst1"},"customer_email":"a@b.c"}"#;

    #[test]
    fn activate_valid_persists() {
        let http = MockHttp(Ok(ACT.into()));
        let dir = tmp("a");
        let c = LicenseClient::new(&http, dir.join("license.json"));
        match c.activate("KEY") {
            LicenseState::Valid { customer_email, .. } => {
                assert_eq!(customer_email.as_deref(), Some("a@b.c"))
            }
            s => panic!("expected Valid, got {s:?}"),
        }
        assert!(matches!(c.state(), LicenseState::Valid { .. }));
        let stored: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("license.json")).unwrap())
                .unwrap();
        assert_eq!(stored["instance_id"].as_str(), Some("inst1"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn activate_posts_to_activate_endpoint() {
        let http = RecordingHttp::ok(ACT);
        let dir = tmp("ep");
        let c = LicenseClient::new(&http, dir.join("license.json"));
        c.activate("K E Y");
        let posts = http.posts.borrow();
        assert_eq!(posts.len(), 1);
        assert!(posts[0].0.ends_with("/v1/licenses/activate"));
        assert!(posts[0].1.contains("license_key=K%20E%20Y"));
        assert!(posts[0].1.contains("instance_name=noctbeat-desktop"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refresh_sends_instance_id() {
        let http = RecordingHttp::ok(ACT);
        let dir = tmp("ri");
        let path = dir.join("license.json");
        let c = LicenseClient::new(&http, &path);
        c.activate("KEY");
        c.refresh();
        let posts = http.posts.borrow();
        assert_eq!(posts.len(), 2);
        assert!(posts[1].0.ends_with("/v1/licenses/validate"));
        assert!(posts[1].1.contains("instance_id=inst1"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reactivate_releases_previous_instance() {
        let http = RecordingHttp::ok(ACT);
        let dir = tmp("rp");
        let path = dir.join("license.json");
        let c = LicenseClient::new(&http, &path);
        c.activate("KEY1");
        // Second activation mints a new instance; the old one must be freed.
        let http2 = RecordingHttp::ok(
            r#"{"activated":true,"valid":true,"license_key":{"status":"active"},
                "instance":{"id":"inst2"},"customer_email":"a@b.c"}"#,
        );
        let c2 = LicenseClient {
            http: &http2,
            ..LicenseClient::new(&http2, &path)
        };
        match c2.activate("KEY2") {
            LicenseState::Valid { .. } => {}
            s => panic!("expected Valid, got {s:?}"),
        }
        let posts = http2.posts.borrow();
        assert_eq!(posts.len(), 2);
        assert!(posts[1].0.ends_with("/v1/licenses/deactivate"));
        assert!(posts[1].1.contains("instance_id=inst1"));
        assert!(posts[1].1.contains("license_key=KEY1"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_save_rolls_back_activation() {
        let http = RecordingHttp::ok(ACT);
        let dir = tmp("fs");
        std::fs::create_dir_all(&dir).unwrap();
        // A file where the license directory should be: create_dir_all fails.
        let blocker = dir.join("not-a-dir");
        std::fs::write(&blocker, "x").unwrap();
        let c = LicenseClient::new(&http, blocker.join("license.json"));
        match c.activate("KEY") {
            LicenseState::Invalid { reason } => assert!(reason.contains("save")),
            s => panic!("expected Invalid, got {s:?}"),
        }
        let posts = http.posts.borrow();
        assert_eq!(posts.len(), 2);
        assert!(posts[1].0.ends_with("/v1/licenses/deactivate"));
        assert!(posts[1].1.contains("instance_id=inst1"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deactivate_frees_instance_and_removes_file() {
        let http = RecordingHttp::ok(ACT);
        let dir = tmp("dc");
        let path = dir.join("license.json");
        let c = LicenseClient::new(&http, &path);
        c.activate("KEY");
        assert!(path.exists());
        c.deactivate().unwrap();
        assert!(!path.exists());
        let posts = http.posts.borrow();
        assert_eq!(posts.len(), 2);
        assert!(posts[1].0.ends_with("/v1/licenses/deactivate"));
        assert!(posts[1].1.contains("instance_id=inst1"));
        assert!(posts[1].1.contains("license_key=KEY"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deactivate_offline_still_clears() {
        let http = RecordingHttp {
            response: Err("offline".into()),
            posts: std::cell::RefCell::new(vec![]),
        };
        let dir = tmp("do");
        let path = dir.join("license.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            &path,
            r#"{"key":"K","customer_email":null,"last_validated_ms":1,"instance_id":"i9"}"#,
        )
        .unwrap();
        let c = LicenseClient::new(&http, &path);
        c.deactivate().unwrap();
        assert!(!path.exists());
        let posts = http.posts.borrow();
        assert_eq!(posts.len(), 1);
        assert!(posts[0].0.ends_with("/v1/licenses/deactivate"));
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
            r#"{"activated":true,"license_key":{"status":"disabled"}}"#.into(),
        ));
        let c = LicenseClient::new(&http, tmp("s").join("license.json"));
        match c.activate("K") {
            LicenseState::Invalid { reason } => assert!(reason.contains("disabled")),
            s => panic!("expected Invalid, got {s:?}"),
        }
    }

    #[test]
    fn offline_within_grace() {
        let ok = MockHttp(Ok(ACT.into()));
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
