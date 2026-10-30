import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROJECT_COPY_FILE_MAX_BYTES, PROJECT_COPY_FOLDER_FILES_MAX } from "./fleet";
import { git } from "./git";
import { previewProjectCopy, readProjectCopyFiles } from "./project-copy";

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function checkout(remote: string | null): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-copy-"));
  cleanups.push(dir);
  await git(dir, ["init", "-q", "-b", "main"]);
  if (remote !== null) await git(dir, ["remote", "add", "origin", remote]);
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write(".gitignore", ".env\n.env.local\nnode_modules/\nconfig/local/\n*.log\nbig.bin\n");
  write("src/app.ts", "tracked");
  write(".env", "DATABASE_URL=postgres://localhost/app\n");
  write(".env.local", "export OPENROUTER_API_KEY=sk-or-123\n");
  write("config/local/settings.json", '{"port":3000}');
  write("logs/debug.log", "trace");
  for (let i = 0; i <= PROJECT_COPY_FOLDER_FILES_MAX; i += 1) write(`node_modules/pkg/f${i}.js`, "x");
  fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(PROJECT_COPY_FILE_MAX_BYTES + 1));
  return dir;
}

describe("Project copy source scan (issue #992)", () => {
  it("offers small ignored files, skips Provider keys, dependency trees, and oversized files", async () => {
    const dir = await checkout("git@github.com:Acme/App.git");
    const preview = await previewProjectCopy(dir);
    expect(preview.repositoryUrl).toBe("https://github.com/Acme/App");
    expect(preview.remote).toBe("ssh");
    expect(preview.files.map((f) => f.path)).toEqual([".env", "config/local/settings.json", "logs/debug.log"]);
    expect(preview.skipped).toEqual(
      expect.arrayContaining([
        { path: ".env.local", reason: "provider-key", envName: "OPENROUTER_API_KEY" },
        { path: "node_modules/", reason: "folder-too-large", envName: null },
        { path: "big.bin", reason: "too-large", envName: null },
      ]),
    );
  });

  it("reads only offered picks and refuses one the scan never offered", async () => {
    const dir = await checkout("https://github.com/acme/app.git");
    const read = await readProjectCopyFiles(dir, [".env", ".env.local", "src/app.ts"]);
    expect(read.preview.remote).toBe("https");
    expect(read.files).toEqual([{ path: ".env", data: Buffer.from("DATABASE_URL=postgres://localhost/app\n").toString("base64"), executable: false }]);
    expect(read.failed.map((f) => f.path)).toEqual([".env.local", "src/app.ts"]);
  });

  it("reports no web remote for a checkout without one", async () => {
    const preview = await previewProjectCopy(await checkout(null));
    expect(preview).toMatchObject({ repositoryUrl: null, remote: "none" });
  });
});
