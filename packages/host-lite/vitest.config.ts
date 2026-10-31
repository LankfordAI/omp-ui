import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // bundle.test.ts builds an esbuild bundle and imports it; give it room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
