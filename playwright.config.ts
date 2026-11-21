import { defineConfig } from "@playwright/test";

// site.spec.ts: landing page tests over the static site server.
// app.spec.ts: built-app tests over dist/ served statically (browser mock
// bridge supplies a demo queue + now-playing events). Needs `pnpm build`
// first so dist/ exists.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.ts",
  timeout: 15_000,
  use: {
    baseURL: "http://localhost:4810",
  },
  webServer: [
    {
      command: "node scripts/serve-site.mjs",
      url: "http://localhost:4810",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "python3 -m http.server 4812 --bind 127.0.0.1 -d dist",
      url: "http://localhost:4812",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
