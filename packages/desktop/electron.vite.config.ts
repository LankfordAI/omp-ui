import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ["@omp-ui/core", "@omp-ui/server", "ws"] },
      // ws require()s these optional native accelerators inside try/catch and falls back to JS.
      rollupOptions: {
        // browser-pane-smoke is the Electron-runtime smoke of the pane host
        // (spec 5.7); electron-builder.yml excludes it from the package.
        input: {
          index: resolve("src/main/index.ts"),
          "browser-pane-smoke": resolve("src/main/browser-pane-smoke.ts"),
        },
        external: ["bufferutil", "utf-8-validate"],
        // Shared chunks sit beside index.js, not in chunks/: modules resolving
        // bundled assets through __dirname (plan-verifier, clock-stamper,
        // backend) assume __dirname is out/main.
        output: { chunkFileNames: "[name]-[hash].js" },
      },
    },
  },
  preload: { build: { externalizeDeps: { exclude: ["@omp-ui/core"] } } },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: {
      // Three pages ship: the app (index.html — unchanged default entry), the
      // private main-owned plan verifier surface (issue #312 follow-up), and
      // the private main-owned browser-clock stamper. electron-builder ships
      // them via `out/**`; the WEB build config (vite.web.config.ts)
      // deliberately never lists the private pages, so the remote client
      // cannot load them.
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          planVerifier: resolve("src/renderer/plan-verifier.html"),
          clockStamper: resolve("src/renderer/clock-stamper.html"),
        },
      },
    },
  },
});
