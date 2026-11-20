#!/usr/bin/env node
// Regenerates every file that embeds product branding from branding.json.
// Rename the product by editing branding.json, then run `pnpm branding`.
// See RENAMING.md for the full checklist.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
    security: { csp: null },
  },
  bundle: {
    active: true,
    targets: "all",
    icon: [],
    category: "Music",
    shortDescription: brand.description,
    longDescription: brand.description,
    copyright: brand.copyright,
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
