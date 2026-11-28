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

const SCENE_DOC = "<!doctype html><html><body><svg></svg></body></html>";
const mockAsset = {
  current: {
    url: "blob:anim",
    stillUrl: "blob:still",
    sceneFrameDoc: SCENE_DOC,
    kind: "scene",
    mime: "image/svg+xml",
  } as {
    url: string;
    stillUrl: string;
    sceneFrameDoc?: string;
    kind: "image" | "scene" | "video";
    mime: string;
  },
};
const applyBackdropChromeMock = vi.fn();

vi.mock("../lib/backdrop", () => ({
  loadBackdropAsset: async () => mockAsset.current,
  applyBackdropChrome: (...args: unknown[]) => applyBackdropChromeMock(...args),
  useDraftBackdropAsset: () => null,
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const originalMatchMedia = window.matchMedia;
afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  applyBackdropChromeMock.mockReset();
  mockAsset.current = {
    url: "blob:anim",
    stillUrl: "blob:still",
    sceneFrameDoc: SCENE_DOC,
    kind: "scene",
    mime: "image/svg+xml",
  };
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

function sceneTheme(origin: ThemeOrigin | null): ThemeSource {
  return {
    ...sourceFromDraft("custom-scene", "Scene", { canvas: "#1a1b26" }),
    backdrop: { assetHash: "f".repeat(64), kind: "scene", mime: "image/svg+xml", blur: 12 },
    ...(origin !== null ? { origin } : {}),
  };
}

const ORIGIN = { repository: "o/r", path: "a.json", commit: "a".repeat(40), blob: "b".repeat(40) };

async function mountScene(source: ThemeSource): Promise<HTMLDivElement> {
  applyBackdropMotion(true);
  applyTheme(deriveTheme(source));
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<BackdropLayer />);
  });
  return host;
}

describe("BackdropLayer repository scenes (#1178)", () => {
  it("keeps an installed theme's scene still until its Animate switch is on", async () => {
    const host = await mountScene(sceneTheme({ ...ORIGIN, animate: false }));
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:still");
  });

  it("animates an installed scene the user allowed, and any non-repository scene, inside a sandboxed iframe", async () => {
    const host1 = await mountScene(sceneTheme({ ...ORIGIN, animate: true }));
    const frame1 = host1.querySelector("iframe");
    expect(frame1).not.toBeNull();
    expect(frame1!.getAttribute("sandbox")).toBe("");
    expect(frame1!.getAttribute("srcdoc")).toBe(SCENE_DOC);
    expect(frame1!.getAttribute("tabindex")).toBe("-1");
    expect(host1.querySelector("img")).toBeNull();

    act(() => root!.unmount());
    root = null;
    const host2 = await mountScene(sceneTheme(null));
    const frame2 = host2.querySelector("iframe");
    expect(frame2).not.toBeNull();
    expect(frame2!.getAttribute("sandbox")).toBe("");
    expect(frame2!.getAttribute("srcdoc")).toBe(SCENE_DOC);
  });

  it("swaps animating scenes back to stillUrl img when motion is off, hidden, or reduced-motion", async () => {
    const host = await mountScene(sceneTheme(null));
    expect(host.querySelector("iframe")).not.toBeNull();

    await act(async () => {
      applyBackdropMotion(false);
    });
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:still");

    await act(async () => {
      applyBackdropMotion(true);
    });
    expect(host.querySelector("iframe")).not.toBeNull();

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:still");
  });

  it("falls back to img when sceneFrameDoc is absent", async () => {
    mockAsset.current = { url: "blob:anim", stillUrl: "blob:still", kind: "scene", mime: "image/svg+xml" };
    const host = await mountScene(sceneTheme(null));
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:anim");
  });
});

