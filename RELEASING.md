# Releasing

`build.yml` produces unsigned bundles for Linux/macOS/Windows on every push to main and every `v*` tag. For commercial distribution you want signed builds + license sales.

## Signing

Set these repo secrets (never in-tree):

- `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — `pnpm tauri signer generate` produces the updater keypair; the public key goes in `tauri.conf.json` → `plugins.updater.pubkey`.
- macOS: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` for Developer ID signing + notarization.
- Windows: `WINDOWS_CERTIFICATE` + password (or a HSM/KeyVault flow) fed to `signtool`/tauri-bundler.

Then replace `--no-sign` with a signed `pnpm tauri build` on tag builds.

## Licensing (Lemon Squeezy)

1. Create a product; enable license keys.
2. Put the product checkout URL in `branding.json` → `checkoutUrl`, run `pnpm branding`.
3. The app calls `POST {store}/v1/licenses/validate` on activate and on launch; results persist with a 72 h offline grace (`license.json` in the app config dir). Instance activation uses `licenses/activate`; deactivation `licenses/deactivate`.
