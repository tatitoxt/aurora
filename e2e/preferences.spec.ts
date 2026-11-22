import { expect, test } from "@playwright/test";

const APP = "http://localhost:4812";

for (const viewport of [{ width: 960, height: 720 }, { width: 300, height: 480 }]) {
  test.describe(`Desktop pages at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test("settings navigate one category at a time and retain changes", async ({ page }) => {
      await page.goto(`${APP}/#/settings`);
      const nav = page.getByRole("navigation", { name: "Settings" });
      await expect(page.locator('[data-setgrp="look"]')).toBeVisible();
      await expect(page.locator(".setblock:visible")).toHaveCount(1);
      const opacity = page.getByRole("slider", { name: "Glass opacity" });
      await opacity.fill("35");
      await nav.getByRole("button", { name: "Lyrics & visuals" }).click();
      await expect(page.locator('[data-setgrp="look"]')).toBeHidden();
      await expect(page.locator(".setblock:visible")).toHaveCount(1);
      const video = page.getByRole("switch", { name: "Music video backdrop" });
      const checked = await video.getAttribute("aria-checked");
      await video.click();
      await expect(video).toHaveAttribute("aria-checked", checked === "true" ? "false" : "true");
      await nav.getByRole("button", { name: "Look", exact: true }).click();
      await expect(opacity).toHaveValue("35");
      for (const name of ["Sound", "Playback", "Sources", "Windows", "License"]) {
        await nav.getByRole("button", { name, exact: true }).click();
        await expect(page.locator(".setblock:visible")).toHaveCount(1);
        await expect(nav.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });

    test("library separates queue, services, likes and playlists", async ({ page }) => {
      await page.goto(`${APP}/#/library`);
      const nav = page.getByRole("navigation", { name: "Library" });
      await expect(page.locator("#library-queue")).toBeVisible();
      await expect(page.locator("#library-stream")).toBeHidden();
      for (const name of ["Music services", "Liked", "Playlists", "Queue"]) {
        await nav.getByRole("button", { name, exact: true }).click();
        await expect(page.locator(".collection__section:visible")).toHaveCount(1);
      }
      await nav.getByRole("button", { name: "Music services" }).click();
      await expect(page.getByRole("button", { name: "Spotify", exact: true })).toBeEnabled();
      await expect(page.getByRole("status")).toHaveText("Browser preview");
      await expect(page.getByRole("button", { name: "Spotify", exact: true })).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });

    test("player separates track, timeline and controls with provider at left", async ({ page }) => {
      await page.goto(`${APP}/#/`);
      const track = page.locator(".fs__trackline");
      const timeline = page.locator(".fs__timeline");
      const deck = page.locator(".fs__deck");
      await expect(track).toBeVisible();
      const trackBox = await track.boundingBox();
      const timelineBox = await timeline.boundingBox();
      const deckBox = await deck.boundingBox();
      expect(trackBox!.y + trackBox!.height).toBeLessThanOrEqual(timelineBox!.y);
      expect(timelineBox!.y + timelineBox!.height).toBeLessThanOrEqual(deckBox!.y);
      const providerBox = await page.getByRole("button", { name: "Music provider" }).boundingBox();
      expect(providerBox!.x).toBeLessThan(deckBox!.x + 70);
      await expect(deck.getByRole("button", { name: "Previous", exact: true })).toBeVisible();
      await expect(deck.getByRole("button", { name: "Next", exact: true })).toBeVisible();
      await expect(deck.getByRole("button", { name: "Volume", exact: true })).toBeVisible();
    });
  });
}

test("desktop lyrics have a transparent surface", async ({ page }) => {
  await page.goto(`${APP}/#/desklyrics`);
  await expect(page.locator(".dlyrics")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.locator(".dlyrics")).toHaveCSS("backdrop-filter", "none");
});
