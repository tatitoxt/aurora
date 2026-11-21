// Noctbeat Bridge — content script. Reads Media Session metadata (which
// YouTube Music, Spotify, SoundCloud, Apple Music and Tidal all publish)
// plus the <audio>/<video> element for position/duration, posts it to the
// app via the background worker, and executes transport commands the app
// sends back by clicking the site's own controls.

const SEND_MS = 1500;
const TAB_ID = crypto.randomUUID();
const host = location.hostname.replace(/^www\./, "");

const BUTTONS = {
  "music.youtube.com": {
    pp: "tp-yt-paper-icon-button.play-pause-button, #play-pause-button",
    next: ".next-button, tp-yt-paper-icon-button[title*='Next'], #next-button",
    prev: ".previous-button, tp-yt-paper-icon-button[title*='Previous'], #previous-button",
  },
  "youtube.com": {
    pp: ".ytp-play-button",
    next: ".ytp-next-button",
    prev: ".ytp-prev-button",
  },
  "open.spotify.com": {
    pp: '[data-testid="control-button-playpause"]',
    next: '[data-testid="control-button-skip-forward"]',
    prev: '[data-testid="control-button-skip-back"]',
  },
  "soundcloud.com": {
    pp: ".playControl",
    next: ".skipControl__next",
    prev: ".skipControl__previous",
  },
  "music.apple.com": {
    pp: '.web-chrome-playback-controls__main button[aria-label*="Play"], button.playback-button--play',
    next: 'button[aria-label*="Next"]',
    prev: 'button[aria-label*="Previous"]',
  },
  "listen.tidal.com": {
    pp: '[data-test="play"], [data-test="pause"]',
    next: '[data-test="next"]',
    prev: '[data-test="previous"]',
  },
};

function mediaEl() {
  return document.querySelector("audio, video");
}

// Media Session artwork is usually offered in several sizes; also rewrite
// host-specific URL sizing suffixes to pull the original/hi-res variant.
function hiResArt(src) {
  if (!src) return src;
  try {
    const u = new URL(src);
    // YouTube Music / Google: =w120-h120-l90-rj style suffix -> w1200.
    if (/(^|\.)googleusercontent\.com$/.test(u.hostname)) {
      return src.replace(/=w\d+(-h\d+)?[^/]*$/, "=w1200-h1200");
    }
    // SoundCloud: -large/-t300x300/-t500x500 -> -original (full-size upload).
    if (/(^|\.)sndcdn\.com$/.test(u.hostname)) {
      return src.replace(/-(large|t\d+x\d+|crop|original)\.(jpg|jpeg|png|webp)$/i, "-original.$2");
    }
    // Apple Music: /{w}x{h}bb.jpg -> 1200x1200.
    if (/(^|\.)mzstatic\.com$/.test(u.hostname)) {
      return src.replace(/\/\d+x\d+(bb|cc|sc)\.(jpg|jpeg|png|webp)/i, "/1200x1200$1.$2");
    }
    // Tidal: .../80x80.jpg, /320x320.jpg ... -> 1280x1280.
    if (/(^|\.)tidalh\.com$/.test(u.hostname) || /(^|\.)tidal\.com$/.test(u.hostname)) {
      return src.replace(/\/\d+x\d+\.(jpg|jpeg|png|webp)/i, "/1280x1280.$1");
    }
  } catch (e) { /* malformed URL: return as-is */ }
  return src;
}

function collect() {
  const m = navigator.mediaSession?.metadata;
  const el = mediaEl();
  const art = hiResArt((m?.artwork || []).slice(-1)[0]?.src || "");
  return {
    tabId: TAB_ID,
    provider: host,
    title: m?.title || "",
    artist: m?.artist || "",
    album: m?.album || "",
    artworkUrl: art,
    durationMs: el && isFinite(el.duration) ? Math.round(el.duration * 1000) : 0,
    positionMs: el ? Math.round(el.currentTime * 1000) : 0,
    playing: el ? !el.paused : false,
    url: location.href,
  };
}

function click(sel) {
  const el = sel && document.querySelector(sel);
  if (el) el.click();
  return !!el;
}

function run(cmd) {
  const btns = BUTTONS[host] || {};
  const el = mediaEl();
  if (cmd === "play-pause") {
    if (!click(btns.pp) && el) el.paused ? el.play() : el.pause();
  } else if (cmd === "next") {
    click(btns.next);
  } else if (cmd === "previous") {
    click(btns.prev);
  }
}

// Post every tick even when nothing changed: the reply is also the
// transport-command channel, so a paused tab must keep polling or desktop
// controls (resume/skip) would sit queued forever.
function tick() {
  chrome.runtime.sendMessage({ type: "now-playing", payload: collect() }, (resp) => {
    void chrome.runtime.lastError;
    (resp?.commands || []).forEach(run);
  });
}

setInterval(tick, SEND_MS);
tick();
