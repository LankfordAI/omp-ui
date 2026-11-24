import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGnomeSoundGate } from "./gnome-sound-gate";

describe("createGnomeSoundGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows playback off Linux without touching gsettings", async () => {
    const exec = vi.fn(async (): Promise<string> => "boolean true\n");
    const gate = createGnomeSoundGate({ platform: "darwin", execGsettings: exec });
    expect(await gate()).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("allows when both switches read true and denies on either false", async () => {
    let banners = "boolean true\n";
    let alerts = "boolean true\n";
    const exec = vi.fn(async (args: string[]): Promise<string> =>
      args[2] === "show-banners" ? banners : alerts,
    );
    const gate = createGnomeSoundGate({ platform: "linux", execGsettings: exec });
    expect(await gate()).toBe(true);

    // Fresh instances (fresh cache): DND off denies.
    banners = "boolean false\n";
    expect(await createGnomeSoundGate({ platform: "linux", execGsettings: exec })()).toBe(false);
    // Per-app sound mute denies.
    banners = "boolean true\n";
    alerts = "boolean false\n";
    expect(await createGnomeSoundGate({ platform: "linux", execGsettings: exec })()).toBe(false);
  });

  it("checks the per-app path for ai-lankford-omp-ui", async () => {
    const seen: string[][] = [];
    const exec = vi.fn(async (args: string[]): Promise<string> => {
      seen.push(args);
      return "boolean true\n";
    });
    await createGnomeSoundGate({ platform: "linux", execGsettings: exec })();
    expect(seen[1]).toEqual([
      "get",
      "org.gnome.desktop.notifications.application:/org/gnome/desktop/notifications/application/ai-lankford-omp-ui/",
      "enable-sound-alerts",
    ]);
  });

  it("allows when gsettings is missing or errors", async () => {
    const gate = createGnomeSoundGate({ platform: "linux", execGsettings: async () => { throw new Error("ENOENT"); } });
    expect(await gate()).toBe(true);
  });

  it("caches briefly and shares one in-flight check", async () => {
    let releases: Array<() => void> = [];
    const exec = vi.fn(
      () => new Promise<string>((resolve) => {
        releases.push(() => resolve("boolean true\n"));
      }),
    );
    // Resolving one key queues the next key's call: drain until quiet.
    const drain = async (): Promise<void> => {
      while (releases.length > 0) {
        const batch = releases;
        releases = [];
        for (const release of batch) release();
        await Promise.resolve();
      }
    };
    const gate = createGnomeSoundGate({ platform: "linux", execGsettings: exec });
    const a = gate();
    const b = gate();
    // One shared in-flight check: only the first key has been asked for.
    expect(exec).toHaveBeenCalledTimes(1);
    await Promise.all([drain(), a, b]);
    // Two gsettings keys, one check.
    expect(exec).toHaveBeenCalledTimes(2);

    // Cached: a third call adds no process until the TTL passes.
    await gate();
    expect(exec).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5_001);
    const c = gate();
    await Promise.all([drain(), c]);
    expect(exec).toHaveBeenCalledTimes(4);
  });
});
