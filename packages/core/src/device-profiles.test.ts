import { describe, expect, it } from "vitest";
import type { DeviceSystemImage } from "./device-pane";
import {
  createProfileOffers,
  isNativeDeviceProfile,
  legacyDevicePresentation,
  nativeAndroidAbi,
  parseDeviceSystemImagePackage,
  parseInstalledSystemImage,
  parseSdkDevices,
  patchAvdKeyboard,
  proposeAvdName,
} from "./device-profiles";

const IMAGE_FILES = ["system.img", "vendor.img", "ramdisk.img", "kernel-ranchu"];
const PRE_TREBLE_IMAGE_FILES = ["system.img", "userdata.img", "ramdisk.img", "kernel-ranchu"];
const packageFor = (api: number, tag = "google_apis", abi = "x86_64") => `system-images;android-${api};${tag};${abi}`;
const propertiesFor = (api: number, tag = "google_apis", abi = "x86_64") => [
  `AndroidVersion.ApiLevel=${api}`,
  `SystemImage.TagId=${tag}`,
  `SystemImage.Abi=${abi}`,
  "AndroidVersion.ExtensionLevel=13",
  "AndroidVersion.IsBaseSdk=true",
].join("\n");
const image = (api: number, tag: DeviceSystemImage["tag"] = "google_apis"): DeviceSystemImage => ({
  packageId: packageFor(api, tag), api, tag, abi: "x86_64", label: `API ${api} ${tag}`,
});

const nativeRecipes = [
  { id: "small_phone", minApi: 24, family: "phone" },
  { id: "medium_phone", minApi: 24, family: "phone" },
  { id: "pixel_9", minApi: 35, family: "phone" },
  { id: "pixel_9_pro_xl", minApi: 35, family: "phone" },
  { id: "small_tablet", minApi: 24, family: "tablet" },
  { id: "medium_tablet", minApi: 24, family: "tablet" },
  { id: "pixel_tablet", minApi: 33, family: "tablet" },
  { id: "pixel_fold", minApi: 34, family: "book" },
  { id: "pixel_9_pro_fold", minApi: 35, family: "book" },
  { id: "7.6in Foldable", minApi: 34, family: "book" },
  { id: "6.7in Foldable", minApi: 30, family: "flip" },
  { id: "8in Foldable", minApi: 34, family: "fold-out" },
];

function offerFor(id: string, images: DeviceSystemImage[], ids: ReadonlySet<string> = new Set([id]), reason: string | null = null) {
  const offer = createProfileOffers(ids, images, [], reason).find((row) => row.id === id);
  if (!offer) throw new Error(`Missing offer for ${id}`);
  return offer;
}

describe("native device membership", () => {
  it("parses real SDK IDs, including IDs with spaces, without using numeric aliases or display names", () => {
    const stdout = [
      "Available Android Virtual Devices:",
      'id: 4 or "pixel_fold"',
      "    Name: Pixel Fold",
      'id: 5 or "7.6in Foldable"',
      'id: 6 or "7.6in Foldable"',
      'INFO | id: 7 or "not-a-device"',
      "---------",
    ].join("\r\n");
    expect(parseSdkDevices(stdout)).toEqual(new Set(["pixel_fold", "7.6in Foldable"]));
    expect(parseSdkDevices("failed to load devices")).toEqual(new Set());
  });

  it.each(nativeRecipes)("offers $id only as its native SDK definition with its API floor", ({ id, minApi, family }) => {
    expect(isNativeDeviceProfile(id)).toBe(true);
    const eligible = image(minApi);
    const tooOld = image(minApi - 1);
    const offer = offerFor(id, [tooOld, eligible]);
    expect(offer).toMatchObject({ id, minApi, family, available: true, reason: null, defaultImagePackage: eligible.packageId });
    expect(offer.images).toEqual([eligible]);
    expect(offer.proposedAvd).toBe(proposeAvdName(id, minApi, []));
    const noCompatibleImage = offerFor(id, [tooOld]);
    expect(noCompatibleImage.available).toBe(false);
    expect(noCompatibleImage.defaultImagePackage).toBeNull();
    expect(noCompatibleImage.reason).toContain(`API ${minApi}`);
  });

  it("does not substitute a donor or recognize legacy/custom names as native recipes", () => {
    expect(isNativeDeviceProfile("pixel-11-pro-fold-inner")).toBe(false);
    expect(isNativeDeviceProfile("pixel_11_pro_fold_inner")).toBe(false);
    expect(isNativeDeviceProfile("7.6in_Foldable")).toBe(false);
    expect(isNativeDeviceProfile("pixel_fold;echo nope")).toBe(false);
    const offer = offerFor("pixel_9", [image(35)], new Set(["pixel_10_pro"]));
    expect(offer.available).toBe(false);
    expect(offer.reason).toContain('"pixel_9"');
    expect(offer.images).toEqual([image(35)]);
  });

  it("keeps unavailable profiles visible with the owner setup reason", () => {
    const reason = "Install Android SDK Command-line Tools on the owner machine.";
    const offer = offerFor("pixel_fold", [image(35)], new Set(["pixel_fold"]), reason);
    expect(offer.available).toBe(false);
    expect(offer.reason).toBe(reason);
    expect(offer.images).toEqual([image(35)]);
  });
});

