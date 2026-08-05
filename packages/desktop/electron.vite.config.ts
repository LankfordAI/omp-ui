import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ["@omp-ui/core", "@omp-ui/server", "ws"] },
      // ws require()s these optional native accelerators inside try/catch and falls back to JS.
      rollupOptions: { external: ["bufferutil", "utf-8-validate"] },
    },
  },
  preload: { build: { externalizeDeps: { exclude: ["@omp-ui/core"] } } },
  renderer: { plugins: [react(), tailwindcss()] },
});
