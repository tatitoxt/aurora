import { describe, expect, it } from "vitest";
import { licenseIsPremium, premiumEnforced } from "../premium";

describe("premium tier", () => {
  it("accepts valid and offline-grace licenses", () => {
    expect(licenseIsPremium({ state: "valid", customer_email: null, last_validated_ms: 1 })).toBe(true);
    expect(licenseIsPremium({ state: "offline", grace_until_ms: Date.now() + 60_000 })).toBe(true);
  });

  it("rejects unlicensed, invalid and unknown states", () => {
    expect(licenseIsPremium({ state: "unlicensed" })).toBe(false);
    expect(licenseIsPremium({ state: "invalid", reason: "x" })).toBe(false);
    expect(licenseIsPremium(null)).toBe(false);
    expect(licenseIsPremium({ state: "offline", grace_until_ms: Date.now() - 1 })).toBe(false);
  });

  it("stays open while no Lemon Squeezy product is configured", () => {
    // branding.json ships licenseProductId 0 until the store product exists;
    // locking users out before checkout exists would be wrong.
    expect(premiumEnforced()).toBe(false);
  });
});
