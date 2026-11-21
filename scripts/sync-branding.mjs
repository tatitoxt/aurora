#!/usr/bin/env node
// Regenerates every file that embeds product branding from branding.json.
// Rename the product by editing branding.json, then run `pnpm branding`.
// See RENAMING.md for the full checklist.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const brand = JSON.parse(readFileSync(join(root, "branding.json"), "utf8"));

const write = (rel, content) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  console.log(`wrote ${rel}`);
};

// --- src-tauri/tauri.conf.json -------------------------------------------
// The updater pubkey lives in tauri.conf.json only; carry it forward so a
// branding sync never silently disables auto-update.
const prevConf = existsSync(join(root, "src-tauri/tauri.conf.json"))
  ? JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"))
  : {};
const prevUpdater = prevConf.plugins?.updater;
const conf = {
  $schema: "https://schema.tauri.app/config/2",
  productName: brand.productName,
  version: brand.version,
  identifier: brand.bundleId,
  build: {
    frontendDist: "../dist",
    devUrl: "http://localhost:1420",
    beforeDevCommand: "pnpm dev",
    beforeBuildCommand: "pnpm build",
  },
  app: {
    windows: [
      {
        label: "player",
        title: brand.productName,
        width: 340,
        height: 560,
        resizable: false,
        decorations: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
      },
    ],
    security: {
      csp: null,
      assetProtocol: { enable: true, scope: ["$APPDATA/**"] },
    },
  },
  bundle: {
    active: true,
    targets: "all",
    icon: [
      "icons/32x32.png",
      "icons/64x64.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico",
    ],
    category: "Music",
    shortDescription: brand.description,
    longDescription: brand.description,
    copyright: brand.copyright,
    createUpdaterArtifacts: true,
  },
  plugins: {
    updater: {
      pubkey: prevUpdater?.pubkey ?? brand.updaterPubkey ?? "",
      endpoints: [
        "https://github.com/tatitoxt/aurora/releases/latest/download/latest.json",
      ],
      windows: { installMode: "passive" },
    },
  },
};
write("src-tauri/tauri.conf.json", JSON.stringify(conf, null, 2) + "\n");

// --- src/branding.ts (generated; do not edit) ------------------------------
write(
  "src/branding.ts",
  `// GENERATED from branding.json by scripts/sync-branding.mjs — do not edit.
export const branding = ${JSON.stringify(brand, null, 2)} as const;
`,
);

// --- site/branding.js (generated; do not edit) -----------------------------
write(
  "site/branding.js",
  `// GENERATED from branding.json by scripts/sync-branding.mjs — do not edit.
window.BRANDING = ${JSON.stringify(brand, null, 2)};
`,
);

console.log(`\nBranding synced: "${brand.productName}" (${brand.bundleId})`);
