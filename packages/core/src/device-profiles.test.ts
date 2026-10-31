import { describe, expect, it } from "vitest";
import {
  DEVICE_PROFILES,
  findDeviceProfileByAvd,
  parseInstalledImages,
  patchAvdConfig,
  pickSystemImagePackage,
  type InstalledSystemImage,
} from "./device-profiles";

const AVD_RE = /^[A-Za-z0-9._-]{1,128}$/;
const STANDARD_BUCKETS = new Set([120, 160, 213, 240, 260, 280, 300, 320, 340, 360, 400, 420, 440, 450, 480, 560, 640]);

describe("DEVICE_PROFILES", () => {
  it("keeps every avd name legal for avdmanager and ids unique", () => {
    const ids = DEVICE_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of DEVICE_PROFILES) {
      expect(p.avd).toMatch(AVD_RE);
      expect(p.width).toBeGreaterThan(0);
      expect(p.height).toBeGreaterThan(0);
      expect(STANDARD_BUCKETS.has(p.density)).toBe(true);
    }
  });

  it("lists the five curated rows in order", () => {
    expect(DEVICE_PROFILES.map((p) => p.id)).toEqual([
      "pixel-11-pro-fold-inner",
      "pixel-11-pro-fold-cover",
      "galaxy-z-fold-8-inner",
      "galaxy-z-fold-8-cover",
      "pixel-11-pro-xl",
    ]);
    expect(DEVICE_PROFILES.every((p) => p.donor === "pixel_10_pro")).toBe(true);
  });

  it("findDeviceProfileByAvd matches by avd dir name only", () => {
    expect(findDeviceProfileByAvd("pixel_11_pro_xl")?.id).toBe("pixel-11-pro-xl");
    expect(findDeviceProfileByAvd("pixel-11-pro-xl")).toBeNull();
    expect(findDeviceProfileByAvd("nope")).toBeNull();
  });
});

describe("patchAvdConfig", () => {
  // Captured from `avdmanager create avd -n probe -k "system-images;android-36;google_apis;x86_64" -d pixel_10_pro`.
  const CAPTURED = [
    "AvdId = probe",
    "avd.ini.displayname = probe",
    "abi.type = x86_64",
    "hw.cpu.arch = x86_64",
    "hw.keyboard=no",
    "hw.ramSize=2048",
    "hw.lcd.width=1080",
    "hw.lcd.height=2400",
    "hw.lcd.density=420",
    "hw.lcd.aspectRatio = 20:9",
    "hw.lcd.size = 6.3",
    "hw.gpu.enabled=yes",
    "tag.id=google_apis",
    "",
  ].join("\n");

  const inner = DEVICE_PROFILES[0]; // pixel_11_pro_fold_inner: 2076x2152 @360

  it("replaces hw.lcd.* in place and forces hw.keyboard=yes", () => {
    const out = patchAvdConfig(CAPTURED, inner);
    expect(out).toContain("hw.lcd.width=2076");
    expect(out).toContain("hw.lcd.height=2152");
    expect(out).toContain("hw.lcd.density=360");
    expect(out).toContain("hw.keyboard=yes");
    expect(out).not.toContain("hw.keyboard=no");
  });

  it("drops hw.lcd.aspectRatio and hw.lcd.size and keeps other lines verbatim", () => {
    const out = patchAvdConfig(CAPTURED, inner);
    expect(out).not.toMatch(/hw\.lcd\.aspectRatio/);
    expect(out).not.toMatch(/hw\.lcd\.size/);
    expect(out).toContain("hw.ramSize=2048");
    expect(out).toContain("AvdId = probe");
    expect(out).toContain("abi.type = x86_64");
    expect(out).toContain("hw.gpu.enabled=yes");
  });

  it("appends hw.lcd.density and hw.keyboard when absent", () => {
    const out = patchAvdConfig("hw.cpu.arch = x86_64\n", inner);
    expect(out.split("\n")).toEqual([
      "hw.cpu.arch = x86_64",
      `hw.lcd.width=${inner.width}`,
      `hw.lcd.height=${inner.height}`,
      `hw.lcd.density=${inner.density}`,
      "hw.keyboard=yes",
      "",
    ]);
  });

  it("preserves CRLF input", () => {
    const out = patchAvdConfig("hw.keyboard=no\r\nhw.ramSize=2048\r\n", inner);
    expect(out.split("\r\n")).toEqual([
      "hw.keyboard=yes",
      "hw.ramSize=2048",
      `hw.lcd.width=${inner.width}`,
      `hw.lcd.height=${inner.height}`,
      `hw.lcd.density=${inner.density}`,
      "",
    ]);
  });
});

describe("parseInstalledImages", () => {
  it("parses android-<n> rows and skips other api dir names", () => {
    const rows: Array<readonly [string, string, string]> = [
      ["android-36", "google_apis", "x86_64"],
      ["default", "foo", "x86_64"],
      ["android-tv", "a", "b"],
      ["android-36.1", "x", "y"],
      ["android-35", "google_apis_playstore", "arm64-v8a"],
    ];
    expect(parseInstalledImages(rows)).toEqual([
      { apiLevel: 36, tag: "google_apis", abi: "x86_64" },
      { apiLevel: 35, tag: "google_apis_playstore", abi: "arm64-v8a" },
    ]);
  });
});

const img = (apiLevel: number, tag: string, abi: string): InstalledSystemImage => ({ apiLevel, tag, abi });

describe("pickSystemImagePackage", () => {
  it("prefers google_apis over default and returns the highest api", () => {
    const images = [img(34, "default", "x86_64"), img(36, "google_apis", "x86_64"), img(35, "default", "x86_64")];
    expect(pickSystemImagePackage(images, "x64")).toBe("system-images;android-36;google_apis;x86_64");
  });

  it("excludes android-tv rows entirely", () => {
    const images = [img(37, "android-tv", "x86_64"), img(34, "default", "x86_64")];
    expect(pickSystemImagePackage(images, "x64")).toBe("system-images;android-34;default;x86_64");
    expect(pickSystemImagePackage([img(37, "android-tv", "x86_64")], "x64")).toBeNull();
  });

  it("falls back to the lexicographically last tag when no google_apis exists", () => {
    const images = [img(35, "default", "x86_64"), img(35, "google_apis_playstore", "x86_64")];
    expect(pickSystemImagePackage(images, "x64")).toBe("system-images;android-35;google_apis_playstore;x86_64");
  });

  it("prefers arm64-v8a on arm64 hosts", () => {
    const images = [img(36, "google_apis", "x86_64"), img(36, "google_apis", "arm64-v8a")];
    expect(pickSystemImagePackage(images, "arm64")).toBe("system-images;android-36;google_apis;arm64-v8a");
  });

  it("accepts x86_64-only images on arm64 (Rosetta decides at run time)", () => {
    const images = [img(36, "google_apis", "x86_64")];
    expect(pickSystemImagePackage(images, "arm64")).toBe("system-images;android-36;google_apis;x86_64");
  });

  it("returns null for empty input", () => {
    expect(pickSystemImagePackage([], "x64")).toBeNull();
    expect(pickSystemImagePackage([], "arm64")).toBeNull();
  });
});
