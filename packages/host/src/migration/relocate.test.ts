import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NO_BREADCRUMBS, type BreadcrumbEntry, type BreadcrumbSink } from "@omp-ui/core";
import { MigrationConflict, MigrationJournal, type ItemEvidence } from "./journal";
import { legacyUserDataDir, legacyUserDataFromRelocation, relocateAuthorityStores, RELOCATED_ITEMS, type GitResult } from "./relocate";

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-ui-${prefix}-`));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function recordingBreadcrumbs(): BreadcrumbSink & { details: string[] } {
  const entries: BreadcrumbEntry[] = [];
  return {
    details: [],
    record(kind, fields) {
      entries.push({ at: "", seq: entries.length, kind, ...fields });
      this.details.push(`${kind}: ${fields?.detail ?? ""}`);
    },
    entries: () => entries,
  };
}

const gitOk = async (): Promise<GitResult> => ({ code: 0, stdout: "", stderr: "" });

interface Legacy {
  legacy: string;
  dataRoot: string;
  journal: MigrationJournal;
}

/** A populated Electron userData dir: three stores, a worktree tree with a symlink, logs, oauth. */
function legacyFixture(registry: unknown = { schemaVersion: 1, sessions: [] }): Legacy {
  const legacy = tmp("legacy");
  const dataRoot = path.join(tmp("root"), "omp-ui");
  fs.writeFileSync(path.join(legacy, "registry.json"), JSON.stringify(registry));
  fs.writeFileSync(path.join(legacy, "provider-keys.json"), '{"schemaVersion":1,"keys":{}}', { mode: 0o600 });
  fs.writeFileSync(path.join(legacy, "remote-instances.json"), '{"schemaVersion":1,"instances":[]}', { mode: 0o600 });
  fs.mkdirSync(path.join(legacy, "worktrees", "proj", "wt-1", "sub"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "worktrees", "proj", "wt-1", ".git"), "gitdir: /repo/.git/worktrees/wt-1\n");
  fs.writeFileSync(path.join(legacy, "worktrees", "proj", "wt-1", "sub", "big.bin"), Buffer.alloc(3 * 1024 * 1024, 7));
  fs.symlinkSync("sub/big.bin", path.join(legacy, "worktrees", "proj", "wt-1", "link"));
  fs.mkdirSync(path.join(legacy, "logs"));
  fs.writeFileSync(path.join(legacy, "logs", "main.log"), "hello\n");
  fs.mkdirSync(path.join(legacy, "oauth-login"));
  fs.writeFileSync(path.join(legacy, "oauth-login", "state.json"), "{}");
  return { legacy, dataRoot, journal: MigrationJournal.open(dataRoot, { now: () => 1 }) };
}

function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const st = fs.lstatSync(abs);
      const r = rel ? `${rel}/${name}` : name;
      if (st.isSymbolicLink()) out.push(`${r} -> ${fs.readlinkSync(abs)}`);
      else if (st.isDirectory()) {
        out.push(`${r}/`);
        walk(abs, r);
      } else out.push(r);
    }
  };
  walk(root, "");
  return out;
}

const MOVED_TREE = [
  "logs/",
  "logs/main.log",
  "oauth-login/",
  "oauth-login/state.json",
  "provider-keys.json",
  "registry.json",
  "remote-instances.json",
  "worktrees/",
  "worktrees/proj/",
  "worktrees/proj/wt-1/",
  "worktrees/proj/wt-1/.git",
  "worktrees/proj/wt-1/link -> sub/big.bin",
  "worktrees/proj/wt-1/sub/",
  "worktrees/proj/wt-1/sub/big.bin",
];

describe("legacyUserDataDir", () => {
  it("maps each flavor to Electron's pinned userData name", () => {
    expect(legacyUserDataDir("installed", "/cfg")).toBe(path.join("/cfg", "@omp-ui/desktop"));
    expect(legacyUserDataDir("dev", "/cfg")).toBe(path.join("/cfg", "@omp-ui/desktop-dev"));
    expect(legacyUserDataDir("dev-server", "/cfg")).toBe(path.join("/cfg", "@omp-ui/desktop-dev-server"));
  });
});

describe("legacyUserDataFromRelocation", () => {
  it("recovers the original parent from committed relocation evidence", async () => {
    const f = legacyFixture();
    await relocateAuthorityStores({
      legacyUserData: f.legacy,
      dataRoot: f.dataRoot,
      journal: f.journal,
      git: gitOk,
      breadcrumbs: NO_BREADCRUMBS,
    });
    expect(legacyUserDataFromRelocation(f.journal)).toBe(f.legacy);
  });

  it("returns null when every relocation item was skipped", async () => {
    const legacy = tmp("legacy-empty-recovery");
    const dataRoot = path.join(tmp("root-empty-recovery"), "omp-ui");
    const journal = MigrationJournal.open(dataRoot, { now: () => 1 });
    await relocateAuthorityStores({ legacyUserData: legacy, dataRoot, journal, git: gitOk, breadcrumbs: NO_BREADCRUMBS });
    expect(legacyUserDataFromRelocation(journal)).toBeNull();
  });

  it("throws when non-skipped source parents disagree", () => {
    const dataRoot = path.join(tmp("root-conflict-recovery"), "omp-ui");
    const journal = MigrationJournal.open(dataRoot, { now: () => 1 });
    journal.begin("relocate-authority-stores-v1");
    const evidence = (name: string, source: string): ItemEvidence => ({
      name,
      source,
      destination: path.join(dataRoot, name),
      mode: 0,
      size: 0,
      mtimeMs: 0,
      dev: 0,
      ino: 0,
      status: "done",
    });
    journal.updateItem("relocate-authority-stores-v1", evidence("provider-keys.json", "/legacy-a/provider-keys.json"));
    journal.updateItem("relocate-authority-stores-v1", evidence("registry.json", "/legacy-b/registry.json"));
    journal.commit("relocate-authority-stores-v1");
    expect(() => legacyUserDataFromRelocation(journal)).toThrow(MigrationConflict);
  });
});

describe("relocateAuthorityStores", () => {
  it("moves every store into the data root, records evidence, and commits", async () => {
    const f = legacyFixture();
    await relocateAuthorityStores({
      legacyUserData: f.legacy,
      dataRoot: f.dataRoot,
      journal: f.journal,
      git: gitOk,
      breadcrumbs: NO_BREADCRUMBS,
    });
    expect(tree(f.dataRoot).filter((p) => p !== "migration.json")).toEqual(MOVED_TREE);
    expect(fs.readdirSync(f.legacy)).toEqual([]);
    expect(fs.statSync(path.join(f.dataRoot, "provider-keys.json")).mode & 0o777).toBe(0o600);

    const step = f.journal.step("relocate-authority-stores-v1");
    expect(step?.status).toBe("committed");
    expect(step?.items.map((i) => [i.name, i.status])).toEqual(RELOCATED_ITEMS.map((n) => [n, "done"]));
  });

  it("records absent items as skipped and is a no-op once committed", async () => {
    const legacy = tmp("legacy-empty");
    const dataRoot = path.join(tmp("root"), "omp-ui");
    const journal = MigrationJournal.open(dataRoot, { now: () => 1 });
    const opts = { legacyUserData: legacy, dataRoot, journal, git: gitOk, breadcrumbs: NO_BREADCRUMBS };
    await relocateAuthorityStores(opts);
    expect(journal.step("relocate-authority-stores-v1")?.items.every((i) => i.status === "skipped")).toBe(true);

    // A later legacy file must not be picked up: the step is closed.
    fs.writeFileSync(path.join(legacy, "registry.json"), "{}");
    await relocateAuthorityStores(opts);
    expect(fs.existsSync(path.join(dataRoot, "registry.json"))).toBe(false);
  });

  it("refuses a destination that exists without journal evidence", async () => {
    const f = legacyFixture();
    fs.mkdirSync(f.dataRoot, { recursive: true });
    fs.writeFileSync(path.join(f.dataRoot, "registry.json"), "someone else's");
    await expect(
      relocateAuthorityStores({
        legacyUserData: f.legacy,
        dataRoot: f.dataRoot,
        journal: f.journal,
        git: gitOk,
        breadcrumbs: NO_BREADCRUMBS,
      }),
    ).rejects.toThrow(MigrationConflict);
    expect(fs.readFileSync(path.join(f.dataRoot, "registry.json"), "utf8")).toBe("someone else's");
    expect(fs.existsSync(path.join(f.legacy, "registry.json"))).toBe(true);
  });

  it("falls back to copy + verify + fsync + remove when rename fails with EXDEV", async () => {
    const f = legacyFixture();
    const breadcrumbs = recordingBreadcrumbs();
    const exdev = (): never => {
      const error = new Error("cross-device") as NodeJS.ErrnoException;
      error.code = "EXDEV";
      throw error;
    };
    await relocateAuthorityStores({
      legacyUserData: f.legacy,
      dataRoot: f.dataRoot,
      journal: f.journal,
      git: gitOk,
      breadcrumbs,
      rename: exdev,
    });
    expect(tree(f.dataRoot).filter((p) => p !== "migration.json")).toEqual(MOVED_TREE);
    expect(fs.readdirSync(f.legacy)).toEqual([]);
    expect(fs.readFileSync(path.join(f.dataRoot, "worktrees/proj/wt-1/sub/big.bin")).equals(Buffer.alloc(3 * 1024 * 1024, 7))).toBe(
      true,
    );
    expect(fs.statSync(path.join(f.dataRoot, "provider-keys.json")).mode & 0o777).toBe(0o600);
    expect(breadcrumbs.details.filter((d) => d.includes("across devices"))).toHaveLength(6);
    expect(f.journal.step("relocate-authority-stores-v1")?.status).toBe("committed");
  });

  describe("replay from journal evidence", () => {
    function seeded(status: ItemEvidence["status"], source: string, destination: string): ItemEvidence {
      const st = fs.lstatSync(source);
      return {
        name: path.basename(source),
        source,
        destination,
        mode: st.mode,
        size: st.size,
        mtimeMs: st.mtimeMs,
        dev: st.dev,
        ino: st.ino,
        status,
      };
    }

    it("source-only → redoes the move", async () => {
      const f = legacyFixture();
      const source = path.join(f.legacy, "registry.json");
      f.journal.begin("relocate-authority-stores-v1");
      f.journal.updateItem("relocate-authority-stores-v1", seeded("pending", source, path.join(f.dataRoot, "registry.json")));
      await relocateAuthorityStores({ legacyUserData: f.legacy, dataRoot: f.dataRoot, journal: f.journal, git: gitOk, breadcrumbs: NO_BREADCRUMBS });
      expect(fs.existsSync(path.join(f.dataRoot, "registry.json"))).toBe(true);
      expect(fs.existsSync(source)).toBe(false);
    });

    it("destination-only → marks the item done without touching bytes", async () => {
      const f = legacyFixture();
      const source = path.join(f.legacy, "registry.json");
      const destination = path.join(f.dataRoot, "registry.json");
      f.journal.begin("relocate-authority-stores-v1");
      f.journal.updateItem("relocate-authority-stores-v1", seeded("pending", source, destination));
      fs.mkdirSync(f.dataRoot, { recursive: true });
      fs.renameSync(source, destination);
      fs.writeFileSync(destination, "already moved, then edited");
      await relocateAuthorityStores({ legacyUserData: f.legacy, dataRoot: f.dataRoot, journal: f.journal, git: gitOk, breadcrumbs: NO_BREADCRUMBS });
      expect(fs.readFileSync(destination, "utf8")).toBe("already moved, then edited");
      expect(f.journal.step("relocate-authority-stores-v1")?.items.find((i) => i.name === "registry.json")?.status).toBe("done");
    });

    it("neither → MigrationConflict", async () => {
      const f = legacyFixture();
      const source = path.join(f.legacy, "registry.json");
      f.journal.begin("relocate-authority-stores-v1");
      f.journal.updateItem("relocate-authority-stores-v1", seeded("pending", source, path.join(f.dataRoot, "registry.json")));
      fs.rmSync(source);
      await expect(
        relocateAuthorityStores({ legacyUserData: f.legacy, dataRoot: f.dataRoot, journal: f.journal, git: gitOk, breadcrumbs: NO_BREADCRUMBS }),
      ).rejects.toThrow(/neither/);
    });

    it("both, equal bytes and matching identity → dedupes by removing the source", async () => {
      const f = legacyFixture();
      const source = path.join(f.legacy, "worktrees");
      const destination = path.join(f.dataRoot, "worktrees");
      f.journal.begin("relocate-authority-stores-v1");
      fs.mkdirSync(f.dataRoot, { recursive: true });
      fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
      f.journal.updateItem("relocate-authority-stores-v1", seeded("moved", source, destination));
      await relocateAuthorityStores({ legacyUserData: f.legacy, dataRoot: f.dataRoot, journal: f.journal, git: gitOk, breadcrumbs: NO_BREADCRUMBS });
      expect(fs.existsSync(source)).toBe(false);
      expect(tree(destination)).toEqual(tree(f.dataRoot).filter((p) => p.startsWith("worktrees/") && p !== "worktrees/").map((p) => p.slice("worktrees/".length)));
    });

    it("both with differing bytes → MigrationConflict, nothing touched", async () => {
      const f = legacyFixture();
      const source = path.join(f.legacy, "registry.json");
      const destination = path.join(f.dataRoot, "registry.json");
      f.journal.begin("relocate-authority-stores-v1");
      fs.mkdirSync(f.dataRoot, { recursive: true });
      fs.writeFileSync(destination, "different");
      f.journal.updateItem("relocate-authority-stores-v1", seeded("moved", source, destination));
      await expect(
        relocateAuthorityStores({ legacyUserData: f.legacy, dataRoot: f.dataRoot, journal: f.journal, git: gitOk, breadcrumbs: NO_BREADCRUMBS }),
      ).rejects.toThrow(/not the same bytes/);
      expect(fs.existsSync(source)).toBe(true);
      expect(fs.readFileSync(destination, "utf8")).toBe("different");
    });

    it("both with equal bytes but a source rewritten since the evidence → MigrationConflict", async () => {
      const f = legacyFixture();
      const source = path.join(f.legacy, "registry.json");
      const destination = path.join(f.dataRoot, "registry.json");
      f.journal.begin("relocate-authority-stores-v1");
      fs.mkdirSync(f.dataRoot, { recursive: true });
      fs.copyFileSync(source, destination);
      const evidence = seeded("moved", source, destination);
      f.journal.updateItem("relocate-authority-stores-v1", { ...evidence, ino: evidence.ino + 1 });
      await expect(
        relocateAuthorityStores({ legacyUserData: f.legacy, dataRoot: f.dataRoot, journal: f.journal, git: gitOk, breadcrumbs: NO_BREADCRUMBS }),
      ).rejects.toThrow(MigrationConflict);
      expect(fs.existsSync(source)).toBe(true);
    });
  });

  describe("worktree repair", () => {
    function registryWith(legacy: string) {
      return {
        schemaVersion: 1,
        settings: { hibernate: true },
        projects: [{ path: "/repo" }],
        sessions: [
          {
            tabId: "t1",
            projectCwd: "/repo",
            worktree: { path: path.join(legacy, "worktrees", "proj", "wt-1"), branch: "feat", base: "main" },
            extra: "kept",
          },
          { tabId: "t2", projectCwd: "/repo", worktree: null },
          { tabId: "t3", projectCwd: "/elsewhere", worktree: { path: "/somewhere/else", branch: "x", base: null } },
        ],
      };
    }

    it("repairs each moved checkout from its project and rewrites the path", async () => {
      const f = legacyFixture(registryWith("PLACEHOLDER"));
      fs.writeFileSync(path.join(f.legacy, "registry.json"), JSON.stringify(registryWith(f.legacy)));
      const calls: Array<[string[], string]> = [];
      await relocateAuthorityStores({
        legacyUserData: f.legacy,
        dataRoot: f.dataRoot,
        journal: f.journal,
        git: async (args, cwd) => {
          calls.push([args, cwd]);
          return { code: 0, stdout: "", stderr: "" };
        },
        breadcrumbs: NO_BREADCRUMBS,
      });
      const newPath = path.join(f.dataRoot, "worktrees", "proj", "wt-1");
      expect(calls).toEqual([[["worktree", "repair", newPath], "/repo"]]);
      const registry = JSON.parse(fs.readFileSync(path.join(f.dataRoot, "registry.json"), "utf8"));
      expect(registry.sessions[0]).toEqual({
        tabId: "t1",
        projectCwd: "/repo",
        worktree: { path: newPath, branch: "feat", base: "main" },
        extra: "kept",
      });
      expect(registry.sessions[1]).toEqual({ tabId: "t2", projectCwd: "/repo", worktree: null });
      expect(registry.sessions[2].worktree.path).toBe("/somewhere/else");
      expect(registry.settings).toEqual({ hibernate: true });
    });

    it("keeps the moved path and flags resumeUnavailable when git repair fails", async () => {
      const f = legacyFixture(registryWith("PLACEHOLDER"));
      fs.writeFileSync(path.join(f.legacy, "registry.json"), JSON.stringify(registryWith(f.legacy)));
      const breadcrumbs = recordingBreadcrumbs();
      await relocateAuthorityStores({
        legacyUserData: f.legacy,
        dataRoot: f.dataRoot,
        journal: f.journal,
        git: async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" }),
        breadcrumbs,
      });
      const registry = JSON.parse(fs.readFileSync(path.join(f.dataRoot, "registry.json"), "utf8"));
      expect(registry.sessions[0].worktree).toEqual({
        path: path.join(f.dataRoot, "worktrees", "proj", "wt-1"),
        branch: "feat",
        base: "main",
        resumeUnavailable: true,
      });
      expect(breadcrumbs.details.some((d) => d.includes("worktree repair failed") && d.includes("not a git repository"))).toBe(true);
      expect(f.journal.step("relocate-authority-stores-v1")?.status).toBe("committed");
    });
  });
});