describe("parseDeviceSystemImagePackage", () => {
  it.each(["default", "google_apis", "google_apis_playstore"])("parses base and extension %s packages for both native ABIs", (tag) => {
    for (const abi of ["x86_64", "arm64-v8a"]) {
      expect(parseDeviceSystemImagePackage(packageFor(35, tag, abi))).toEqual({ api: 35, extension: null, tag, abi });
      expect(parseDeviceSystemImagePackage(`system-images;android-34-ext12;${tag};${abi}`)).toEqual({ api: 34, extension: 12, tag, abi });
    }
  });

  it.each([
    "android-0", "android-035", "android-35.1", "android-Baklava", "android-9007199254740992",
    "android-35-ext0", "android-35-ext01", "android-35-ext-1", "android-35-ext9007199254740992",
  ])("rejects invalid platform or extension component %s", (platform) => {
    expect(parseDeviceSystemImagePackage(`system-images;${platform};google_apis;x86_64`)).toBeNull();
  });

  it.each([
    "system-images;android-35;android-tv;x86_64",
    "system-images;android-35;google_apis;x86",
    "system-images;android-35-ext12;google_apis;armeabi-v7a",
    "system-images;android-35;google_apis;x86_64\n",
    "system-images;android-35-ext12;google_apis;x86_64;extra",
  ])("requires the whole supported mobile package grammar: %s", (packageId) => {
    expect(parseDeviceSystemImagePackage(packageId)).toBeNull();
  });
});

