import { expect, test } from "@playwright/test";

test.describe("Noctbeat landing", () => {
  test("renders hero, features and buy link", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("floats over everything");
    await expect(page.locator(".card")).toHaveCount(12);
    await expect(page.locator("#extension")).toContainText("extension");
    await expect(page.locator("#buy-link")).toHaveAttribute("href", /lemonsqueezy|noctbeat/);
    await expect(page.locator("nav")).toContainText("Noctbeat");
  });

  test("download buttons link the stable installers with unsigned-app help", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#dl-win")).toHaveAttribute("href", /releases\/latest\/download\/Noctbeat-Windows-Setup\.exe$/);
    await expect(page.locator("#dl-mac")).toHaveAttribute("href", /releases\/latest\/download\/Noctbeat-macOS\.dmg$/);
    await expect(page.locator("#download")).toContainText("Run anyway");
    await page.locator("#lang-toggle").click();
    await expect(page.locator("#dl-mac")).toContainText("Descargar para Mac");
    await expect(page.locator("#download")).toContainText("Abrir");
  });

  test("toggles ES/EN copy", async ({ page }) => {
    await page.goto("/");
    await page.locator("#lang-toggle").click();
    await expect(page.locator("h1")).toContainText("flota sobre todo");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await page.locator("#lang-toggle").click();
    await expect(page.locator("h1")).toContainText("floats over everything");
  });

  test("remembers language across reload", async ({ page }) => {
    await page.goto("/");
    await page.locator("#lang-toggle").click();
    await page.reload();
    await expect(page.locator("h1")).toContainText("flota sobre todo");
  });
});
