import { readFileSync } from "node:fs";
import { CLAIM, expect, test } from "./fixtures";

test.describe("/judge: one page for one reader", () => {
  test("GET /judge with no credentials and no session returns 200 and the claim", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    const res = await anon.get("/judge", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain(CLAIM);
    await anon.dispose();
  });

  test("the claim on /judge is the same sentence as JUDGE.md", async ({ page }) => {
    await page.goto("/judge");
    await expect(page.locator("[data-claim]")).toHaveText(CLAIM);
    expect(readFileSync("JUDGE.md", "utf8")).toContain(`**${CLAIM}**`);
  });

  test("the 30-second path is five steps of read-only explorer links", async ({ page }) => {
    await page.goto("/judge");
    await expect(page.locator("ol.path > li")).toHaveCount(5);
    const hrefs = await page.locator("ol.path a.tx").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
    const explorer = hrefs.filter((h) => /^https:\/\/(sepolia\.uniscan\.xyz|sepolia\.basescan\.org|lasna\.reactscan\.net)\/tx\/0x[0-9a-f]{64}$/.test(h));
    expect(explorer).toHaveLength(6);
    expect(hrefs.some((h) => h.endsWith("/status/"))).toBe(true);
  });

  test("receipt, reproduce, limits and links are all present", async ({ page }) => {
    await page.goto("/judge");
    await expect(page.locator("#receipt")).toContainText("8.245 s");
    await expect(page.locator("#receipt")).toContainText("0 of 80");
    await expect(page.locator("#reproduce")).toContainText("pnpm burst:verify");
    await expect(page.locator("#limits li")).toHaveCount(3);
    await expect(page.locator("[data-tests]")).not.toContainText("__TESTS__");
  });

  test("the landing page and the deck both link to /judge", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('main a[href="judge"]').first()).toBeVisible();
    await page.goto("/pitch/#10");
    await expect(page.locator('.slide.on a[href="../judge"]')).toBeVisible();
  });
});
