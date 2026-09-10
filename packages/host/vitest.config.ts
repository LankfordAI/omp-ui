import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: process.env.CI ? undefined : 4,
    exclude: [...configDefaults.exclude, "src/**/*.live.test.ts"],
  },
});
