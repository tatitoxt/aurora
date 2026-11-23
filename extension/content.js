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
// "Search and play" from the app: open the provider's own search page in
// this tab and click play on the first track, so it plays with the user's
// account even when nothing was playing. SPA routes are tried first (no
// reload); otherwise the query survives a full navigation in sessionStorage.
const enc = encodeURIComponent;
const SEARCH = {
  "open.spotify.com": {
    url: (q) => `/search/${enc(q)}/tracks`,
    spa: true,
    play: [
      '[data-testid="tracklist-row"] [data-testid="play-button"]',
      '[data-testid="tracklist-row"] button[aria-label]',
    ],
    row: '[data-testid="tracklist-row"]',
  },
  "music.youtube.com": {
    url: (q) => `/search?q=${enc(q)}`,
    play: [
      "ytmusic-card-shelf-renderer ytmusic-play-button-renderer",
      "ytmusic-shelf-renderer ytmusic-play-button-renderer",
    ],
  },
  "youtube.com": {
    url: (q) => `/results?search_query=${enc(q)}`,
    play: ["ytd-video-renderer a#thumbnail"],
  },
  "soundcloud.com": {
    url: (q) => `/search/sounds?q=${enc(q)}`,
    spa: true,
    play: [".searchList__item .sc-button-play", ".soundList__item .sc-button-play"],
    // Signed-out tabs get an optional sign-in wall that holds playback.
    dismiss: [
      ".modal__closeButton",
      '.modal button[aria-label="Close"]',
      '.modal button[title="Close"]',
    ],
  },
  "music.apple.com": {
    url: (q) => `/${location.pathname.split("/")[1] || "us"}/search?term=${enc(q)}`,
    play: [
      '[data-testid="track-lockup"] [data-testid="play-button"]',
      '[data-testid="track-list-item"] button[aria-label*="Play"]',
      "button.play-button",
    ],
  },
  "listen.tidal.com": {
    url: (q) => `/search/tracks?q=${enc(q)}`,
    play: ['[data-test="tracklist-row"] [data-test="play-button"]', '[data-test="play-button"]'],
    row: '[data-test="tracklist-row"]',
  },
  amazon: {
    url: (q) => `/search/${enc(q)}`,
    play: [
      'music-image-row music-button[icon-name="play"]',
      'music-horizontal-item music-button[icon-name="play"]',
    ],
  },
};
const PENDING = "noctbeat.play";
// Amazon Music runs on regional hosts (music.amazon.de, .co.uk, ...).
const searchCfg = SEARCH[host] || (host.startsWith("music.amazon.") ? SEARCH.amazon : null);

function waitFor(sels, ms) {
  return new Promise((done) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el) {
          clearInterval(iv);
          return done(el);
        }
      }
      if (Date.now() - t0 > ms) {
        clearInterval(iv);
        done(null);
      }
    }, 250);
  });
}

async function clickFirst(cfg) {
  const el = await waitFor(cfg.play, 12000);
  if (el) {
    el.click();
    if (cfg.dismiss) void waitFor(cfg.dismiss, 5000).then((x) => x?.click());
    return true;
  }
  const row = cfg.row && document.querySelector(cfg.row);
  if (row) {
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    return true;
  }
  return false;
}

async function playQuery(q) {
  const cfg = searchCfg;
  if (!cfg) return;
  const path = cfg.url(q);
  if (cfg.spa) {
    history.pushState({}, "", path);
    dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    if (await clickFirst(cfg)) return;
  }
  sessionStorage.setItem(PENDING, q);
  location.assign(path);
}

const pendingQ = sessionStorage.getItem(PENDING);
if (pendingQ && searchCfg) {
  sessionStorage.removeItem(PENDING);
  void clickFirst(searchCfg);
}

function tick() {
  chrome.runtime.sendMessage({ type: "now-playing", payload: collect() }, (resp) => {
    void chrome.runtime.lastError;
    (resp?.commands || []).forEach(run);
    if (resp?.play?.query) void playQuery(resp.play.query);
  });
}

setInterval(tick, SEND_MS);
tick();
