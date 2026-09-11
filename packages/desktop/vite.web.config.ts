import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The same renderer, served over HTTP instead of file:// (ADR-0002). `base: "./"` keeps assets
// path-independent; publicDir carries build/icon.png through as the manifest icon.
//
// Tailwind v4's automatic content detection starts from the cwd, and the npm script runs with
// cwd = packages/desktop, which holds both src/renderer and src/web — so the web entry's own JSX
// classes are scanned with no @source directive needed.
export default defineConfig({
  root: resolve(__dirname, "src/web"),
  base: "./",
  publicDir: resolve(__dirname, "build"),
  plugins: [react(), tailwindcss()],
  build: { outDir: resolve(__dirname, "out/web"), emptyOutDir: true },
});
