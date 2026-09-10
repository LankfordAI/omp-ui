import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      // The workspace packages and ws are bundled; main reaches core only through
      // node-pty-free subpaths (see eslint.config.mjs), so no native module rides along.
      externalizeDeps: { exclude: ["@omp-ui/core", "@omp-ui/server", "ws"] },
      rollupOptions: {
        input: { index: resolve("src/main/index.ts") },
        // ws require()s these optional native accelerators inside try/catch and falls back to JS.
        external: ["bufferutil", "utf-8-validate"],
      },
    },
  },
  preload: { build: { externalizeDeps: { exclude: ["@omp-ui/core"] } } },
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
