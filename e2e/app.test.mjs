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

  // The main window should show the mini player with a demo track.
  await new Promise((r) => setTimeout(r, 4000));
  const handles = await wd("GET", `/session/${session}/window`);
  const first = handles.body.value?.[0];
  if (first) await wd("POST", `/session/${session}/window`, { handle: first });

  const el = await wd("POST", `/session/${session}/element`, {
    using: "css selector",
    value: ".player__title",
  });
  // Element refs: find the first string value (drivers differ in shape).
  const flat = (v) => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      for (const x of Object.values(v)) {
        const s = flat(x);
        if (s) return s;
      }
    }
    return "";
  };
  const elId = flat(el.body.value);
  const text = elId
    ? (await wd("GET", `/session/${session}/element/${encodeURIComponent(elId)}/text`)).body.value
    : "";
  if (!/Neon Reversal|Slow Meridian|Glass Tide/.test(text)) {
    throw new Error(`expected a demo track title, got "${text}"`);
  }
  console.log(`E2E ok: mini player shows "${text}" in NOCTBEAT_DEMO mode`);
} finally {
  if (session) await wd("DELETE", `/session/${session}`);
  driver.kill();
}
