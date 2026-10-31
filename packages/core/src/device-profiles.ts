/**
 * Curated Android device profiles for the device pane's AVD picker.
 *
 * Panel specs are from Google/Samsung Aug/Jul 2026 announcements; `density` is the nearest standard Android
 * bucket to the true ppi. The `-d` donor is what keeps `avdmanager create avd` non-interactive — without it
 * avdmanager blocks on the custom-hardware-profile prompt for devices it doesn't bundle. When an SDK update
 * ships real `pixel_11_pro_fold`/`pixel_11_pro_xl` bundled device ids, switch those three rows to the bundled
 * ids with empty geometry patches and keep only the Samsung rows custom.
 *
 * Zero imports by design: the renderer reaches this via the @omp-ui/core/device-pane subpath, which must
 * stay free of node: builtins (see browser-safe-exports.test.ts).
 */

export interface DeviceProfile {
  readonly id: string;
  readonly name: string;
  /** AVD dir name; satisfies DEVICE_AVD_PATTERN. */
  readonly avd: string;
  /** Bundled avdmanager device id passed to `-d`. */
  readonly donor: string;
  readonly width: number;
  readonly height: number;
  /** dpi */
  readonly density: number;
}

export const DEVICE_PROFILES: readonly DeviceProfile[] = [
  {
    id: "pixel-11-pro-fold-inner",
    name: "Pixel 11 Pro Fold — inner",
    avd: "pixel_11_pro_fold_inner",
    donor: "pixel_10_pro",
    width: 2076,
    height: 2152,
    density: 360,
  },
  {
    id: "pixel-11-pro-fold-cover",
    name: "Pixel 11 Pro Fold — outer",
    avd: "pixel_11_pro_fold_cover",
    donor: "pixel_10_pro",
    width: 1080,
    height: 2342,
    density: 400,
  },
  {
    id: "galaxy-z-fold-8-inner",
    name: "Galaxy Z Fold 8 — inner",
    avd: "galaxy_z_fold_8_inner",
    donor: "pixel_10_pro",
    width: 1848,
    height: 2448,
    density: 400,
  },
  {
    id: "galaxy-z-fold-8-cover",
    name: "Galaxy Z Fold 8 — outer",
    avd: "galaxy_z_fold_8_cover",
    donor: "pixel_10_pro",
    width: 1248,
    height: 1972,
    density: 420,
  },
  {
    id: "pixel-11-pro-xl",
    name: "Pixel 11 Pro XL",
    avd: "pixel_11_pro_xl",
    donor: "pixel_10_pro",
    width: 1344,
    height: 2992,
    density: 480,
  },
];

export function findDeviceProfileByAvd(avd: string): DeviceProfile | null {
  return DEVICE_PROFILES.find((p) => p.avd === avd) ?? null;
}

/**
 * Retargets an avdmanager-generated config.ini to the profile's panel: hw.lcd.{width,height,density} set in
 * place (appended when absent), hw.lcd.aspectRatio/hw.lcd.size dropped, and hw.keyboard forced to `yes` —
 * avdmanager writes `no`, which silently drops every key/text/Back/Home/Recents press. Other lines verbatim;
 * CRLF input keeps CRLF.
 */
export function patchAvdConfig(text: string, p: DeviceProfile): string {
  const crlf = text.includes("\r\n");
  const eol = crlf ? "\r\n" : "\n";
  const lines = (crlf ? text.replace(/\r\n/g, "\n") : text).split("\n");
  const drops: Record<string, true> = { "hw.lcd.aspectRatio": true, "hw.lcd.size": true };
  const sets: Record<string, string> = {
    "hw.lcd.width": String(p.width),
    "hw.lcd.height": String(p.height),
    "hw.lcd.density": String(p.density),
    "hw.keyboard": "yes",
  };
  const out: string[] = [];
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      const key = line.slice(0, eq).trim();
      if (drops[key]) continue;
      if (key in sets) {
        out.push(`${key}=${sets[key]}`);
        delete sets[key];
        continue;
      }
    }
    out.push(line);
  }
  const appended = Object.entries(sets).map(([key, value]) => `${key}=${value}`);
  const tail: string[] = [];
  while (appended.length > 0 && out.length > 0 && out[out.length - 1] === "") tail.unshift(out.pop() as string);
  out.push(...appended, ...tail);
  return out.join(eol);
}

export interface InstalledSystemImage {
  readonly apiLevel: number;
  readonly tag: string;
  readonly abi: string;
}

/**
 * Rows of `[apiDir, tag, abi]` SDK system-image directory names; rows whose apiDir is not `android-<digits>`
 * (e.g. a stray `default` folder) are skipped.
 */
export function parseInstalledImages(rows: Iterable<readonly [string, string, string]>): InstalledSystemImage[] {
  const out: InstalledSystemImage[] = [];
  for (const [apiDir, tag, abi] of rows) {
    const m = /^android-(\d+)$/.exec(apiDir);
    if (!m || !tag || !abi) continue;
    out.push({ apiLevel: Number(m[1]), tag, abi });
  }
  return out;
}

/**
 * Best `system-images;<api>;<tag>;<abi>` package id for a host arch (`process.arch` as a plain string);
 * null when no image qualifies. Tags: android-tv excluded, google_apis preferred, otherwise the
 * lexicographically last remaining tag; then the highest apiLevel among surviving rows.
 */
export function pickSystemImagePackage(images: readonly InstalledSystemImage[], arch: string): string | null {
  const wantedAbi = arch === "arm64" ? "arm64-v8a" : "x86_64";
  // On Apple silicon with only x86_64 images, the emulator's Rosetta support decides.
  const otherAbi = wantedAbi === "arm64-v8a" ? "x86_64" : "arm64-v8a";
  const tagged = images.filter((i) => i.tag !== "android-tv");
  let tags = [...new Set(tagged.map((i) => i.tag))];
  if (tags.includes("google_apis")) tags = ["google_apis"];
  else if (tags.length > 1) tags = [tags.reduce((a, b) => (b > a ? b : a))];
  const abiOk = (abi: string) => abi === wantedAbi || abi === otherAbi;
  let rows = tagged.filter((i) => tags.includes(i.tag) && abiOk(i.abi));
  if (rows.length === 0) return null;
  const preferred = rows.filter((i) => i.abi === wantedAbi);
  if (preferred.length > 0) rows = preferred;
  const best = rows.reduce((a, b) => (b.apiLevel > a.apiLevel ? b : a));
  return `system-images;android-${best.apiLevel};${best.tag};${best.abi}`;
}
