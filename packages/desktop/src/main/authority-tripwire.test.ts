import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { AUTHORITY_CLAIM_MARKERS, type BreadcrumbSink } from "@omp-ui/core";
import { app, dialog } from "electron";
import {
  buildFlavor,
  legacyAuthorityRefusal,
  refuseLegacyAuthorityIfClaimed,
} from "./authority-tripwire";

vi.mock("electron", () => ({
  app: { isPackaged: false, exit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));

const tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-tripwire-"));
  tmpDirs.push(dir);
  return dir;
}

function fakeSink(): BreadcrumbSink & { record: Mock } {
  return { record: vi.fn(), entries: () => [] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("refuseLegacyAuthorityIfClaimed", () => {
  for (const marker of AUTHORITY_CLAIM_MARKERS) {
    it(`refuses a root claimed by ${marker}`, () => {
      const root = mkTmp();
      const logDir = path.join(mkTmp(), "logs");
      const target = path.join(root, marker);
      if (marker === "worktrees") fs.mkdirSync(target);
      else fs.writeFileSync(target, "");
      const breadcrumbs = fakeSink();

      expect(() => refuseLegacyAuthorityIfClaimed({ logDir, breadcrumbs, root })).toThrow(
        /^A persistent omp-ui host has claimed /,
      );

      expect(app.exit).toHaveBeenCalledWith(5);
      expect(dialog.showErrorBox).toHaveBeenCalledTimes(1);
      const [title, message] = vi.mocked(dialog.showErrorBox).mock.calls[0];
      expect(title).toBe("omp-ui cannot start");
      expect(message).toContain(root);
      expect(message).toContain(`(found: ${marker})`);
      expect(message).toContain("`omp-ui rollback`");
      expect(breadcrumbs.record).toHaveBeenCalledWith("authority", { detail: message });
      expect(fs.readFileSync(path.join(logDir, "main.log"), "utf8")).toContain(
        `[authority] ${message}`,
      );
    });
  }

  it("returns the root untouched when it carries no claim evidence", () => {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, "unrelated.json"), "{}");
    const breadcrumbs = fakeSink();

    expect(
      refuseLegacyAuthorityIfClaimed({ logDir: path.join(root, "logs"), breadcrumbs, root }),
    ).toBe(root);

    expect(app.exit).not.toHaveBeenCalled();
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
    expect(breadcrumbs.record).not.toHaveBeenCalled();
  });
});

describe("legacyAuthorityRefusal", () => {
  it("is null without evidence and names every marker found", () => {
    expect(legacyAuthorityRefusal("/data/omp-ui", [])).toBeNull();
    expect(legacyAuthorityRefusal("/data/omp-ui", ["host.lock", "registry.json"])).toBe(
      "A persistent omp-ui host has claimed /data/omp-ui (found: host.lock, registry.json). " +
        "This desktop build cannot open that data. Run `omp-ui status` to see the host, " +
        "`omp-ui stop` to stop it, or `omp-ui rollback` to return to the previous host version.",
    );
  });
});

describe("buildFlavor", () => {
  it("is dev without ELECTRON_RENDERER_URL and dev-server with it", () => {
    vi.stubEnv("ELECTRON_RENDERER_URL", undefined);
    expect(buildFlavor()).toBe("dev");
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173");
    expect(buildFlavor()).toBe("dev-server");
  });

  it("is installed when packaged, whatever the dev-server env says", () => {
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173");
    const mutableApp = app as { isPackaged: boolean };
    mutableApp.isPackaged = true;
    try {
      expect(buildFlavor()).toBe("installed");
    } finally {
      mutableApp.isPackaged = false;
    }
  });
});
