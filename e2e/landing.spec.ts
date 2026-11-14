import { expect, test } from "./fixtures";

// The hero panel replays three committed runs from evidence/frozen3-bench-runs.csv. Reduced motion makes each replay jump
// straight to its final state, so these checks do not wait on the 1x clock.
test.use({ reducedMotion: "reduce" });

test.describe("landing: the track-lamp panel and its three committed runs", () => {
  test("the markup holds the finished attack run (bu-015) before any script runs", async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.locator("#panel")).toHaveAttribute("data-gu", "shut");
    await expect(page.locator("#panel")).toHaveAttribute("data-gb", "shut");
    await expect(page.locator(".nb-t")).toHaveText("Line blocked");
    await expect(page.locator(".ll-reg li")).toHaveCount(6);
    await ctx.close();
  });

  const runs = [
    { tab: "#tab-lf", id: "lf-009", board: "Line clear", clock: "+16.479 s", gates: "open", rows: 8, text: "reopened +16.479 s" },
    { tab: "#tab-ls", id: "ls-015", board: "Line clear", clock: "+6.678 s", gates: "open", rows: 4, text: "0 callbacks" },
    { tab: "#tab-bu", id: "bu-015", board: "Line blocked", clock: "+5.341 s", gates: "shut", rows: 6, text: "paused +5.341 s" },
  ];
  for (const r of runs) {
    test(`${r.id}: its tab ends in ${r.board.toLowerCase()} at ${r.clock}`, async ({ page }) => {
      await page.goto("/");
      await page.click(r.tab);
      await expect(page.locator(r.tab)).toHaveAttribute("aria-selected", "true");
      await expect(page.locator(".nb-t")).toHaveText(r.board);
      await expect(page.locator(".ll-clock")).toHaveText(r.clock);
      await expect(page.locator("#panel")).toHaveAttribute("data-gu", r.gates);
      await expect(page.locator(".ll-reg li")).toHaveCount(r.rows);
      await expect(page.locator(".ll-wide")).toContainText(r.text);
    });
  }

  test("every register row links a testnet explorer", async ({ page }) => {
    await page.goto("/");
    for (const tab of ["#tab-bu", "#tab-lf", "#tab-ls"]) {
      await page.click(tab);
      for (const href of await page.locator(".ll-reg a.tx").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href)))
        expect(href).toMatch(/^https:\/\/(sepolia\.basescan\.org|sepolia\.uniscan\.xyz|lasna\.reactscan\.net)\/tx\/0x[0-9a-f]{64}$/);
    }
  });

  // One panel geometry per width, each drawn for that width (wide > 960 px, tablet 701-960, phone <= 700), and the bench
  // plot redrawn for a phone so its p50 / p95 markers are on screen without sideways scrolling.
  for (const [width, geo, plot] of [[1440, "ll-wide", "dots-d"], [768, "ll-tab", "dots-d"], [390, "ll-phone", "dots-m"]] as const) {
    test(`at ${width}px the panel shows ${geo} and the bench shows ${plot}, markers on screen`, async ({ page }) => {
      test.skip(test.info().project.name !== "chromium", "viewports are explicit; run once");
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator(`.ll-svg.${geo}`)).toBeVisible();
      expect(await page.locator(".ll-svg:visible").count()).toBe(1);
      await expect(page.locator(`.dots.${plot}`)).toBeVisible();
      expect(await page.locator(".dots:visible").count()).toBe(1);
      const off = await page.locator(`.dots.${plot} .pct text, .dots.${plot} .hero-mark text`).evaluateAll((ts) =>
        ts.filter((t) => { const r = t.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth; }).map((t) => t.textContent));
      expect(off).toEqual([]);
      await expect(page.locator(`.dots.${plot} .pct`)).toContainText("p95 8.245 s");
      await expect(page.locator(`.dots.${plot} circle.hero`)).toHaveCount(1);
    });
  }

  test("the page says testnet, never mainnet deployment", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".live")).toHaveText(/testnets/i);
    await expect(page.locator("footer")).toContainText("no mainnet deployment");
  });
});
