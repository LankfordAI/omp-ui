import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Builds the self-contained verifier page (issue #442 §8.2) into
 * `packages/host/dist/verifier`. Every asset — fonts included — is inlined so
 * the page makes no request beyond its own module graph; the loopback origin
 * serves it and the browser side aborts everything off-origin.
 */
const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  base: "./",
  build: {
    outDir: fileURLToPath(new URL("../dist/verifier", import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: {
      input: fileURLToPath(new URL("./index.html", import.meta.url)),
    },
  },
});
