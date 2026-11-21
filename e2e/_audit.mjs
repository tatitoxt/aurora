import { chromium } from '@playwright/test';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 420, height: 700 } });
const fails = [], logs = [];
p.on('console', m => { if (m.type() === 'error') logs.push('console: ' + m.text().slice(0, 200)); });
p.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 200)));
const shot = async (name, path, w, h, wait = 1800) => {
  await p.setViewportSize({ width: w, height: h });
  await p.goto('http://localhost:5199/#' + path);
  await p.waitForTimeout(wait);
  await p.screenshot({ path: `/tmp/audit/${name}.png` });
};
const check = (name, ok) => { if (!ok) fails.push(name); };

await p.goto('http://localhost:5199/#/');
await p.waitForTimeout(1500);
// 1. transport works
const title1 = await p.textContent('.np__title, [class*=title]').catch(() => '');
await p.click('button[aria-label="Next"], [class*=next]').catch(() => {});
await p.waitForTimeout(1200);
// screenshots of every route at real sizes
await shot('01-player', '/', 420, 700);
await shot('02-settings', '/settings', 420, 700);
await shot('03-library', '/library', 420, 700);
await shot('04-stats', '/stats', 420, 700);
await shot('05-wrapped', '/wrapped', 420, 700);
await shot('06-visualizer', '/visualizer', 420, 700);
await shot('07-hud', '/hud', 400, 120);
await shot('08-desklyrics', '/desklyrics', 700, 160);
await shot('09-edge', '/edge', 1600, 900, 1200);
await shot('10-fullscreen', '/fullscreen', 1600, 900, 2500);
// palette
await p.goto('http://localhost:5199/#/');
await p.waitForTimeout(800);
await p.keyboard.press('Control+k');
await p.waitForTimeout(600);
check('palette opens', !!(await p.$('.palette')));
await p.screenshot({ path: '/tmp/audit/11-palette.png' });
await p.keyboard.press('Escape');
// seek via progress bar on player
await p.waitForTimeout(500);
const bar = await p.$('.np__bar, [class*=bar]');
check('player progress bar exists', !!bar);
console.log('FAILS:', JSON.stringify(fails));
console.log('LOGS:', JSON.stringify(logs.slice(0, 10)));
await b.close();
