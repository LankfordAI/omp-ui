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

const mockAsset = {
  current: { url: "blob:anim", stillUrl: "blob:still", kind: "scene", mime: "image/svg+xml" } as {
    url: string;
    stillUrl: string;
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
  mockAsset.current = { url: "blob:anim", stillUrl: "blob:still", kind: "scene", mime: "image/svg+xml" };
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
