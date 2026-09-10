import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules", "**/out", "**/dist", "packages/host/resources"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    files: ["packages/desktop/src/renderer/**", "packages/desktop/src/web/**"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: [
      "packages/core/**/*.ts",
      "packages/host/**/*.ts",
      "packages/host/scripts/**/*.mjs",
      "packages/desktop/src/main/**/*.ts",
      "packages/desktop/src/preload/**/*.ts",
      "packages/server/**/*.ts",
      "packages/desktop/*.ts",
      "packages/desktop/scripts/**/*.mjs",
      "scripts/**/*.mjs",
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The credential worker entry and the libsecret addon shim are CommonJS so
    // a worker_threads Worker can load them without a TS loader.
    files: ["packages/host/src/**/*.cjs"],
    languageOptions: { globals: { ...globals.node }, sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["packages/plan-doc/**/*.ts", "packages/host/verifier/**/*.ts"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // ADR-0002 backstop: core, the transport, the plan toolkit, and the host
    // stay Electron-free; core is also WebSocket-free.
    files: [
      "packages/core/**/*.ts",
      "packages/server/**/*.ts",
      "packages/plan-doc/**/*.ts",
      "packages/host/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["electron", "node:electron"] }],
    },
  },
  {
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["electron", "node:electron", "ws"] },
      ],
    },
  },
  {
    // Issue #442 §10.1: the registry opens under an authority token; the
    // unlocked loader exists for focused tests over a temp file.
    files: ["packages/**/*.ts"],
    ignores: ["**/*.test.ts", "**/test/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='Registry'][property.name='loadUnlocked']",
          message: "Registry.loadUnlocked is for focused tests; production loads with an AuthorityToken.",
        },
      ],
    },
  },
  {
    // The transport never depends on what it carries.
    files: ["packages/server/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["electron", "node:electron", "@omp-ui/host", "@omp-ui/host/*", "@omp-ui/plan-doc", "@omp-ui/plan-doc/*"] },
      ],
    },
  },
  {
    // Issue #442 §2: after the cutover the desktop client is a WebSocket client of the
    // host and links neither the host package nor anything it alone owns.
    files: ["packages/desktop/**/*.ts", "packages/desktop/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["@omp-ui/host", "@omp-ui/host/*", "node-pty", "puppeteer-core"] },
      ],
    },
  },
  {
    // Electron main and preload bundle core and server; their roots re-export
    // node-pty (core/pty.ts), which the client no longer ships. Subpaths only.
    files: ["packages/desktop/src/main/**/*.ts", "packages/desktop/src/preload/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@omp-ui/host", "@omp-ui/host/*", "node-pty", "puppeteer-core"] },
            {
              regex: "^@omp-ui/(core|server)$",
              message: "Import a subpath (e.g. @omp-ui/core/types, @omp-ui/server/client); the package roots load node-pty.",
            },
          ],
        },
      ],
    },
  },
  {
    // ADR-0002 backstop: the renderer takes types only — the core root pulls
    // node-only code (node-pty, fs) into the browser bundle.
    files: ["packages/desktop/src/renderer/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^@omp-ui/core$",
              message: "Import type-only from @omp-ui/core/types.",
            },
          ],
        },
      ],
    },
  },
);
