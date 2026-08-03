import { defineConfig } from "vitest/config";

// Component tests need the automatic JSX runtime (tsconfig's `jsx: react-jsx`
// is not read by vitest's esbuild transform). Pure-logic tests are unaffected.
export default defineConfig({
  esbuild: { jsx: "automatic" },
});
