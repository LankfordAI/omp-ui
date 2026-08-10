import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(
  new URL("../src/renderer/src/lib/theme-sources.json", import.meta.url),
);
const outputPath = fileURLToPath(
  new URL("../src/renderer/src/theme-default.css", import.meta.url),
);

const TOKEN_KEYS = [
  "--color-void",
  "--color-sunken",
  "--color-surface",
  "--color-raised",
  "--color-overlay",
  "--color-hover",
  "--color-line",
  "--color-line-soft",
  "--color-line-strong",
  "--color-ink",
  "--color-ink-mid",
  "--color-ink-dim",
  "--color-ink-faint",
  "--color-signal",
  "--color-signal-dim",
  "--color-signal-wash",
  "--color-copper",
  "--color-copper-dim",
  "--color-copper-wash",
  "--color-rose",
  "--color-rose-dim",
  "--color-rose-wash",
  "--color-iris",
  "--color-iris-dim",
  "--color-iris-wash",
  "--color-edge-hi",
  "--color-edge-lo",
];

function loadGraphiteTokens() {
  const themes = JSON.parse(readFileSync(sourcePath, "utf8"));
  if (!Array.isArray(themes)) {
    throw new Error("theme-sources.json must contain an array");
  }

  const graphiteThemes = themes.filter((theme) => theme?.id === "graphite");
  if (graphiteThemes.length !== 1) {
    throw new Error(
      `theme-sources.json must contain exactly one graphite theme (found ${graphiteThemes.length})`,
    );
  }

  const tokens = graphiteThemes[0].tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    throw new Error("the graphite theme must define a tokens object");
  }

  const actualKeys = Object.keys(tokens);
  const missingKeys = TOKEN_KEYS.filter((key) => !(key in tokens));
  const unexpectedKeys = actualKeys.filter((key) => !TOKEN_KEYS.includes(key));
  if (missingKeys.length > 0 || unexpectedKeys.length > 0) {
    const details = [
      missingKeys.length > 0 ? `missing ${missingKeys.join(", ")}` : null,
      unexpectedKeys.length > 0 ? `unexpected ${unexpectedKeys.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    throw new Error(`graphite tokens do not match the CSS token contract: ${details}`);
  }

  for (const key of TOKEN_KEYS) {
    if (typeof tokens[key] !== "string" || tokens[key].length === 0) {
      throw new Error(`graphite token ${key} must be a non-empty string`);
    }
  }

  return tokens;
}

function render(tokens) {
  const declarations = TOKEN_KEYS.map((key) => `  ${key}: ${tokens[key]};`).join("\n");
  return `/* Generated from lib/theme-sources.json by scripts/generate-theme-css.mjs. Do not edit. */\n@theme {\n${declarations}\n}\n`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error("usage: node scripts/generate-theme-css.mjs [--check]");
  }

  const generated = render(loadGraphiteTokens());
  if (args[0] === "--check") {
    const current = existsSync(outputPath)
      ? readFileSync(outputPath, "utf8").replaceAll("\r\n", "\n")
      : null;
    if (current !== generated) {
      throw new Error(
        "theme-default.css is stale; run `npm run themes:generate --workspace @omp-ui/desktop`",
      );
    }
    return;
  }

  writeFileSync(outputPath, generated, "utf8");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`generate-theme-css: ${message}`);
  process.exitCode = 1;
}
