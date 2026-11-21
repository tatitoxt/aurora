import { expect, test } from "@playwright/test";

// The built app served statically uses the browser mock bridge: a demo queue,
// live now-playing events and a public mp4 for resolveVideo. These specs cover
// the interactions users hit in the real window.
const APP = "http://localhost:4812";

test.describe("Noctbeat player", () => {
  test("minimal nav: library, settings, share, commands, fullscreen only", async ({ page }) => {
    await page.goto(`${APP}/#/`);
    const nav = page.locator(".pnav");
    await expect(nav).toBeVisible();
    await expect(nav.locator("a,button")).toHaveCount(5);
    await expect(nav.locator('a[href="#/library"]')).toBeVisible();
    await expect(nav.locator('a[href="#/settings"]')).toBeVisible();
  });

  test("view modes switch art / lyrics", async ({ page }) => {
    await page.goto(`${APP}/#/`);
    await expect(page.locator(".player__modes")).toBeVisible();
    await page.getByLabel("Lyrics").click();
    await expect(page.locator(".player__lyrfill")).toBeVisible();
    await page.getByLabel("Cover art").click();
    await expect(page.locator(".player__lyrfill")).toHaveCount(0);
  });

  test("videoclip mode: lyrics overlay + toggle", async ({ page }) => {
    await page.goto(`${APP}/#/`);
    await page.getByLabel("Music video").click();
    const overlay = page.locator(".player__lyrover");
    await expect(overlay).toBeVisible();
    const toggle = page.locator(".player__lyrtoggle");
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(overlay).toHaveCount(0);
    await toggle.click();
    await expect(overlay).toBeVisible();
  });

  test("progress bar seeks the track", async ({ page }) => {
    await page.goto(`${APP}/#/`);
    const time = page.locator(".player__times span").first();
    await expect(time).toBeVisible();
    const before = await time.textContent();
    const bar = page.locator(".player__progress");
    const box = await bar.boundingBox();
    await bar.click({ position: { x: box!.width * 0.8, y: box!.height / 2 } });
    await expect.poll(async () => (await time.textContent()) ?? "").not.toBe(before ?? "");
    const [m, s] = ((await time.textContent()) ?? "0:00").split(":").map(Number);
    expect(m * 60 + s).toBeGreaterThan(120);
  });
});

test.describe("Fullscreen carousel", () => {
  test("scrolling browses without changing the track", async ({ page }) => {
    await page.goto(`${APP}/#/fullscreen`);
    const covers = page.locator(".fs__covers");
    await expect(covers).toBeVisible();
    const before = await page.locator(".fs__cvtitle").textContent();

    const box = await covers.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 500);
    await page.mouse.wheel(0, 500);
    // pointer drag also browses only
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 - 120, box!.y + box!.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    await expect(page.locator(".fs__cvtitle")).toHaveText(before ?? "");
    const scrollLeft = await covers.evaluate((el) => el.scrollLeft);
    expect(scrollLeft).toBeGreaterThan(0);
  });

  test("clicking a side cover changes the track", async ({ page }) => {
    await page.goto(`${APP}/#/fullscreen`);
    await expect(page.locator(".fs__covers")).toBeVisible();
    const before = await page.locator(".fs__cvtitle").textContent();
    await page.locator(".fs__cover--r").first().click();
    await expect(page.locator(".fs__cvtitle")).not.toHaveText(before ?? "");
  });
});
