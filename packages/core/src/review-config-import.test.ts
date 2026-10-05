import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewDocument } from "./review-config";
import { importReviewRosters, type ReviewImportProject, type ReviewImportRegistry } from "./review-config-import";

let root: string;
let home: string;
let agentDir: string;
let env: NodeJS.ProcessEnv;

interface Write {
  setting?: ReviewDocument;
  project?: { path: string; document: ReviewDocument | null };
}

/** In-memory registry shaped like the real one's slice the importer needs. */
function fakeRegistry(projects: ReviewImportProject[]): ReviewImportRegistry & { writes: Write[] } {
  const list = [...projects];
  let global: ReviewDocument | null = null;
  const writes: Write[] = [];
  return {
    writes,
    getSetting: () => global,
    setSetting: (_key, value) => {
      global = value;
      writes.push({ setting: value });
    },
    get projects() {
      return list;
    },
    setProjectReviewRoster: (projectPath, document) => {
      const i = list.findIndex((p) => p.path === projectPath);
      if (i < 0) throw new Error("unknown project");
      list[i] = { ...list[i]!, reviewRoster: document };
      writes.push({ project: { path: projectPath, document } });
    },
  };
}

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const rosterYml = (name: string): string =>
  `reviewers:\n  - name: ${name}\n`;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rvimport-")));
  home = path.join(root, "home");
  agentDir = path.join(home, ".omp", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("importReviewRosters", () => {
  it("a clean install imports nothing and finishes", () => {
    const reg = fakeRegistry([]);
    const out = importReviewRosters(reg, env, home);
    expect(out).toEqual({ done: true, importedFiles: [] });
    expect(reg.writes).toHaveLength(0);
  });

  it("the user file seeds the global slot only when it is unset", () => {
    write(path.join(agentDir, "REVIEW.yml"), rosterYml("hawk"));
    const reg = fakeRegistry([]);
    const out = importReviewRosters(reg, env, home);
    expect(out.done).toBe(true);
    expect(reg.writes).toEqual([
      { setting: { instructions: null, reviewers: [{ name: "hawk", model: null, instructions: null, targets: null, enabled: true }] } },
    ]);
    expect(out.importedFiles[0]).toContain("REVIEW.yml");

    // Second pass on the same state: the global slot is filled — the file
    // is never re-read.
    const out2 = importReviewRosters(reg, env, home);
    expect(reg.writes).toHaveLength(1);
    expect(out2.importedFiles).toEqual([]);
  });

  it(".yml wins the user slot over .yaml", () => {
    write(path.join(agentDir, "REVIEW.yml"), rosterYml("from-yml"));
    write(path.join(agentDir, "REVIEW.yaml"), rosterYml("from-yaml"));
    const reg = fakeRegistry([]);
    importReviewRosters(reg, env, home);
    expect(reg.writes[0]!.setting!.reviewers[0]!.name).toBe("from-yml");
  });

  it("attributes project files by the upward walk, nearest first", () => {
    const repo = path.join(root, "repo");
    const nested = path.join(repo, "packages", "app");
    write(path.join(nested, "REVIEW.yml"), rosterYml("nearest"));
    write(path.join(repo, ".omp", "REVIEW.yml"), rosterYml("root"));
    write(path.join(root, "REVIEW.yml"), rosterYml("outside"));
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const reg = fakeRegistry([{ path: nested, reviewRoster: null }]);
    const out = importReviewRosters(reg, env, home);
    expect(reg.writes).toHaveLength(1);
    expect(reg.writes[0]!.project!.document!.reviewers[0]!.name).toBe("nearest");
    expect(out.importedFiles[0]).toContain(path.join("packages", "app", "REVIEW.yml"));
  });

  it("a project already holding a roster is skipped entirely", () => {
    const repo = path.join(root, "repo2");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    write(path.join(repo, "REVIEW.yml"), rosterYml("root"));
    const held: ReviewDocument = { instructions: null, reviewers: [] };
    const reg = fakeRegistry([{ path: repo, reviewRoster: held }]);
    const out = importReviewRosters(reg, env, home);
    expect(reg.writes).toHaveLength(0);
    expect(out.importedFiles).toEqual([]);
  });

  it("a failing write leaves done false for the next boot", () => {
    const repo = path.join(root, "repo3");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    write(path.join(repo, "REVIEW.yml"), rosterYml("root"));
    const reg = fakeRegistry([{ path: repo, reviewRoster: null }]);
    const boom = {
      ...reg,
      setProjectReviewRoster: () => {
        throw new Error("disk gone");
      },
    };
    const out = importReviewRosters(boom, env, home);
    expect(out.done).toBe(false);
    expect(out.importedFiles).toEqual([]);
  });

  it("an empty file yields an empty document and still takes the slot", () => {
    const repo = path.join(root, "repo4");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    write(path.join(repo, "REVIEW.yml"), "# nothing here\n");
    const reg = fakeRegistry([{ path: repo, reviewRoster: null }]);
    const out = importReviewRosters(reg, env, home);
    expect(out.done).toBe(true);
    expect(reg.writes[0]!.project!.document).toEqual({ instructions: null, reviewers: [] });
  });

  it("a file outside every project walk (bare home) is not attributed", () => {
    write(path.join(home, "REVIEW.yml"), rosterYml("lonely"));
    const repo = path.join(root, "repo5");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const reg = fakeRegistry([{ path: repo, reviewRoster: null }]);
    const out = importReviewRosters(reg, env, home);
    // home sits above the .git stop, so the walk never reaches it.
    expect(reg.writes).toHaveLength(0);
    expect(out.importedFiles).toEqual([]);
  });
});