describe("parseInstalledSystemImage", () => {
  it.each(["default", "google_apis", "google_apis_playstore"])("accepts complete installed %s mobile images", (tag) => {
    const packageId = packageFor(35, tag);
    expect(parseInstalledSystemImage(packageId, propertiesFor(35, tag), IMAGE_FILES, "x64")).toMatchObject({
      packageId, api: 35, tag, abi: "x86_64",
    });
  });

  it.each([
    [34, 12, "google_apis_playstore", "x86_64", "x64"],
    [35, 15, "google_apis", "arm64-v8a", "arm64"],
    [34, 99, "default", "x86_64", "x64"],
  ] as const)("accepts stable API %i extension %i independently of platform API", (api, extension, tag, abi, arch) => {
    const packageId = `system-images;android-${api}-ext${extension};${tag};${abi}`;
    const properties = `${propertiesFor(api, tag, abi)}\nAndroidVersion.ExtensionLevel=${extension}\nAndroidVersion.IsBaseSdk=false\nAndroidVersion.CodeName=REL\nPkg.Path=${packageId}`;
    const parsed = parseInstalledSystemImage(packageId, properties, IMAGE_FILES, arch);
    expect(parsed).toMatchObject({ packageId, api, tag, abi });
    expect(parsed?.label).toContain(`API ${api} · Extension ${extension}`);
    expect(parsed?.label).not.toContain(`${api}.${extension}`);
    expect(parseInstalledSystemImage(packageId, properties.replace("\nAndroidVersion.CodeName=REL", ""), IMAGE_FILES, arch)).toEqual(parsed);
    expect(parseInstalledSystemImage(packageId, properties, IMAGE_FILES, arch === "x64" ? "arm64" : "x64")).toBeNull();
    for (const missing of IMAGE_FILES) {
      expect(parseInstalledSystemImage(packageId, properties, IMAGE_FILES.filter((file) => file !== missing), arch)).toBeNull();
    }
    if (!parsed) throw new Error("Missing valid extension image fixture");
    expect(offerFor("pixel_fold", [parsed]).images).toEqual([parsed]);
    expect(offerFor("pixel_9", [parsed]).images).toEqual(api >= 35 ? [parsed] : []);
  });

  it("rejects extension identity mismatches, missing metadata, and previews even on the stable channel", () => {
    const packageId = "system-images;android-34-ext12;google_apis_playstore;x86_64";
    const identity = "AndroidVersion.ApiLevel=34\nSystemImage.TagId=google_apis_playstore\nSystemImage.Abi=x86_64";
    const metadata = "\nAndroidVersion.ExtensionLevel=12\nAndroidVersion.IsBaseSdk=false";
    for (const properties of [
      identity,
      `${identity}\nAndroidVersion.IsBaseSdk=false`,
      `${identity}\nAndroidVersion.ExtensionLevel=12`,
      `${identity}${metadata}\nAndroidVersion.ExtensionLevel=13`,
      `${identity}${metadata}\nAndroidVersion.ExtensionLevel=012`,
      `${identity}${metadata}\nAndroidVersion.IsBaseSdk=true`,
      `${identity}${metadata}\nAndroidVersion.ApiLevel=34x`,
      `${identity}${metadata}\nAndroidVersion.ApiLevel=35`,
      `${identity}${metadata}\nSystemImage.TagId=google_apis`,
      `${identity}${metadata}\nSystemImage.Abi=arm64-v8a`,
      `${identity}${metadata}\nPkg.Path=${packageFor(34, "google_apis_playstore")}`,
      `${identity}${metadata}\nAndroidVersion.CodeName=CANARY\nPkg.Channel=channel-0`,
      `${identity}${metadata}\nAndroidVersion.CodeName=\nPkg.Channel=channel-0`,
    ]) {
      expect(parseInstalledSystemImage(packageId, properties, IMAGE_FILES, "x64")).toBeNull();
    }
  });

  it.each([24, 25])("accepts complete pre-Treble API %i images without vendor.img only for their native host", (api) => {
    for (const tag of ["default", "google_apis", "google_apis_playstore"]) {
      for (const [arch, abi, oppositeArch] of [["x64", "x86_64", "arm64"], ["arm64", "arm64-v8a", "x64"]]) {
        const packageId = packageFor(api, tag, abi);
        const properties = propertiesFor(api, tag, abi);
        expect(parseInstalledSystemImage(packageId, properties, PRE_TREBLE_IMAGE_FILES, arch)).toMatchObject({
          packageId, api, tag, abi,
        });
        expect(parseInstalledSystemImage(packageId, properties, PRE_TREBLE_IMAGE_FILES, oppositeArch)).toBeNull();
      }
    }
  });

  it.each([24, 25])("rejects incomplete pre-Treble API %i images and mismatched source properties", (api) => {
    const packageId = packageFor(api);
    const properties = propertiesFor(api);
    for (const missing of PRE_TREBLE_IMAGE_FILES) {
      expect(parseInstalledSystemImage(packageId, properties, PRE_TREBLE_IMAGE_FILES.filter((name) => name !== missing), "x64")).toBeNull();
    }
    expect(parseInstalledSystemImage(packageId, properties, PRE_TREBLE_IMAGE_FILES.map((name) => `subdir/${name}`), "x64")).toBeNull();
    for (const mismatched of [
      propertiesFor(api + 1),
      propertiesFor(api, "default"),
      propertiesFor(api, "google_apis", "arm64-v8a"),
      `${properties}\nAndroidVersion.CodeName=Preview`,
      `${properties}\nAndroidVersion.IsBaseSdk=false`,
      `${properties}\nPkg.Path=${packageFor(api + 1)}`,
    ]) {
      expect(parseInstalledSystemImage(packageId, mismatched, PRE_TREBLE_IMAGE_FILES, "x64")).toBeNull();
    }
  });

  it.each([26, 35])("requires vendor.img for split-vendor API %i images", (api) => {
    expect(parseInstalledSystemImage(packageFor(api), propertiesFor(api), PRE_TREBLE_IMAGE_FILES, "x64")).toBeNull();
  });

  it("accepts only the host-native ABI and refuses unsupported host architectures", () => {
    expect(nativeAndroidAbi("x64")).toBe("x86_64");
    expect(nativeAndroidAbi("arm64")).toBe("arm64-v8a");
    expect(nativeAndroidAbi("ia32")).toBeNull();
    expect(parseInstalledSystemImage(packageFor(35), propertiesFor(35), IMAGE_FILES, "arm64")).toBeNull();
    expect(parseInstalledSystemImage(packageFor(35, "google_apis", "arm64-v8a"), propertiesFor(35, "google_apis", "arm64-v8a"), IMAGE_FILES, "x64")).toBeNull();
    expect(parseInstalledSystemImage(packageFor(35), propertiesFor(35), IMAGE_FILES, "ia32")).toBeNull();
    expect(parseInstalledSystemImage(packageFor(35, "google_apis", "arm64-v8a"), propertiesFor(35, "google_apis", "arm64-v8a"), IMAGE_FILES, "arm64")).toMatchObject({ abi: "arm64-v8a" });
  });

  it.each(IMAGE_FILES)("rejects incomplete installations missing %s", (missing) => {
    expect(parseInstalledSystemImage(packageFor(35), propertiesFor(35), IMAGE_FILES.filter((name) => name !== missing), "x64")).toBeNull();
    expect(parseInstalledSystemImage(packageFor(35), propertiesFor(35), IMAGE_FILES.map((name) => `subdir/${name}`), "x64")).toBeNull();
  });

  it.each([
    "system-images;android-35-ext14;google_apis;x86_64",
    "system-images;android-36.1;google_apis;x86_64",
    "system-images;android-Baklava;google_apis;x86_64",
    "system-images;android-035;google_apis;x86_64",
    "system-images;android-35;android-tv;x86_64",
    "system-images;android-35;android-wear;x86_64",
    "system-images;android-35;automotive;x86_64",
    "system-images;android-35;google_apis;x86",
    "system-images;android-35;google_apis;armeabi-v7a",
  ])("rejects non-stable/non-mobile/non-native package %s", (packageId) => {
    expect(parseInstalledSystemImage(packageId, propertiesFor(35), IMAGE_FILES, "x64")).toBeNull();
  });

  it.each([
    propertiesFor(34),
    propertiesFor(35, "default"),
    propertiesFor(35, "google_apis", "arm64-v8a"),
    "SystemImage.TagId=google_apis\nSystemImage.Abi=x86_64",
    "AndroidVersion.ApiLevel=35\nSystemImage.Abi=x86_64",
    "AndroidVersion.ApiLevel=35\nSystemImage.TagId=google_apis",
    `${propertiesFor(35)}\nAndroidVersion.CodeName=Baklava`,
    `${propertiesFor(35)}\nAndroidVersion.IsBaseSdk=false`,
    `${propertiesFor(35)}\nPkg.Path=${packageFor(34)}`,
    "",
  ])("requires matching stable source properties %#", (properties) => {
    expect(parseInstalledSystemImage(packageFor(35), properties, IMAGE_FILES, "x64")).toBeNull();
  });

  it("retains the exact installed package and accepts stable base SDK extension metadata", () => {
    const packageId = packageFor(35, "google_apis_playstore");
    const properties = `# image metadata\r\n${propertiesFor(35, "google_apis_playstore").replace(/\n/g, "\r\n")}\r\nAndroidVersion.CodeName = REL\r\nPkg.Path = ${packageId}\r\n`;
    const parsed = parseInstalledSystemImage(packageId, properties, IMAGE_FILES, "x64");
    expect(parsed?.packageId).toBe(packageId);
    expect(parsed?.label).toContain("35");
    expect(parsed?.label).toContain("Google Play");
  });
});

