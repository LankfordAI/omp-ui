import type { DeviceProfileOffer, DeviceSystemImage } from "./device-pane";

interface NativeDeviceProfile {
  id: string;
  name: string;
  family: DeviceProfileOffer["family"];
  minApi: number;
}

/** Native SDK hardware definitions only; panel and hinge geometry remain SDK-owned. */
const NATIVE_DEVICE_PROFILES: readonly NativeDeviceProfile[] = [
  { id: "small_phone", name: "Small Phone", family: "phone", minApi: 24 },
  { id: "medium_phone", name: "Medium Phone", family: "phone", minApi: 24 },
  { id: "pixel_9", name: "Pixel 9", family: "phone", minApi: 35 },
  { id: "pixel_9_pro_xl", name: "Pixel 9 Pro XL", family: "phone", minApi: 35 },
  { id: "small_tablet", name: "Small Tablet", family: "tablet", minApi: 24 },
  { id: "medium_tablet", name: "Medium Tablet", family: "tablet", minApi: 24 },
  { id: "pixel_tablet", name: "Pixel Tablet", family: "tablet", minApi: 33 },
  { id: "pixel_fold", name: "Pixel Fold", family: "book", minApi: 34 },
  { id: "pixel_9_pro_fold", name: "Pixel 9 Pro Fold", family: "book", minApi: 35 },
  { id: "7.6in Foldable", name: "7.6-inch Foldable", family: "book", minApi: 34 },
  { id: "6.7in Foldable", name: "6.7-inch Foldable", family: "flip", minApi: 30 },
  { id: "8in Foldable", name: "8-inch Foldable", family: "fold-out", minApi: 34 },
];

const IMAGE_TAG_PRIORITY: Record<DeviceSystemImage["tag"], number> = {
  google_apis: 0,
  google_apis_playstore: 1,
  default: 2,
};
const REQUIRED_IMAGE_FILES = ["system.img", "vendor.img", "ramdisk.img", "kernel-ranchu"] as const;
// Android 7.x SDK packaging predates split vendor images:
// https://raw.githubusercontent.com/aosp-mirror/platform_development/android-7.1.2_r39/build/sdk.atree
const REQUIRED_PRE_TREBLE_IMAGE_FILES = ["system.img", "userdata.img", "ramdisk.img", "kernel-ranchu"] as const;

export function isNativeDeviceProfile(profileId: string): boolean {
  return NATIVE_DEVICE_PROFILES.some((profile) => profile.id === profileId);
}

/** `avdmanager list device` IDs, not names or numeric aliases. IDs may contain spaces. */
export function parseSdkDevices(stdout: string): Set<string> {
  const ids = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*id:\s*\d+\s+or\s+"([^"\r\n]+)"\s*$/.exec(line);
    if (match) ids.add(match[1]);
  }
  return ids;
}

/** Native guests only: unsupported host architectures never fall back to a different ABI. */
export function nativeAndroidAbi(arch: string): DeviceSystemImage["abi"] | null {
  if (arch === "x64") return "x86_64";
  if (arch === "arm64") return "arm64-v8a";
  return null;
}

/** Package API and SDK extension are independent; preserve the caller's exact package ID. */
export function parseDeviceSystemImagePackage(packageId: string): {
  api: number;
  extension: number | null;
  tag: DeviceSystemImage["tag"];
  abi: DeviceSystemImage["abi"];
} | null {
  const match = /^system-images;android-([1-9]\d*)(?:-ext([1-9]\d*))?;(default|google_apis|google_apis_playstore);(x86_64|arm64-v8a)$/.exec(packageId);
  if (!match || match[0] !== packageId) return null;
  const api = Number(match[1]);
  const extension = match[2] === undefined ? null : Number(match[2]);
  if (!Number.isSafeInteger(api) || (extension !== null && !Number.isSafeInteger(extension))) return null;
  return {
    api,
    extension,
    tag: match[3] as DeviceSystemImage["tag"],
    abi: match[4] as DeviceSystemImage["abi"],
  };
}

