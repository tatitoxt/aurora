// Noctbeat Bridge — service worker. Content scripts cannot fetch
// http://127.0.0.1 from an https page (Private Network Access), so they
// send their snapshot here and we POST it to the running Noctbeat app.
const ENDPOINT = "http://127.0.0.1:17893/now-playing";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "now-playing") return false;
  fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg.payload),
  })
    .then((r) => r.json())
    .then((d) => sendResponse(d))
    .catch(() => sendResponse({ commands: [] }));
  return true; // async sendResponse
});