describe("image selection", () => {
  it("keeps extension images eligible without promoting their extension level above API or tag", () => {
    const extensionPackage = "system-images;android-34-ext99;google_apis_playstore;x86_64";
    const extension = parseInstalledSystemImage(extensionPackage,
      `${propertiesFor(34, "google_apis_playstore")}\nAndroidVersion.ExtensionLevel=99\nAndroidVersion.IsBaseSdk=false`, IMAGE_FILES, "x64");
    if (!extension) throw new Error("Missing valid extension image fixture");
    const images = [extension, image(35, "default"), image(34)];
    const offer = offerFor("pixel_fold", images);
    expect(offer.images.map((row) => row.packageId)).toEqual([packageFor(35, "default"), packageFor(34), extensionPackage]);
    expect(offer.defaultImagePackage).toBe(packageFor(35, "default"));
    expect(offerFor("pixel_fold", [extension, image(34)]).defaultImagePackage).toBe(packageFor(34));
    expect(offerFor("pixel_9", [extension]).available).toBe(false);
    expect(offerFor("pixel_9", [extension]).images).toEqual([]);
    expect(offerFor("pixel_fold", [...images].reverse()).images).toEqual(offer.images);
  });

  it.each([24, 25])("offers installed vendor-free API %i images only to profiles meeting their API floor", (api) => {
    const parsed = parseInstalledSystemImage(packageFor(api), propertiesFor(api), PRE_TREBLE_IMAGE_FILES, "x64");
    if (!parsed) throw new Error(`Missing valid API ${api} image fixture`);
    for (const { id, minApi } of nativeRecipes) {
      const offer = offerFor(id, [parsed]);
      const compatible = api >= minApi;
      expect(offer.available).toBe(compatible);
      expect(offer.images).toEqual(compatible ? [parsed] : []);
      expect(offer.defaultImagePackage).toBe(compatible ? parsed.packageId : null);
    }
  });

  it("keeps all compatible mobile images and sorts numeric API before tag preference", () => {
    const images = [image(35), image(24), image(36, "default"), image(9), image(25), image(35, "default"), image(35, "google_apis_playstore"), image(100)];
    const original = [...images];
    const selected = offerFor("small_phone", images);
    expect(selected.images.map((row) => row.packageId)).toEqual([
      packageFor(100), packageFor(36, "default"), packageFor(35), packageFor(35, "google_apis_playstore"), packageFor(35, "default"),
      packageFor(25), packageFor(24),
    ]);
    expect(selected.defaultImagePackage).toBe(packageFor(100));
    expect(offerFor("small_phone", [...images].reverse()).images).toEqual(selected.images);
    expect(images).toEqual(original);
  });

  it("prefers Google APIs then Play then default at an equal highest API", () => {
    expect(offerFor("pixel_fold", [image(35, "default"), image(35, "google_apis_playstore"), image(35)]).defaultImagePackage).toBe(packageFor(35));
    expect(offerFor("pixel_fold", [image(35, "default"), image(35, "google_apis_playstore")]).defaultImagePackage).toBe(packageFor(35, "google_apis_playstore"));
    expect(offerFor("pixel_fold", [image(36, "default"), image(35)]).defaultImagePackage).toBe(packageFor(36, "default"));
  });

  it("does not duplicate an installed package and leaves no-image offers explicitly unavailable", () => {
    expect(offerFor("pixel_fold", [image(35), image(35)]).images).toEqual([image(35)]);
    const empty = offerFor("pixel_fold", []);
    expect(empty.available).toBe(false);
    expect(empty.images).toEqual([]);
    expect(empty.defaultImagePackage).toBeNull();
    expect(empty.reason).not.toBeNull();
  });
});

