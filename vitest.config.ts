// Unit tests for the reactive-kit TypeScript helpers (packages/reactive-kit/ts).
// Out of scope here: Solidity tests (forge), Playwright specs (e2e/*.spec.ts), and scripts/*.ts — the scripts are
// operational CLIs that run against live testnets, so they are type-checked (`pnpm typecheck`) but not unit-tested.
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/reactive-kit/ts/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "lib/**",
      "e2e/**",
      "test/**",
      "packages/reactive-kit/test/**",
      "out/**",
      "out-kit/**",
      "cache/**",
      "coverage/**",
    ],
    environment: "node",
    // Each test file runs in its own child process: trigger.test.ts uses process.chdir to exercise the default
    // relative output path, which worker threads do not support.
    pool: "forks",
    unstubEnvs: true,
    coverage: {
      provider: "v8",
      include: ["packages/reactive-kit/ts/**/*.ts"],
      exclude: ["packages/reactive-kit/ts/**/*.test.ts"],
      reporter: ["text", "text-summary", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
