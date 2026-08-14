import type { ProjectOpenTarget } from "@omp-ui/core";
import { describe, expect, it, vi } from "vitest";
import { ProjectOpener, vscodeProjectUrl, type ProjectOpenHost } from "./project-open";

vi.mock("electron", () => ({
  app: { getApplicationNameForProtocol: vi.fn(() => "") },
  shell: {
    openExternal: vi.fn(async () => {}),
    openPath: vi.fn(async () => ""),
  },
}));


function makeHost(overrides: Partial<ProjectOpenHost> = {}) {
  const getApplicationNameForProtocol = vi.fn(
    overrides.getApplicationNameForProtocol ?? (() => "Visual Studio Code"),
  );
  const openExternal = vi.fn(overrides.openExternal ?? (async () => {}));
  const openPath = vi.fn(overrides.openPath ?? (async () => ""));
  return {
    host: { getApplicationNameForProtocol, openExternal, openPath },
    getApplicationNameForProtocol,
    openExternal,
    openPath,
  };
}

describe("ProjectOpener availability", () => {
  it("detects the registered stable VS Code protocol handler", () => {
    const { host, getApplicationNameForProtocol } = makeHost();
    const opener = new ProjectOpener(host);

    expect(opener.availability()).toEqual({ vsCode: true });
    expect(getApplicationNameForProtocol).toHaveBeenCalledOnce();
    expect(getApplicationNameForProtocol).toHaveBeenCalledWith("vscode://file/");
  });

  it("reports an empty protocol-handler name as unavailable", () => {
    const { host, getApplicationNameForProtocol } = makeHost({
      getApplicationNameForProtocol: () => "",
    });
    const opener = new ProjectOpener(host);

    expect(opener.availability()).toEqual({ vsCode: false });
    expect(opener.availability()).toEqual({ vsCode: false });
    expect(getApplicationNameForProtocol).toHaveBeenCalledOnce();
  });

  it("reports discovery exceptions as unavailable", () => {
    const { host, getApplicationNameForProtocol } = makeHost({
      getApplicationNameForProtocol: () => {
        throw new Error("protocol registry unavailable");
      },
    });
    const opener = new ProjectOpener(host);

    expect(opener.availability()).toEqual({ vsCode: false });
    expect(opener.availability()).toEqual({ vsCode: false });
    expect(getApplicationNameForProtocol).toHaveBeenCalledOnce();
  });

  it("shares one cached discovery result across availability checks and opens", async () => {
    const { host, getApplicationNameForProtocol, openExternal } = makeHost();
    const opener = new ProjectOpener(host);

    expect(opener.availability()).toEqual({ vsCode: true });
    await opener.open("/work/one", "vscode");
    expect(opener.availability()).toEqual({ vsCode: true });
    await opener.open("/work/two", "vscode");

    expect(getApplicationNameForProtocol).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenNthCalledWith(1, "vscode://file/work/one?windowId=_blank");
    expect(openExternal).toHaveBeenNthCalledWith(2, "vscode://file/work/two?windowId=_blank");
  });

  it("uses only the stable vscode scheme for discovery and launch", async () => {
    const { host, getApplicationNameForProtocol, openExternal } = makeHost();
    const opener = new ProjectOpener(host);

    await opener.open("/work/project", "vscode");

    expect(getApplicationNameForProtocol.mock.calls).toEqual([["vscode://file/"]]);
    expect(openExternal.mock.calls).toEqual([["vscode://file/work/project?windowId=_blank"]]);
  });
});

describe("vscodeProjectUrl", () => {
  it("encodes every special POSIX path segment while preserving the root", () => {
    expect(vscodeProjectUrl('/tmp/My Project/#draft?/"quoted"/雪/%done/-leading')).toBe(
      "vscode://file/tmp/My%20Project/%23draft%3F/%22quoted%22/%E9%9B%AA/%25done/-leading?windowId=_blank",
    );
  });

  it("normalizes a Windows drive path and preserves its drive colon", () => {
    expect(vscodeProjectUrl("C:\\Users\\Ada Lovelace\\project#1")).toBe(
      "vscode://file/c:/Users/Ada%20Lovelace/project%231?windowId=_blank",
    );
  });

  it("normalizes UNC separators without collapsing the double-slash root", () => {
    expect(vscodeProjectUrl("\\\\server\\Shared Folder\\雪")).toBe(
      "vscode://file//server/Shared%20Folder/%E9%9B%AA?windowId=_blank",
    );
  });

  it("asks VS Code to open the project in a new window", () => {
    expect(vscodeProjectUrl("/work/one")).toBe("vscode://file/work/one?windowId=_blank");
  });
});

