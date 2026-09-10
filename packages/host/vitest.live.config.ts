import { defineConfig } from "vitest/config";

// Process-backed proofs (a real headless Chrome, a fake omp binary, a temp
// data root). Serial on purpose, mirroring packages/desktop/vitest.live.config.ts:
// parallel boots starve one another. Run via `npm run test:live`.
export default defineConfig({
  test: {
    include: ["src/**/*.live.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
