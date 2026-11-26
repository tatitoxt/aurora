import { useEffect, useState } from "react";
import { bridge, subscribe, type LicenseState } from "./bridge";
import { branding } from "./branding";

const PREVIEW_TIER_KEY = "noctbeat.tierPreview";

let current: LicenseState | null = null;
let loading: Promise<LicenseState> | null = null;
const listeners = new Set<(s: LicenseState | null) => void>();

function notify() {
  listeners.forEach((cb) => cb(current));
}

/** Store a freshly activated/deactivated license so every premium gate in
 * the app flips immediately, without waiting for the next window load. */
export function setLicenseState(next: LicenseState) {
  current = next;
  notify();
}

function loadLicense() {
  if (!loading) {
    loading = bridge
      .getLicenseState()
      .then((s) => {
        setLicenseState(s);
        return s;
      })
      .catch(() => {
        const fallback: LicenseState = current ?? {
          state: "invalid",
          reason: "license state unavailable",
        };
        setLicenseState(fallback);
        return fallback;
      });
  }
  return loading;
}

/** Reactive license snapshot shared by every surface. */
export function useLicenseState() {
  const [state, setState] = useState<LicenseState | null>(current);
  useEffect(() => {
    const cb = (s: LicenseState | null) => setState(s);
    listeners.add(cb);
    const offLicense = subscribe<LicenseState>("license", setLicenseState);
    void loadLicense();
    return () => {
      listeners.delete(cb);
      offLicense();
    };
  }, []);
  return state;
}

/** Browser-preview override used by E2E and screenshots:
 * localStorage `noctbeat.tierPreview` = "free" | "premium". It never applies
 * to the desktop app. */
function previewTierOverride(): "free" | "premium" | null {
  if (bridge.isTauri()) return null;
  try {
    const v = localStorage.getItem(PREVIEW_TIER_KEY);
    return v === "free" || v === "premium" ? v : null;
  } catch {
    return null;
  }
}

export function licenseIsPremium(state: LicenseState | null) {
  if (state?.state === "valid") return true;
  /* The backend only emits Offline while grace is valid, but an open
     window can outlive that deadline — re-check the timestamp here
     instead of trusting the cached variant forever. */
  return state?.state === "offline" && state.grace_until_ms > Date.now();
}

/** Whether checkout/license enforcement is configured for this build. While
 * the Lemon Squeezy product id is still zero the app behaves as premium for
 * everyone — we cannot sell or validate a key yet, so locking users out
 * would be wrong. Setting the real product id turns enforcement on. */
export function premiumEnforced() {
  return branding.licenseProductId > 0;
}

export type PremiumStatus = "loading" | "free" | "premium";

export function usePremiumStatus(): PremiumStatus {
  const license = useLicenseState();
  const preview = previewTierOverride();
  if (preview) return preview;
  if (!premiumEnforced()) return "premium";
  if (!license) return "loading";
  return licenseIsPremium(license) ? "premium" : "free";
}

export function usePremium() {
  return usePremiumStatus() === "premium";
}
