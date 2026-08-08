import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installApplicationMenu } from "./application-menu";

let builtTemplate: unknown;
let installedMenu: unknown;

vi.mock("electron", () => ({
  app: { name: "omp-ui" },
  Menu: {
    buildFromTemplate: (template: unknown) => {
      builtTemplate = template;
      return { template };
    },
    setApplicationMenu: (menu: unknown) => {
      installedMenu = menu;
    },
  },
}));

describe("installApplicationMenu", () => {
  beforeEach(() => {
    builtTemplate = undefined;
    installedMenu = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("installs the native Darwin menu", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    installApplicationMenu();

    expect(builtTemplate).toEqual([
      {
        label: "omp-ui",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { label: "File", submenu: [{ role: "close" }] },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "pasteAndMatchStyle" },
          { role: "delete" },
          { role: "selectAll" },
        ],
      },
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          { type: "separator" },
          { role: "front" },
        ],
      },
    ]);
    expect(installedMenu).toEqual({ template: builtTemplate });
  });

  it("leaves the application menu unchanged outside Darwin", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    installApplicationMenu();

    expect(builtTemplate).toBeUndefined();
    expect(installedMenu).toBeUndefined();
  });
});