describe("ProjectOpener files launch", () => {
  it("passes the exact project path to the system file manager", async () => {
    const projectPath = 'C:\\-projects\\a "quoted" folder';
    const { host, openPath, openExternal, getApplicationNameForProtocol } = makeHost();
    const opener = new ProjectOpener(host);

    await opener.open(projectPath, "files");

    expect(openPath).toHaveBeenCalledOnce();
    expect(openPath).toHaveBeenCalledWith(projectPath);
    expect(openExternal).not.toHaveBeenCalled();
    expect(getApplicationNameForProtocol).not.toHaveBeenCalled();
  });

  it("turns a nonempty openPath result into an actionable failure", async () => {
    const projectPath = "/work/missing project";
    const { host } = makeHost({ openPath: async () => "No application is associated" });
    const opener = new ProjectOpener(host);

    await expect(opener.open(projectPath, "files")).rejects.toThrow(
      `Could not open "${projectPath}" in the system file manager: No application is associated.`,
    );
  });
});

describe("ProjectOpener VS Code launch", () => {
  it("refuses to launch when stable VS Code is unavailable", async () => {
    const projectPath = "/work/project";
    const { host, openExternal } = makeHost({ getApplicationNameForProtocol: () => "" });
    const opener = new ProjectOpener(host);

    await expect(opener.open(projectPath, "vscode")).rejects.toThrow(
      `VS Code is not available to open "${projectPath}". Open the project in Files instead.`,
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("re-probes after a launch rejection and retries exactly once when still registered", async () => {
    const projectPath = "/work/retry project";
    const { host, getApplicationNameForProtocol, openExternal } = makeHost();
    openExternal.mockRejectedValueOnce(new Error("stale handler")).mockResolvedValueOnce(undefined);
    const opener = new ProjectOpener(host);

    await opener.open(projectPath, "vscode");

    expect(getApplicationNameForProtocol).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openExternal.mock.calls).toEqual([
      ["vscode://file/work/retry%20project?windowId=_blank"],
      ["vscode://file/work/retry%20project?windowId=_blank"],
    ]);
    expect(opener.availability()).toEqual({ vsCode: true });
    expect(getApplicationNameForProtocol).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the handler disappears and clears the failed cache", async () => {
    const projectPath = "/work/disappearing";
    const { host, getApplicationNameForProtocol, openExternal } = makeHost();
    getApplicationNameForProtocol
      .mockReturnValueOnce("Visual Studio Code")
      .mockReturnValueOnce("")
      .mockReturnValue("Visual Studio Code");
    openExternal.mockRejectedValueOnce(new Error("handler vanished"));
    const opener = new ProjectOpener(host);

    await expect(opener.open(projectPath, "vscode")).rejects.toThrow(
      `Could not open "${projectPath}" in VS Code: handler vanished. Open the project in Files instead.`,
    );
    expect(openExternal).toHaveBeenCalledOnce();
    expect(getApplicationNameForProtocol).toHaveBeenCalledTimes(2);

    expect(opener.availability()).toEqual({ vsCode: true });
    expect(getApplicationNameForProtocol).toHaveBeenCalledTimes(3);
  });

  it("reports the retry cause, stops after one retry, and clears the failed cache", async () => {
    const projectPath = "/work/broken";
    const { host, getApplicationNameForProtocol, openExternal } = makeHost();
    openExternal
      .mockRejectedValueOnce(new Error("first launch failed"))
      .mockRejectedValueOnce(new Error("retry launch failed"));
    const opener = new ProjectOpener(host);

    await expect(opener.open(projectPath, "vscode")).rejects.toThrow(
      `Could not open "${projectPath}" in VS Code: retry launch failed. Open the project in Files instead.`,
    );
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(getApplicationNameForProtocol).toHaveBeenCalledTimes(2);

    expect(opener.availability()).toEqual({ vsCode: true });
    expect(getApplicationNameForProtocol).toHaveBeenCalledTimes(3);
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it("rejects an unknown runtime target before invoking any host launch surface", async () => {
    const { host, getApplicationNameForProtocol, openExternal, openPath } = makeHost();
    const opener = new ProjectOpener(host);

    await expect(
      opener.open("/work/project", "cursor" as ProjectOpenTarget),
    ).rejects.toThrow("Unknown project open target: cursor");
    expect(getApplicationNameForProtocol).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });
});
