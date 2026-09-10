import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startVerifierOrigin, type VerifierOrigin } from "./static-origin";

describe("startVerifierOrigin", () => {
  let root: string;
  let origin: VerifierOrigin;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-verifier-origin-"));
    fs.mkdirSync(path.join(root, "page", "assets"), { recursive: true });
    fs.writeFileSync(path.join(root, "page", "index.html"), "<!doctype html><p>verifier</p>");
    fs.writeFileSync(path.join(root, "page", "assets", "entry.js"), "export {};");
    fs.writeFileSync(path.join(root, "secret.txt"), "outside");
    origin = await startVerifierOrigin(path.join(root, "page"));
  });

  afterAll(async () => {
    await origin.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const get = (p: string) => fetch(`${origin.origin}${p}`, { redirect: "manual" });

  it("serves regular files beneath the prefix with their MIME type", async () => {
    const html = await get(`/${origin.prefix}/index.html`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await html.text()).toContain("verifier");
    const js = await get(`/${origin.prefix}/assets/entry.js`);
    expect([js.status, js.headers.get("content-type")]).toEqual([200, "text/javascript; charset=utf-8"]);
  });

  it("answers 404 off the prefix, for directories, and for unknown paths (no SPA fallback)", async () => {
    expect((await get("/index.html")).status).toBe(404);
    expect((await get("/")).status).toBe(404);
    expect((await get(`/${origin.prefix}/`)).status).toBe(404);
    expect((await get(`/${origin.prefix}/assets`)).status).toBe(404);
    expect((await get(`/${origin.prefix}/route`)).status).toBe(404);
  });

  it("keeps encoded and plain traversal inside the page directory", async () => {
    expect((await get(`/${origin.prefix}/../secret.txt`)).status).toBe(404);
    expect((await get(`/${origin.prefix}/%2e%2e/secret.txt`)).status).toBe(404);
    expect((await get(`/${origin.prefix}/assets/..%2f..%2fsecret.txt`)).status).toBe(404);
    expect((await get(`/${origin.prefix}/%zz`)).status).toBe(404);
  });
});
