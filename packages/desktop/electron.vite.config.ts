import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ["@omp-ui/core", "@omp-ui/host", "@omp-ui/server", "ws"] },
      // ws require()s these optional native accelerators inside try/catch and falls back to JS.
      // puppeteer-core stays a runtime require: it is a plain dependency in node_modules and
      // its own optional requires do not survive bundling.
      rollupOptions: {
        input: { index: resolve("src/main/index.ts") },
        external: ["bufferutil", "utf-8-validate", "puppeteer-core"],
      },
    },
  },
  preload: { build: { externalizeDeps: { exclude: ["@omp-ui/core"] } } },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: {
      // Two pages ship: the app (index.html — unchanged default entry) and
      // the private main-owned plan verifier surface (issue #312 follow-up).
      // electron-builder ships both via `out/**`; the WEB build config
      // (vite.web.config.ts) deliberately never lists the verifier page, so
      // the remote client cannot load it.
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          planVerifier: resolve("src/renderer/plan-verifier.html"),
        },
      },
    },
  },
});
