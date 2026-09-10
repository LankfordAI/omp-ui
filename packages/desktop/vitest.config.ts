import { configDefaults, defineConfig } from "vitest/config";

// Component tests need the automatic JSX runtime (tsconfig's `jsx: react-jsx`
// is not read by vitest's esbuild transform). Pure-logic tests are unaffected.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    // Vitest's run-mode default is one worker per available thread — on a
    // 16-thread desktop that keeps ~10 cores busy for over a minute and
    // freezes the machine. Local runs cap at 4 workers; CI (GitHub Actions
    // always sets CI=true) keeps full parallelism for wall-clock speed.
    maxWorkers: process.env.CI ? undefined : 4,
    // Process-backed integration proofs (real `omp --mode=rpc-ui` spawns) live
    // with the host application in packages/host and run via its `test:live`.
    // Renderer `.live.test.tsx` files (real shiki, no subprocess) stay here.
    exclude: [...configDefaults.exclude],
  },
});
