// tauri-driver E2E: drives the built app over WebDriver on Linux (xvfb).
// Requires: cargo install tauri-driver, a `noctbeat` debug build, xvfb + webkitgtk driver.
// Run: NOCTBEAT_DEMO=1 node e2e/app.test.mjs
import { spawn } from "node:child_process";
import http from "node:http";

const DRIVER_PORT = 4444;
const APP = process.env.NOCTBEAT_BIN || "target/debug/noctbeat";

const driver = spawn("tauri-driver", ["--port", String(DRIVER_PORT)], { stdio: "inherit" });
await new Promise((r) => setTimeout(r, 1500));

async function wd(method, path, body) {
  const data = body ? JSON.stringify(body) : null;
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "localhost", port: DRIVER_PORT, path, method },
      (r) => {
        let buf = "";
        r.on("data", (c) => (buf += c));
        r.on("end", () => resolve({ status: r.statusCode, body: JSON.parse(buf || "{}") }));
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
  return res;
}

let session;
try {
  const created = await wd("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        "tauri:options": {
          application: APP,
          env: { NOCTBEAT_DEMO: "1" },
        },
      },
    },
  });
  session = created.body.value?.sessionId ?? created.body.sessionId;
  if (!session) throw new Error(`no session: ${JSON.stringify(created.body)}`);

  // The app opens several windows (player, HUD, edge overlays) — find the one
  // that hosts the mini player. The webview can take ~1min on a cold runner.
  // Read the title via execute/sync: the element/text endpoint is flaky on
  // webkitgtk (returns "" for found elements).
  let text = "";
  const script = "return document.querySelector('.player__title')?.textContent ?? null";
  for (let i = 0; i < 45 && !/Aurora Reversal|Slow Meridian|Glass Tide/.test(text); i++) {
    const handles = await wd("GET", `/session/${session}/window`);
    for (const h of handles.body.value ?? []) {
      await wd("POST", `/session/${session}/window`, { handle: h });
      const r = await wd("POST", `/session/${session}/execute/sync`, { script, args: [] });
      if (r.status === 200 && typeof r.body.value === "string" && r.body.value) {
        text = r.body.value;
        if (/Aurora Reversal|Slow Meridian|Glass Tide/.test(text)) break;
      }
    }
    if (!/Aurora Reversal|Slow Meridian|Glass Tide/.test(text)) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!/Aurora Reversal|Slow Meridian|Glass Tide/.test(text)) {
    throw new Error(`expected a demo track title, got "${text}"`);
  }
  console.log(`E2E ok: mini player shows "${text}" in NOCTBEAT_DEMO mode`);
} finally {
  if (session) await wd("DELETE", `/session/${session}`);
  driver.kill();
}
