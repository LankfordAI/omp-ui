import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: { build: { externalizeDeps: { exclude: ["@omp-ui/core"] } } },
  preload: { build: { externalizeDeps: { exclude: ["@omp-ui/core"] } } },
  renderer: { plugins: [react(), tailwindcss()] },
});
