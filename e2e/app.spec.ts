import { expect, test } from "@playwright/test";

// The built app served statically uses the browser mock bridge: a demo queue,
// live now-playing events and a public mp4 for resolveVideo. These specs cover
// the interactions users hit in the real window.
const APP = "http://localhost:4812";

test.describe("Noctbeat stage", () => {
  test("one layout: topbar, lyric center, covers strip, transport pill", async ({ page }) => {
    await page.goto(`${APP}/#/`);
    const topbar = page.locator(".fs__topbar");
    await expect(topbar).toBeVisible();
    await expect(topbar.locator('button[aria-label="Library"]')).toBeVisible();
    await expect(topbar.locator('button[aria-label="Settings"]')).toBeVisible();
    await expect(topbar.locator('button[aria-label="Open HUD"]')).toBeVisible();
    await expect(topbar.locator('button[aria-label="Lyrics"]')).toBeVisible();
    await expect(topbar.locator('button[aria-label="Fullscreen"]')).toBeVisible();
    await expect(page.locator(".fs__center")).toBeVisible();
    await expect(page.locator(".fs__covers")).toBeVisible();
    await expect(page.locator(".fs__pill")).toBeVisible();
    // videoclip backdrop is always resolved — no view-mode switcher anywhere
    await expect(page.locator(".player__modes")).toHaveCount(0);
    await expect(page.locator(".fs__styles")).toHaveCount(0);
  });

  test("lyrics toggle hides and restores the center lyric", async ({ page }) => {
    await page.goto(`${APP}/#/`);
    await expect(page.locator(".fs__lyrics")).toBeVisible();
    await page.locator(".fs__topbar").getByLabel("Lyrics").click();
    await expect(page.locator(".fs__lyrics")).toHaveCount(0);
    await page.locator(".fs__topbar").getByLabel("Lyrics").click();
    await expect(page.locator(".fs__lyrics")).toBeVisible();
  });

  test("seek hairline scrubs the track", async ({ page }) => {
    await page.goto(`${APP}/#/`);
    // wait for the first now-playing event so a seekable track is loaded
    await page.waitForSelector(".fs__hair:not(.fs__hair--off)");
    const fill = page.locator(".fs__hairfill");
    const bar = page.locator(".fs__hair");
    const box = await bar.boundingBox();
    await page.mouse.click(box!.x + box!.width * 0.8, box!.y + box!.height / 2);
    // the fill moves on now-playing events; seek lands near the clicked fraction
    await expect
      .poll(
        async () => {
          const style = (await fill.getAttribute("style")) ?? "";
          const m = style.match(/translateX\((-?\d*\.?\d+)%\)/);
          return m ? (100 + parseFloat(m[1])) / 100 : -1;
        },
        { timeout: 5000 }
      )
      .toBeGreaterThan(0.7);
  });

  test("library/settings routes keep their chrome", async ({ page }) => {
    await page.goto(`${APP}/#/library`);
    await expect(page.locator(".glass")).toBeVisible();
    await page.goto(`${APP}/#/settings`);
    await expect(page.locator(".glass")).toBeVisible();
  });
});

test.describe("Covers carousel", () => {
  test("scrolling moves the highlight without changing the track", async ({ page }) => {
    await page.goto(`${APP}/#/`);
    const covers = page.locator(".fs__covers");
    await expect(covers).toBeVisible();
    const before = await page.locator(".fs__mtitle").textContent();

    const box = await covers.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 500);
    await page.mouse.wheel(0, 500);
    // pointer drag also browses only
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 - 120, box!.y + box!.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(900); // scroll-settle debounce + center snap

    // the song did not change…
    await expect(page.locator(".fs__mtitle")).toHaveText(before ?? "");
    // …but the highlighted card followed the strip's center
    await expect(page.locator(".fs__cover--on:not(.fs__cover--live)")).toBeVisible();
    const scrollLeft = await covers.evaluate((el) => el.scrollLeft);
    expect(scrollLeft).toBeGreaterThan(0);
  });

  test("clicking a side cover changes the track", async ({ page }) => {
    await page.goto(`${APP}/#/`);
    await expect(page.locator(".fs__covers")).toBeVisible();
    const before = await page.locator(".fs__cvtitle").textContent();
    await page.locator(".fs__cover--r").first().click();
    await expect(page.locator(".fs__cvtitle")).not.toHaveText(before ?? "");
  });
});