describe("BackdropLayer video backdrops", () => {
  function videoTheme(hash = "e".repeat(64), origin: ThemeOrigin | null = null): ThemeSource {
    return {
      ...sourceFromDraft("custom-video", "Video", { canvas: "#1a1b26" }),
      backdrop: { assetHash: hash, kind: "video", mime: "video/mp4", blur: 12 },
      ...(origin !== null ? { origin } : {}),
    };
  }

  function mockMatchMedia(initialMatches: boolean): { setMatches: (next: boolean) => void } {
    let matches = initialMatches;
    const listeners = new Set<EventListenerOrEventListenerObject>();
    window.matchMedia = vi.fn(
      () =>
        ({
          get matches() {
            return matches;
          },
          media: "(prefers-reduced-motion: reduce)",
          onchange: null,
          addEventListener: (_type: string, cb: EventListenerOrEventListenerObject) => {
            listeners.add(cb);
          },
          removeEventListener: (_type: string, cb: EventListenerOrEventListenerObject) => {
            listeners.delete(cb);
          },
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => true,
        }) as unknown as MediaQueryList,
    );
    return {
      setMatches: (next: boolean) => {
        matches = next;
        for (const cb of listeners) {
          if (typeof cb === "function") cb(new Event("change"));
          else cb.handleEvent(new Event("change"));
        }
      },
    };
  }

  it("renders a muted looping playsInline video and plays/pauses across motion, visibility, reduced motion, and origin gates", async () => {
    const media = mockMatchMedia(false);
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    mockAsset.current = { url: "blob:video-1", stillUrl: "blob:video-1", kind: "video", mime: "video/mp4" };

    applyBackdropMotion(true);
    applyTheme(deriveTheme(videoTheme()));
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<BackdropLayer />);
    });

    const video = host.querySelector("video")!;
    expect(video).not.toBeNull();
    expect(video.muted).toBe(true);
    expect(video.defaultMuted).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.getAttribute("preload")).toBe("auto");
    expect(playSpy).toHaveBeenCalled();

    // (a) backdropMotion false pauses; true resumes.
    playSpy.mockClear();
    pauseSpy.mockClear();
    await act(async () => applyBackdropMotion(false));
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).not.toHaveBeenCalled();
    await act(async () => applyBackdropMotion(true));
    expect(playSpy).toHaveBeenCalledTimes(1);

    // (b) document.hidden true pauses; false resumes.
    playSpy.mockClear();
    pauseSpy.mockClear();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).not.toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(playSpy).toHaveBeenCalledTimes(1);

    // (c) prefers-reduced-motion: reduce pauses; clearing resumes.
    playSpy.mockClear();
    pauseSpy.mockClear();
    await act(async () => media.setMatches(true));
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).not.toHaveBeenCalled();
    await act(async () => media.setMatches(false));
    expect(playSpy).toHaveBeenCalledTimes(1);

    // (d) origin.animate === false pauses.
    playSpy.mockClear();
    pauseSpy.mockClear();
    await act(async () => applyTheme(deriveTheme(videoTheme("e".repeat(64), { ...ORIGIN, animate: false }))));
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("gates applyBackdropChrome on loadeddata, clears on error even across motion toggles, and resets on URL swap", async () => {
    mockMatchMedia(false);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    mockAsset.current = { url: "blob:video-a", stillUrl: "blob:video-a", kind: "video", mime: "video/mp4" };

    applyBackdropMotion(true);
    applyTheme(deriveTheme(videoTheme("a".repeat(64))));
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<BackdropLayer />);
    });

    expect(applyBackdropChromeMock.mock.calls.at(-1)?.[1]).toBe(false);

    const firstVideo = host.querySelector("video")!;
    await act(async () => {
      firstVideo.dispatchEvent(new Event("loadeddata"));
    });
    expect(applyBackdropChromeMock.mock.calls.at(-1)?.[1]).toBe(true);

    await act(async () => {
      firstVideo.dispatchEvent(new Event("error"));
    });
    expect(applyBackdropChromeMock.mock.calls.at(-1)?.[1]).toBe(false);

    // Toggling motion after an error must not resurrect readiness.
    await act(async () => applyBackdropMotion(false));
    await act(async () => applyBackdropMotion(true));
    expect(applyBackdropChromeMock.mock.calls.at(-1)?.[1]).toBe(false);

    // Recover on a fresh video URL: readiness stays false until the new element fires loadeddata.
    mockAsset.current = { url: "blob:video-b", stillUrl: "blob:video-b", kind: "video", mime: "video/mp4" };
    await act(async () => applyTheme(deriveTheme(videoTheme("b".repeat(64)))));
    expect(applyBackdropChromeMock.mock.calls.at(-1)?.[1]).toBe(false);
    const secondVideo = host.querySelector("video")!;
    expect(secondVideo).not.toBe(firstVideo);
    await act(async () => {
      secondVideo.dispatchEvent(new Event("loadeddata"));
    });
    expect(applyBackdropChromeMock.mock.calls.at(-1)?.[1]).toBe(true);
  });
});