/** A complete installed mobile image with matching package and source.properties identities. */
export function parseInstalledSystemImage(
  packageId: string,
  sourceProperties: string,
  files: readonly string[],
  arch: string,
): DeviceSystemImage | null {
  const parsed = parseDeviceSystemImagePackage(packageId);
  if (!parsed || parsed.abi !== nativeAndroidAbi(arch)) return null;
  const { api, extension, tag, abi } = parsed;
  const requiredFiles = api < 26 ? REQUIRED_PRE_TREBLE_IMAGE_FILES : REQUIRED_IMAGE_FILES;
  if (!requiredFiles.every((file) => files.includes(file))) return null;
  const properties = new Map<string, string>();
  for (const raw of sourceProperties.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) properties.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  if (
    properties.get("AndroidVersion.ApiLevel") !== String(api) ||
    properties.get("SystemImage.TagId") !== tag ||
    properties.get("SystemImage.Abi") !== abi
  ) {
    return null;
  }
  const codeName = properties.get("AndroidVersion.CodeName");
  if (codeName !== undefined && codeName !== "REL") return null;
  const baseSdk = properties.get("AndroidVersion.IsBaseSdk");
  if (extension !== null) {
    if (properties.get("AndroidVersion.ExtensionLevel") !== String(extension) || baseSdk !== "false") return null;
  } else if (baseSdk !== undefined && baseSdk !== "true") return null;
  const declaredPath = properties.get("Pkg.Path");
  if (declaredPath !== undefined && declaredPath !== packageId) return null;
  const tagLabel = tag === "google_apis" ? "Google APIs" : tag === "google_apis_playstore" ? "Google Play" : "Android";
  const extensionLabel = extension === null ? "" : ` · Extension ${extension}`;
  return { packageId, api, tag, abi, label: `API ${api}${extensionLabel} · ${tagLabel} · ${abi}` };
}

function compareImages(a: DeviceSystemImage, b: DeviceSystemImage): number {
  return b.api - a.api || IMAGE_TAG_PRIORITY[a.tag] - IMAGE_TAG_PRIORITY[b.tag] ||
    (a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : 0);
}

/** A unique legal default; the SDK profile ID itself is never validated as an AVD name. */
export function proposeAvdName(profileId: string, api: number, existingAvds: readonly string[]): string {
  const normalized = profileId.replace(/[^A-Za-z0-9._-]+/g, "_");
  const base = `omp_ui_${normalized}_api${api}`.slice(0, 128);
  const occupied = new Set(existingAvds.map((avd) => avd.toLowerCase()));
  let proposed = base;
  for (let suffix = 2; occupied.has(proposed.toLowerCase()); suffix++) {
    const tail = `_${suffix}`;
    proposed = `${base.slice(0, 128 - tail.length)}${tail}`;
  }
  return proposed;
}

/** Local SDK membership and complete native images determine each visible creation offer. */
export function createProfileOffers(
  sdkDeviceIds: ReadonlySet<string>,
  images: DeviceSystemImage[],
  existingAvds: readonly string[],
  creationReason: string | null,
): DeviceProfileOffer[] {
  const seen = new Set<string>();
  const sortedImages = images.filter((image) => {
    if (seen.has(image.packageId)) return false;
    seen.add(image.packageId);
    return true;
  }).sort(compareImages);
  return NATIVE_DEVICE_PROFILES.map((profile) => {
    const compatible = sortedImages.filter((image) => image.api >= profile.minApi);
    const reason = creationReason ?? (
      !sdkDeviceIds.has(profile.id)
        ? `The owner Android SDK does not include native device profile "${profile.id}".`
        : compatible.length === 0
          ? `No compatible installed system image is available (API ${profile.minApi} or newer required).`
          : null
    );
    return {
      ...profile,
      available: reason === null,
      reason,
      images: compatible,
      defaultImagePackage: compatible[0]?.packageId ?? null,
      proposedAvd: proposeAvdName(profile.id, compatible[0]?.api ?? profile.minApi, existingAvds),
    };
  });
}

/** Change only the keyboard setting on a newly-created AVD; native display/hinge keys are immutable. */
export function patchAvdKeyboard(config: string): string {
  let found = false;
  const patched = config.replace(/^([ \t]*hw\.keyboard[ \t]*=[ \t]*)[^\r\n]*/gm, (_line, prefix: string) => {
    found = true;
    return `${prefix}yes`;
  });
  if (found) return patched;
  const eol = config.includes("\r\n") ? "\r\n" : "\n";
  const trailing = /(?:\r\n|\n)+$/.exec(config)?.[0] ?? "";
  const body = config.slice(0, config.length - trailing.length);
  return `${body}${body ? eol : ""}hw.keyboard=yes${trailing}`;
}

/** Presentation only: these old static layouts are not native creation recipes or posture capabilities. */
export function legacyDevicePresentation(avd: string): { friendlyName: string; layoutReference: string } | null {
  switch (avd) {
    case "pixel_11_pro_fold_inner":
      return { friendlyName: "Pixel 11 Pro Fold — inner", layoutReference: "Legacy static inner layout" };
    case "pixel_11_pro_fold_cover":
      return { friendlyName: "Pixel 11 Pro Fold — outer", layoutReference: "Legacy static outer layout" };
    case "galaxy_z_fold_8_inner":
      return { friendlyName: "Galaxy Z Fold 8 — inner", layoutReference: "Legacy static inner layout" };
    case "galaxy_z_fold_8_cover":
      return { friendlyName: "Galaxy Z Fold 8 — outer", layoutReference: "Legacy static outer layout" };
    case "pixel_11_pro_xl":
      return { friendlyName: "Pixel 11 Pro XL", layoutReference: "Legacy custom phone layout" };
    default:
      return null;
  }
}
