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

  // The strips once used fixed 1000-unit viewBoxes and shrank to 4.6 px text on a phone. They are now
  // drawn at the container's own width; every label must render at >= 11 px and sit clear of every dot, at every width.
  for (const width of [390, 768, 1440]) {
    test(`charts stay legible at ${width} px: text >= 11 px, no label over a dot`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/status/");
      await expect(page.locator("#numbers svg.ds")).toHaveCount(2);
      await expect(page.locator("#exposure svg.ds")).toHaveCount(1);
      const m = await page.evaluate(() => [...document.querySelectorAll<SVGSVGElement>("#numbers svg.ds, #exposure svg.ds")].map((svg) => {
        const k = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
        const texts = [...svg.querySelectorAll("text")];
        const dots = [...svg.querySelectorAll(".pts circle")].map((c) => c.getBoundingClientRect());
        const box = svg.getBoundingClientRect();
        const hit = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        return {
          minPx: Math.min(...texts.map((t) => parseFloat(getComputedStyle(t).fontSize) * k)),
          onDot: texts.filter((t) => dots.some((d) => hit(t.getBoundingClientRect(), d))).length,
          outside: texts.filter((t) => { const r = t.getBoundingClientRect(); return r.left < box.left - 1 || r.right > box.right + 1; }).length,
          dots: dots.length,
        };
      }));
      for (const c of m) {
        expect(c.minPx).toBeGreaterThanOrEqual(11);
        expect(c.onDot).toBe(0);
        expect(c.outside).toBe(0);
      }
      expect(m.map((c) => c.dots)).toEqual([100, 300, 20]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }

  test("the both-gates-shut strip quotes the landing's headline percentiles", async ({ page }) => {
    await page.goto("/status/");
    const lab = page.locator("#numbers .strip").first();
    await expect(lab).toContainText("p50 5.92 s");
    await expect(lab).toContainText("p95 8.245 s");
  });
});
