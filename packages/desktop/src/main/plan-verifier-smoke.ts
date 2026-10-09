import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { app } from "electron";
import { DEFAULT_THEME_ID } from "../renderer/src/lib/themes";
import { PlanVerifier } from "./plan-verifier";

/**
 * Electron-runtime smoke of the shipped plan verifier window (issue #820).
 * Second main entry; never packaged. CI runs `--once` under real Electron,
 * headless Ozone first: the verifier window once SIGSEGV'd main on that
 * platform because it was the only hidden-forever, non-offscreen window in
 * the app (the pane and the stamper are offscreen; the main window is shown
 * at ready-to-show). The unit suite drives PlanVerifier through the
 * `createPage` seam with fake pages, so nothing short of this entry can ever
 * reach the real BrowserWindow construction.
 *
 *   npm run smoke:plan-verifier -w @omp-ui/desktop -- [flags]
 *
 * Flags: --out=DIR (out/plan-verifier-smoke) --once. Chromium switches pass
 * through (`--ozone-platform=headless`, `--no-sandbox`).
 *
 * One real verify against the shipped BrowserVerifierPage: the verify call is
 * what constructs the window, so on a regressed tree the PROCESS dies here
 * under headless Ozone — no detection code needed; a SIGSEGV leaves no
 * summary.json and the shell sees the signal.
 *
 * `--once` writes the summary and exits: 0 passed, 1 failed (the fixture
 * document does not validate — a fixture bug, never shippable red),
 * 3 unavailable (the page lived but the environment did no layout / timed
 * out — the Xvfb-fallback signal, same convention as the pane smoke),
 * 5 watchdog.
 */

const ONCE_WATCHDOG_MS = 60_000;

// ---------------------------------------------------------------- flags

function flagValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit === null || hit === undefined ? null : hit.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const flags = {
  out: resolve(flagValue("out") ?? join(__dirname, "..", "plan-verifier-smoke")),
  once: hasFlag("once"),
};

// ---------------------------------------------------------------- fixture

// A minimal authored plan document in the shape the pipeline expects: plain
// body text, one h1, one paragraph, one code block with inline HTML escaped
// as entities. The pipeline injects the CSP and the readability guardrail
// itself (structureReplacements), so the fixture authors neither; every line
// is short so the 360px probe width wraps inside the guardrail's pre-wrap
// rules instead of overflowing.
const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Plan verifier smoke</title></head>
<body>
<h1>Plan verifier smoke</h1>
<p>This document exists only to prove the verifier window constructs,
lays out, and answers under real Electron.</p>
<pre><code>&lt;section id="gate"&gt;
  &lt;p&gt;escaped inline HTML&lt;/p&gt;
&lt;/section&gt;</code></pre>
</body>
</html>
`;

// ---------------------------------------------------------------- run

const warnings: string[] = [];
let finished = false;
let watchdog: NodeJS.Timeout | undefined;

function writeSummary(summary: { status: string; codes: string[]; crashed: boolean }): string {
  mkdirSync(flags.out, { recursive: true });
  const file = join(flags.out, "summary.json");
  writeFileSync(file, `${JSON.stringify({ ...summary, warnings }, null, 2)}\n`);
  return file;
}

function finish(summary: { status: string; codes: string[]; crashed: boolean }, exitCode: number): void {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  verifier?.dispose();
  const file = writeSummary(summary);
  console.log(`FINISH status=${summary.status} codes=[${summary.codes.join(",")}] summary=${file}`);
  app.exit(exitCode);
}

// A listener disables Electron's default quit-on-last-window so a renderer
// crash (window closed, process alive) still answers through verify()'s
// catch and exits 3 with a summary, instead of quitting silently with no
// summary at exit code 0. finish() sets `finished` before it disposes the
// window, so the expected close at teardown is not misread as an early one.
app.on("window-all-closed", () => {
  if (!finished) warnings.push("window-all-closed fired before finish");
});

let verifier: PlanVerifier | null = null;

async function main(): Promise<void> {
  // The watchdog resolves the race: finish() has already written the summary
  // and exited the process by the time the race settles, so nothing else can
  // answer after a watchdog exit.
  const watchdogDone = new Promise<null>((resolve) => {
    watchdog = setTimeout(() => {
      finish({ status: "watchdog", codes: ["WATCHDOG"], crashed: false }, 5);
      resolve(null);
    }, ONCE_WATCHDOG_MS);
  });
  verifier = new PlanVerifier();
  console.log(`READY out=${flags.out} once=${flags.once}`);
  const result = await Promise.race([
    verifier.verify(FIXTURE_HTML, DEFAULT_THEME_ID, AbortSignal.timeout(25_000)),
    watchdogDone,
  ]);
  if (result === null) return;
  const codes = result.diagnostics.map((d) => d.code);
  const exitCode = result.status === "passed" ? 0 : result.status === "failed" ? 1 : 3;
  finish({ status: result.status, codes, crashed: false }, exitCode);
}

void app.whenReady().then(main);