describe("proposeAvdName", () => {
  it("normalizes spaced profile IDs without changing SDK membership or the selected image API", () => {
    expect(proposeAvdName("7.6in Foldable", 35, [])).toBe("omp_ui_7.6in_Foldable_api35");
    expect(proposeAvdName("pixel_fold", 34, [])).toBe("omp_ui_pixel_fold_api34");
    expect(proposeAvdName("pixel_fold", 35, [])).toBe("omp_ui_pixel_fold_api35");
  });

  it("finds an unoccupied suffix including preexisting suffixed names and case variants", () => {
    const occupied = ["OMP_UI_PIXEL_FOLD_API35", "omp_ui_pixel_fold_api35_2", "omp_ui_pixel_fold_api35_4"];
    expect(proposeAvdName("pixel_fold", 35, occupied)).toBe("omp_ui_pixel_fold_api35_3");
    const offers = createProfileOffers(new Set(["pixel_fold"]), [image(35)], occupied, null);
    expect(offers.find((row) => row.id === "pixel_fold")?.proposedAvd).toBe("omp_ui_pixel_fold_api35_3");
    expect(occupied).toEqual(["OMP_UI_PIXEL_FOLD_API35", "omp_ui_pixel_fold_api35_2", "omp_ui_pixel_fold_api35_4"]);
  });
});

