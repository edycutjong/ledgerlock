import { expect, test } from "./fixtures";

const WIDTHS = [375, 768, 1440];
const PAGES = ["/", "/judge", "/status/"];

test.describe("responsive: no sideways scroll", () => {
  // Viewport sizes are set explicitly, so one project is enough.
  test.beforeEach(({}, info) => test.skip(info.project.name !== "chromium", "viewports are explicit; run once"));
  for (const width of WIDTHS) {
    for (const path of PAGES) {
      test(`${path} at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        await expect(page.locator("header").first()).toBeInViewport();
      });
    }
  }

  test("the deck scales to a phone screen in both orientations", async ({ page }) => {
    for (const [width, height] of [[390, 844], [844, 390]]) {
      await page.setViewportSize({ width, height });
      await page.goto("/pitch/");
      const box = await page.locator(".slide.on").boundingBox();
      expect(box && box.width <= width + 1 && box.height <= height + 1).toBe(true);
    }
  });
});
