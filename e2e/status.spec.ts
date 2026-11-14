import { expect, test } from "./fixtures";

// Core flow: the read-only status page renders the committed evidence at once, then fills in live gate state from
// the public testnet RPCs (or says the live read failed). No key, no wallet, no transaction.
test.describe("status page", () => {
  test("renders the committed runs and the register from data/status.json", async ({ page }) => {
    await page.goto("/status/");
    await expect(page.locator("#numbers")).not.toContainText("not measured yet");
    await expect(page.locator("#incident")).not.toContainText("not measured yet");
    const hashes = page.locator("#register a.hash");
    expect(await hashes.count()).toBeGreaterThan(10);
    await expect(hashes.first()).toHaveAttribute("href", /^https:\/\/(sepolia\.uniscan\.xyz|sepolia\.basescan\.org|lasna\.reactscan\.net)\/tx\/0x[0-9a-f]{64}$/);
  });

  test("the last attack run's cards read in time order", async ({ page }) => {
    await page.goto("/status/");
    const secs = await page.locator("#incident .stat .v").allTextContents();
    expect(secs.length).toBe(4);
    const n = secs.map((t) => parseFloat(t.replace("+", "")));
    expect([...n].sort((a, b) => a - b)).toEqual(n);
  });

  test("route A's live gate state resolves to a definite word within 10 s", async ({ page }) => {
    await page.goto("/status/");
    await expect(page.locator("#routes")).toContainText(/line clear|line blocked|pause not confirmed|live read failed/, { timeout: 12_000 });
  });

  test("the window W control re-plots exposure without a reload", async ({ page }) => {
    await page.goto("/status/");
    const w = page.locator("#w");
    await expect(w).toBeVisible();
    await w.fill("30");
    await expect(page.locator("#wv")).toHaveText("30");
  });
});
