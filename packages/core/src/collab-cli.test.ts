import { describe, expect, it } from "vitest";
import { getCollabLink, listCollabHosts, type CollabCliExec, type CollabCliResult } from "./collab-cli";

const HOST = {
  instanceId: "inst-1",
  pid: 4242,
  generation: 3,
  sessionId: "sess-abc",
  sessionName: "my session",
  cwd: "/repo",
  model: "anthropic/claude",
  startedAt: "2026-09-29T00:00:00.000Z",
  participants: 2,
  access: "full",
  relayConnected: true,
  inputRequired: false,
  busy: true,
};

function fakeExec(result: CollabCliResult): { exec: CollabCliExec; argvs: string[][] } {
  const argvs: string[][] = [];
  const exec: CollabCliExec = (_ompPath, argv) => {
    argvs.push([...argv]);
    return Promise.resolve(result);
  };
  return { exec, argvs };
}

const ok = (stdout: string): CollabCliResult => ({ stdout, stderr: "", code: 0 });

describe("listCollabHosts", () => {
  it("invokes the registry CLI and parses the listing", async () => {
    const { exec, argvs } = fakeExec(ok(JSON.stringify({ version: 1, hosts: [HOST] })));
    await expect(listCollabHosts("/bin/omp", { exec })).resolves.toEqual([HOST]);
    expect(argvs).toEqual([["collab", "list", "--json"]]);
  });

  it("reports unknown on nonzero exit", async () => {
    const { exec } = fakeExec({ stdout: "", stderr: "error: registry unavailable", code: 1 });
    await expect(listCollabHosts("/bin/omp", { exec })).resolves.toBeNull();
  });

  it("reports unknown on unparsable stdout", async () => {
    const { exec } = fakeExec(ok("not json"));
    await expect(listCollabHosts("/bin/omp", { exec })).resolves.toBeNull();
  });
});

describe("getCollabLink", () => {
  it("returns the url for a hosted pid with --view forwarded", async () => {
    const { exec, argvs } = fakeExec(ok(JSON.stringify({ url: "https://my.omp.sh/s#key" })));
    await expect(getCollabLink("/bin/omp", "4242", true, { exec })).resolves.toEqual({
      ok: true,
      url: "https://my.omp.sh/s#key",
    });
    expect(argvs).toEqual([["collab", "link", "4242", "--json", "--view"]]);
  });

  it("omits --view for a control link", async () => {
    const { exec, argvs } = fakeExec(ok(JSON.stringify({ url: "https://my.omp.sh/s#key" })));
    await getCollabLink("/bin/omp", "4242", false, { exec });
    expect(argvs).toEqual([["collab", "link", "4242", "--json"]]);
  });

  it("carries the selector as one argv element verbatim", async () => {
    const { exec, argvs } = fakeExec(ok(JSON.stringify({ url: "https://my.omp.sh/s#k" })));
    await getCollabLink("/bin/omp", "4242; rm -rf /", false, { exec });
    expect(argvs[0]?.[2]).toBe("4242; rm -rf /");
  });

  it("surfaces omp's stderr refusal verbatim", async () => {
    const { exec } = fakeExec({
      stdout: "",
      stderr: "error: no active Collab host matches 12345\n",
      code: 1,
    });
    await expect(getCollabLink("/bin/omp", "12345", false, { exec })).resolves.toEqual({
      ok: false,
      message: "no active Collab host matches 12345",
    });
  });

  it("fails a zero-exit with no usable url", async () => {
    const { exec } = fakeExec(ok(""));
    await expect(getCollabLink("/bin/omp", "1", false, { exec })).resolves.toEqual({
      ok: false,
      message: "omp returned no Collab link",
    });
  });
});
