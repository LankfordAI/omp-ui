// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveTheme, type ThemeSource } from "@omp-ui/core/theme";
import { sourceFromDraft } from "@omp-ui/core/theme-file";
import type { ThemeOrigin } from "@omp-ui/core/theme-origin";
import { applyBackdropMotion } from "../lib/backdrop-motion";
import { applyTheme } from "../lib/themes";
import { BackdropLayer } from "./BackdropLayer";

vi.mock("../lib/backdrop", () => ({
  loadBackdropAsset: async () => ({ url: "blob:anim", stillUrl: "blob:still", kind: "scene" }),
  applyBackdropChrome: () => {},
  useDraftBackdropAsset: () => null,
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

function sceneTheme(origin: ThemeOrigin | null): ThemeSource {
  return {
    ...sourceFromDraft("custom-scene", "Scene", { canvas: "#1a1b26" }),
    backdrop: { assetHash: "f".repeat(64), kind: "scene", mime: "image/svg+xml", blur: 12 },
    ...(origin !== null ? { origin } : {}),
  };
}

const ORIGIN = { repository: "o/r", path: "a.json", commit: "a".repeat(40), blob: "b".repeat(40) };

async function rendered(source: ThemeSource): Promise<string | null> {
  applyBackdropMotion(true);
  applyTheme(deriveTheme(source));
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<BackdropLayer />);
  });
  return host.querySelector("img")?.getAttribute("src") ?? null;
}

describe("BackdropLayer repository scenes (#1178)", () => {
  it("keeps an installed theme's scene still until its Animate switch is on", async () => {
    expect(await rendered(sceneTheme({ ...ORIGIN, animate: false }))).toBe("blob:still");
  });

  it("animates an installed scene the user allowed, and any non-repository scene", async () => {
    expect(await rendered(sceneTheme({ ...ORIGIN, animate: true }))).toBe("blob:anim");
    act(() => root!.unmount());
    root = null;
    expect(await rendered(sceneTheme(null))).toBe("blob:anim");
  });
});
