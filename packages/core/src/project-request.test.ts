import { describe, expect, it } from "vitest";
import { cloneRepositoryName, parseCloneSource } from "./project-request";

describe("parseCloneSource (#1228)", () => {
  it.each([
    ["https://github.com/acme/app.git", "https", "app"],
    ["ssh://git@github.com:22/acme/app.git", "ssh", "app"],
    ["git@github.com:acme/app.git", "ssh", "app"],
  ] as const)("accepts %s", (raw, transport, name) => {
    expect(parseCloneSource(raw)).toMatchObject({ ok: true, transport, name });
  });

  it("keeps the scp-like form verbatim", () => {
    expect(parseCloneSource("git@github.com:acme/app.git")).toMatchObject({ url: "git@github.com:acme/app.git" });
  });

  it.each([
    ["http://github.com/acme/app.git"],
    ["file:///srv/repos/app"],
    ["git://github.com/acme/app.git"],
    ["ext::sh -c touch% /tmp/pwned"],
    ["https://user:token@github.com/acme/app.git"],
    ["https://token@github.com/acme/app.git"],
    ["--upload-pack=touch /tmp/pwned"],
    ["/srv/repos/app"],
    ["./app"],
    ["https://github.com/"],
    ["https://github.com/acme/.."],
    [""],
  ])("refuses %j", (raw) => {
    expect(parseCloneSource(raw)).toMatchObject({ ok: false, reason: expect.any(String) });
  });
});

describe("cloneRepositoryName", () => {
  it("matches the member clone rule", () => {
    expect(cloneRepositoryName("/acme/app.git")).toBe("app");
    expect(cloneRepositoryName("acme/app.git")).toBe("app");
    expect(cloneRepositoryName("/acme/re%24po.git")).toBe("re24po");
    expect(cloneRepositoryName("/")).toBeNull();
    expect(cloneRepositoryName("/acme/..")).toBeNull();
    expect(cloneRepositoryName("..")).toBeNull();
  });
});
