import { expect, test } from "./fixtures";

const PAGES = ["/", "/judge", "/pitch/"];

test.describe("release tag on the landing page, /judge and the deck", () => {
  test.describe("GitHub API unreachable", () => {
    test.use({ releaseTag: null });
    for (const path of PAGES) {
      test(`${path} keeps the stamped tag and links it to releases/latest`, async ({ page }) => {
        await page.goto(path);
        const tags = page.locator("[data-release]");
        expect(await tags.count()).toBeGreaterThan(0);
        for (const t of await tags.allTextContents()) expect(t).toMatch(/^v\d+\.\d+\.\d+$/);
        await expect(page.locator('a[href="https://github.com/edycutjong/ledgerlock/releases/latest"]').first()).toBeAttached();
      });
    }
  });

  test.describe("a newer release exists", () => {
    test.use({ releaseTag: "v9.9.9" });
    for (const path of PAGES) {
      test(`${path} refreshes every tag at runtime`, async ({ page }) => {
        await page.goto(path);
        await expect(page.locator("[data-release]").first()).toHaveText("v9.9.9");
        for (const t of await page.locator("[data-release]").allTextContents()) expect(t).toBe("v9.9.9");
      });
    }
  });
});
