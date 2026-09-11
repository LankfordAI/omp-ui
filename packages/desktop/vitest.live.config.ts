import { defineConfig } from "vitest/config";

// Process-backed integration proofs against the real `omp --mode=rpc-ui`
// binary (issues #86, #379). Serial on purpose: every test boots a real omp
// process and parallel boots starve one another. Run via `npm run test:live`.
export default defineConfig({
  test: {
    include: ["src/main/**/*-live.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    // Backstop for future live files; per-test `timeout` options override it
    // (advisor-stats-live's 180s/420s values are unaffected).
    testTimeout: 120_000,
    // killScope's afterEach waits up to 8s for SIGTERM before escalating to
    // SIGKILL, then removes the temp scope — 10s default is too tight.
    hookTimeout: 30_000,
  },
});
