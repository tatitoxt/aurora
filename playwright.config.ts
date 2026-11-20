import { defineConfig } from "@playwright/test";

// Landing page tests: static server over site/.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "site.spec.ts",
  timeout: 15_000,
  use: {
    baseURL: "http://localhost:4810",
  },
  webServer: {
    command: "node scripts/serve-site.mjs",
    url: "http://localhost:4810",
    reuseExistingServer: !process.env.CI,
  },
});
