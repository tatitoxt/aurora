import { expect, test } from "@playwright/test";

test.describe("Noctbeat landing", () => {
  test("renders hero, features and buy link", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("screen breathes");
    await expect(page.locator(".card")).toHaveCount(8);
    await expect(page.locator("#buy-link")).toHaveAttribute("href", /lemonsqueezy|noctbeat/);
    await expect(page.locator("nav")).toContainText("Noctbeat");
  });

  test("toggles ES/EN copy", async ({ page }) => {
    await page.goto("/");
    await page.locator("#lang-toggle").click();
    await expect(page.locator("h1")).toContainText("pantalla respira");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await page.locator("#lang-toggle").click();
    await expect(page.locator("h1")).toContainText("screen breathes");
  });

  test("remembers language across reload", async ({ page }) => {
    await page.goto("/");
    await page.locator("#lang-toggle").click();
    await page.reload();
    await expect(page.locator("h1")).toContainText("pantalla respira");
  });
});
