/**
 * Injected by the esbuild `define` in `scripts/package-host.mjs` when
 * `cli-main.ts` is bundled into the host executable; the version the binary
 * reports as its own.
 */
declare const __HOST_VERSION__: string;