describe("patchAvdKeyboard", () => {
  const nativeConfig = [
    "AvdId = fold",
    "hw.keyboard=no",
    "hw.lcd.width=2208",
    "hw.lcd.height=1840",
    "hw.lcd.density=420",
    "hw.lcd.aspectRatio = 6:5",
    "hw.lcd.size = 7.6",
    "hw.sensor.hinge=yes",
    "hw.sensor.hinge.count=1",
    "hw.sensor.hinge.ranges=0-180",
    "hw.sensor.hinge.defaults=180",
    "hw.display1.width=1080",
    "hw.display1.height=2092",
    "skin.path=_no_skin",
    "image.sysdir.1=system-images/android-35/google_apis/x86_64/",
    "",
  ].join("\n");

  it("changes keyboard only, preserving native geometry, hinge, image and skin configuration byte-for-byte", () => {
    const patched = patchAvdKeyboard(nativeConfig);
    expect(patched).toBe(nativeConfig.replace("hw.keyboard=no", "hw.keyboard=yes"));
    expect(patchAvdKeyboard(patched)).toBe(patched);
    expect(nativeConfig).toContain("hw.keyboard=no");
  });

  it("preserves CRLF, key formatting, duplicate keyboard entries and unrelated lines", () => {
    const input = "  hw.keyboard = no\r\nhw.sensor.hinge.count=1\r\nhw.keyboard=no\r\n";
    expect(patchAvdKeyboard(input)).toBe("  hw.keyboard = yes\r\nhw.sensor.hinge.count=1\r\nhw.keyboard=yes\r\n");
  });

  it("adds only the missing keyboard key while preserving trailing line breaks", () => {
    expect(patchAvdKeyboard("hw.sensor.hinge=yes\r\n\r\n")).toBe("hw.sensor.hinge=yes\r\nhw.keyboard=yes\r\n\r\n");
    expect(patchAvdKeyboard("hw.lcd.width=2208")).toBe("hw.lcd.width=2208\nhw.keyboard=yes");
    expect(patchAvdKeyboard("")).toBe("hw.keyboard=yes");
  });
});

describe("legacy presentation", () => {
  it("labels old static inner/outer AVDs without treating them as native creation profiles", () => {
    expect(legacyDevicePresentation("pixel_11_pro_fold_inner")).toEqual({ friendlyName: "Pixel 11 Pro Fold — inner", layoutReference: "Legacy static inner layout" });
    expect(legacyDevicePresentation("galaxy_z_fold_8_cover")).toEqual({ friendlyName: "Galaxy Z Fold 8 — outer", layoutReference: "Legacy static outer layout" });
    expect(legacyDevicePresentation("arbitrary_existing_device")).toBeNull();
    expect(legacyDevicePresentation("pixel_fold")).toBeNull();
  });
});
