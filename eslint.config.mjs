import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules", "**/out", "**/dist"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/desktop/src/renderer/**"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: [
      "packages/core/**/*.ts",
      "packages/desktop/src/main/**/*.ts",
      "packages/desktop/src/preload/**/*.ts",
      "packages/desktop/*.ts",
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // ADR-0002 backstop: core stays transport-agnostic, zero Electron imports.
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["electron", "node:electron"] }],
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
