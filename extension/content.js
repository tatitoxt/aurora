// Noctbeat Bridge — content script. Reads Media Session metadata (which
// YouTube Music, Spotify, SoundCloud, Apple Music and Tidal all publish)
// plus the <audio>/<video> element for position/duration, posts it to the
// app via the background worker, and executes transport commands the app
// sends back by clicking the site's own controls.

const SEND_MS = 1500;
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

function collect() {
  const m = navigator.mediaSession?.metadata;
  const el = mediaEl();
  const art = (m?.artwork || []).slice(-1)[0]?.src || "";
  return {
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
