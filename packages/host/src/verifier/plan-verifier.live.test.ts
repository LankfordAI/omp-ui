import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comparePlanDiagnostics, type PlanRenderResult } from "@omp-ui/core";
import { ChromeVerifierPage } from "./chrome-verifier-page";
import { PLAN_PREPARED_BYTE_LIMIT } from "./limits";
import { resolveVerifierPayload } from "./payload";
import { PlanVerifier, type VerifyArgs } from "./plan-verifier";
import { startVerifierOrigin, type VerifierOrigin } from "./static-origin";

/**
 * Process-backed proof for the headless verifier (issue #442 §8.2): the real
 * pinned Chrome for Testing, the real built page, the corpus. Skips by name
 * when no payload is fetched (`npm run fetch:verifier-browser`) or the page is
 * not built (`npm run build`).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(here, "../..");
const pageDir = path.join(hostRoot, "dist", "verifier");
const corpusDir = path.join(here, "corpus");
const verdictsFile = path.join(corpusDir, "verdicts.json");

const payload = resolveVerifierPayload({
  resourcesDir: path.join(hostRoot, "resources"),
  env: {
    ...process.env,
    OMP_UI_VERIFIER_BROWSER:
      process.env.OMP_UI_VERIFIER_BROWSER ??
      path.join(hostRoot, "resources", "plan-verifier", `${cftOs()}-${process.arch}`),
  },
  packaged: false,
});
const pageBuilt = fs.existsSync(path.join(pageDir, "index.html"));
const skipReason =
  "available" in payload && payload.available === false
    ? `no verifier browser: ${payload.reason}`
    : !pageBuilt
      ? `verifier page not built at ${pageDir}`
      : null;

function cftOs(): string {
  return process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux";
}

interface Verdict {
  file: string;
  result: PlanRenderResult;
}

function normalize(result: PlanRenderResult): PlanRenderResult {
  return { status: result.status, diagnostics: [...result.diagnostics].sort(comparePlanDiagnostics) };
}

describe.skipIf(skipReason !== null)(`ChromeVerifierPage live${skipReason === null ? "" : ` (skipped: ${skipReason})`}`, () => {
  let origin: VerifierOrigin;
  let profileRoot: string;
  const pages: ChromeVerifierPage[] = [];

  /** One page per case: the verifier disposes a page it stops trusting, so cases never share. */
  function makePage(): ChromeVerifierPage {
    if (!("executablePath" in payload)) throw new Error("unreachable: skip gate");
    const page = new ChromeVerifierPage({
      executablePath: payload.executablePath,
      userDataDir: path.join(profileRoot, `profile-${pages.length}`),
      origin: origin.origin,
      prefix: origin.prefix,
    });
    pages.push(page);
    return page;
  }

  beforeAll(async () => {
    origin = await startVerifierOrigin(pageDir);
    profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-verifier-live-"));
  });

  afterAll(async () => {
    for (const page of pages) page.dispose();
    await origin.close();
    fs.rmSync(profileRoot, { recursive: true, force: true });
  });

  it("answers the corpus at 800/360 with the recorded verdicts", async () => {
    const verifier = new PlanVerifier({ page: () => makePage() });
    const files = fs
      .readdirSync(corpusDir)
      .filter((f) => f.endsWith(".html"))
      .sort();
    const verdicts: Verdict[] = [];
    for (const file of files) {
      const html = fs.readFileSync(path.join(corpusDir, file), "utf8");
      const result = await verifier.verify(html, "dark", new AbortController().signal);
      verdicts.push({ file, result: normalize(result) });
    }
    // The real page is a layout environment: nothing may come back unavailable.
    for (const v of verdicts) expect(v.result.status, v.file).not.toBe("unavailable");
    expect(verdicts.find((v) => v.file === "normal-plan.html")?.result.status).toBe("passed");
    expect(
      verdicts
        .find((v) => v.file === "external-script.html")
        ?.result.diagnostics.map((d) => d.code),
    ).toContain("EXTERNAL_RESOURCE");
    if (!fs.existsSync(verdictsFile)) {
      console.warn(`corpus/verdicts.json absent: equality with the BrowserWindow verifier not asserted`);
      return;
    }
    const recorded = JSON.parse(fs.readFileSync(verdictsFile, "utf8")) as Verdict[];
    expect(verdicts).toEqual(recorded.map((v) => ({ file: v.file, result: normalize(v.result) })));
  });

  const NORMAL: VerifyArgs = {
    html: "<html><head><title>Plan</title></head><body><h1>Plan</h1></body></html>",
    themeId: "dark",
    preparedByteLimit: PLAN_PREPARED_BYTE_LIMIT,
  };

  const statusOf = (value: unknown): string =>
    value !== null && typeof value === "object" && "status" in value ? String(value.status) : "";

  it("gives the next invoke a fresh page after a target crash", async () => {
    const page = makePage();
    expect(statusOf(await page.invoke(NORMAL))).toBe("passed");
    // Reach the warm browser through a second tab and crash its renderer.
    const browser = page.browser();
    expect(browser).not.toBeNull();
    const crasher = await browser!.newPage();
    await crasher.goto("chrome://crash").catch(() => undefined);
    await crasher.close().catch(() => undefined);
    expect(statusOf(await page.invoke(NORMAL))).toBe("passed");
  });

  it("relaunches after the browser process is killed", async () => {
    const page = makePage();
    await page.invoke(NORMAL);
    const browser = page.browser();
    expect(browser).not.toBeNull();
    const proc = browser!.process();
    expect(proc).not.toBeNull();
    const gone = new Promise<void>((resolve) => browser!.once("disconnected", () => resolve()));
    proc!.kill("SIGKILL");
    await gone;
    expect(statusOf(await page.invoke(NORMAL))).toBe("passed");
    expect(page.browser()).not.toBe(browser);
  });
});
