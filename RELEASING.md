# Releasing

`build.yml` builds Linux/macOS/Windows bundles on every `v*` tag and opens a **draft GitHub Release** with the installers and updater artifacts (`latest.json` + signatures) via `tauri-action`.

## Auto-update

The updater plugin is wired end-to-end:

- `tauri.conf.json → plugins.updater` holds the minisign public key and polls `releases/latest/download/latest.json`.
- `bundle.createUpdaterArtifacts: true` makes the bundler emit `.sig` updater packages.
- The app checks on launch (player window only), downloads + installs in the background, then relaunches.

One manual step before the first release — add the private key as a repo secret:

```
gh secret set TAURI_SIGNING_PRIVATE_KEY < noctbeat-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -b "<password or empty>"
```

(The keypair was generated with `pnpm tauri signer generate`; the private key lives outside the repo — keep it safe, losing it means updates stop working. The matching public key is already committed in `tauri.conf.json`.)

Until those secrets exist, releases still publish but ship unsigned updater artifacts, so in-app update stays off.

## OS signing (store-quality)

- macOS: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` for Developer ID signing + notarization.
- Windows: `WINDOWS_CERTIFICATE` + password (or a HSM/KeyVault flow) fed to `signtool`/tauri-bundler.

## Licensing (Lemon Squeezy)

1. Create a product; enable license keys.
2. Put the product checkout URL in `branding.json` → `checkoutUrl`, run `pnpm branding`.
3. The app calls `POST {store}/v1/licenses/validate` on activate and on launch; results persist with a 72 h offline grace (`license.json` in the app config dir). Instance activation uses `licenses/activate`; deactivation `licenses/deactivate`.
