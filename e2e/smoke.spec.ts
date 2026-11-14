import { expect, test } from "./fixtures";

const PAGES = ["/", "/judge", "/pitch/", "/status/"];

test.describe("smoke: every page loads clean with no keys and no wallet", () => {
  for (const path of PAGES) {
    test(`${path} loads with a title and no console errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        // Network failures of the live status reads (public testnet RPCs) and the stubbed GitHub API are not page errors.
        if (m.type() === "error" && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) errors.push(m.text());
      });
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page).toHaveTitle(/Ledgerlock/);
      await page.waitForLoadState("networkidle").catch(() => {});
      expect(errors).toEqual([]);
    });
  }

  test("landing carries the social card and the headline numbers", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /og-image\.png$/);
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
    await expect(page.locator(".lede")).toContainText("8.245 s");
    await expect(page.locator(".lede")).toContainText("0 of 80");
  });

  test("every same-origin link and asset on every page resolves", async ({ page, request }) => {
    const seen = new Set<string>();
    for (const path of PAGES) {
      await page.goto(path);
      const urls = await page.$$eval("a[href], img[src], link[href], script[src]", (els) =>
        els.map((e) => (e as HTMLAnchorElement).href || (e as HTMLImageElement).src).filter(Boolean),
      );
      for (const u of urls) {
        const url = new URL(u);
        if (url.origin !== new URL(page.url()).origin) continue;
        url.hash = "";
        if (seen.has(url.href)) continue;
        seen.add(url.href);
        const res = await request.get(url.href);
        expect(res.status(), url.href).toBe(200);
      }
    }
    expect(seen.size).toBeGreaterThan(10);
  });

  test("the deck has 10 slides and the arrow key advances it", async ({ page }) => {
    await page.goto("/pitch/");
    await expect(page.locator(".slide")).toHaveCount(10);
    await expect(page.locator("#count")).toHaveText("01 / 10");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#count")).toHaveText("02 / 10");
  });
});
