import { test as base, expect } from "@playwright/test";

// The pages refresh the release tag from api.github.com. Stub it by default so tests are deterministic and never
// rate-limited; release.spec.ts overrides the stub to test both the update and the silent-failure paths.
export const test = base.extend<{ releaseTag: string | null }>({
  releaseTag: [null, { option: true }],
  page: async ({ page, releaseTag }, use) => {
    await page.route("https://api.github.com/**", (route) =>
      releaseTag ? route.fulfill({ json: { tag_name: releaseTag } }) : route.abort(),
    );
    await use(page);
  },
});
export { expect };

export const CLAIM =
  "One Reactive contract reads Base locks and Unichain mints together and pauses a bridge seconds after a mint appears with no lock.";
