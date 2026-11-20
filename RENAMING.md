# Renaming the product

`branding.json` is the single source of truth:

```json
{ "productName": "Noctbeat", "bundleId": "com.noctbeat.app", ... }
```

Change the fields, then run:

```bash
pnpm branding   # regenerates src-tauri/tauri.conf.json, src/branding.ts, site/branding.js
```

`shortName` (lowercased `productName`) keys the config dir and settings files, so renaming creates a fresh config for existing users — acceptable pre-1.0, deliberate after.

Do not hard-code the name anywhere else; CI greps are the guardrail.
