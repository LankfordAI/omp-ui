import { describe, expect, it } from "vitest";
import {
  androidChildEnv,
  androidCreationReadiness,
  androidSdkStatus,
  emulatorDiscoveryDirs,
  parseAdbDevices,
  parseAvdList,
  parseDiscoveryIni,
  parseWmSize,
  resolveAndroidAvdHome,
  resolveAndroidSdk,
  resolveAvdConfigPath,
  type AndroidSdkPaths,
} from "./android-sdk";
import type { DeviceSystemImage } from "./device-pane";

const filesIn = (files: string[]) => (p: string) => files.includes(p);

describe("resolveAndroidSdk", () => {
  const env = { ANDROID_HOME: "/a", ANDROID_SDK_ROOT: "/b" };
  const all = ["/a/platform-tools/adb", "/b/platform-tools/adb", "/h/Android/Sdk/platform-tools/adb"];

  it("prefers ANDROID_HOME, then ANDROID_SDK_ROOT, then the default", () => {
    expect(resolveAndroidSdk({ platform: "linux", env, home: "/h", isFile: filesIn(all) })?.sdkRoot).toBe("/a");
    expect(resolveAndroidSdk({ platform: "linux", env, home: "/h", isFile: filesIn(all.slice(1)) })?.sdkRoot).toBe(
      "/b",
    );
    expect(resolveAndroidSdk({ platform: "linux", env, home: "/h", isFile: filesIn(all.slice(2)) })?.sdkRoot).toBe(
      "/h/Android/Sdk",
    );
  });

  it("skips a root without platform-tools/adb and reports a missing emulator", () => {
    const paths = resolveAndroidSdk({ platform: "linux", env, home: "/h", isFile: filesIn(["/b/platform-tools/adb"]) });
    expect(paths).toEqual({ sdkRoot: "/b", adb: "/b/platform-tools/adb", emulator: null, avdmanager: null });
    expect(androidSdkStatus(paths)).toEqual({ status: "missing", missing: ["emulator"] });
    expect(resolveAndroidSdk({ platform: "linux", env: {}, home: "/h", isFile: () => false })).toBeNull();
    expect(androidSdkStatus(null).status).toBe("missing");
  });

  it("uses .exe on win32", () => {
    const paths = resolveAndroidSdk({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\L" },
      home: "C:\\U",
      isFile: filesIn(["C:\\L\\Android\\Sdk\\platform-tools\\adb.exe", "C:\\L\\Android\\Sdk\\emulator\\emulator.exe"]),
    });
    expect(paths?.adb).toBe("C:\\L\\Android\\Sdk\\platform-tools\\adb.exe");
    expect(paths?.emulator).toBe("C:\\L\\Android\\Sdk\\emulator\\emulator.exe");
    expect(androidSdkStatus(paths)).toEqual({ status: "ready", sdkRoot: "C:\\L\\Android\\Sdk" });
  });

  it("probes cmdline-tools/latest/bin/avdmanager beside the emulator", () => {
    const files = ["/a/platform-tools/adb", "/a/cmdline-tools/latest/bin/avdmanager"];
    expect(resolveAndroidSdk({ platform: "linux", env, home: "/h", isFile: filesIn(files) })?.avdmanager).toBe(
      "/a/cmdline-tools/latest/bin/avdmanager",
    );
    expect(resolveAndroidSdk({ platform: "linux", env, home: "/h", isFile: filesIn(all) })?.avdmanager).toBeNull();
    const win = resolveAndroidSdk({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\L" },
      home: "C:\\U",
      isFile: filesIn(["C:\\L\\Android\\Sdk\\platform-tools\\adb.exe", "C:\\L\\Android\\Sdk\\cmdline-tools\\latest\\bin\\avdmanager.bat"]),
    });
    expect(win?.avdmanager).toBe("C:\\L\\Android\\Sdk\\cmdline-tools\\latest\\bin\\avdmanager.bat");
  });
});

describe("androidCreationReadiness", () => {
  const paths: AndroidSdkPaths = {
    sdkRoot: "/sdk", adb: "/sdk/platform-tools/adb", emulator: "/sdk/emulator/emulator",
    avdmanager: "/sdk/cmdline-tools/latest/bin/avdmanager",
  };
  const nativeImage: DeviceSystemImage = {
    packageId: "system-images;android-35;google_apis;x86_64", api: 35,
    abi: "x86_64", tag: "google_apis", label: "API 35 Google APIs",
  };

  it("reports creation ready only with SDK tools and a complete native image", () => {
    expect(androidCreationReadiness(paths, "x64", [nativeImage])).toEqual({
      available: true, reason: null, sdkRoot: "/sdk", installCommand: null,
    });
  });

  it("keeps existing-AVD SDK readiness independent of avdmanager creation readiness", () => {
    const existingOnly = { ...paths, avdmanager: null };
    expect(androidSdkStatus(existingOnly)).toEqual({ status: "ready", sdkRoot: "/sdk" });
    expect(androidCreationReadiness(existingOnly, "x64", [nativeImage])).toEqual({
      available: false, reason: expect.stringContaining("avdmanager"), sdkRoot: "/sdk",
      installCommand: 'sdkmanager "cmdline-tools;latest"',
    });
  });

  it("describes missing owner setup without downloading or suggesting an opposite ABI", () => {
    const missing = androidCreationReadiness(null, "arm64", []);
    expect(missing.available).toBe(false);
    expect(missing.reason).toContain("owner machine");
    expect(missing.sdkRoot).toBeNull();
    expect(missing.installCommand).toContain('"platform-tools"');
    expect(missing.installCommand).toContain('"emulator"');
    expect(missing.installCommand).toContain('"cmdline-tools;latest"');
    expect(missing.installCommand).toContain('"system-images;android-35;google_apis;arm64-v8a"');
    expect(missing.installCommand).not.toContain("x86_64");
    const noEmulator = androidCreationReadiness({ ...paths, emulator: null }, "x64", [nativeImage]);
    expect(noEmulator.reason).toContain("emulator");
    expect(noEmulator.installCommand).toBe('sdkmanager "emulator"');
  });

  it("rejects missing images, opposite-ABI-only images and unsupported host architectures", () => {
    const noImages = androidCreationReadiness(paths, "x64", []);
    expect(noImages.available).toBe(false);
    expect(noImages.reason).toContain("complete installed x86_64");
    expect(noImages.installCommand).toBe('sdkmanager "system-images;android-35;google_apis;x86_64"');
    const oppositeOnly = androidCreationReadiness(paths, "arm64", [nativeImage]);
    expect(oppositeOnly.available).toBe(false);
    expect(oppositeOnly.installCommand).toContain("arm64-v8a");
    const unsupported = androidCreationReadiness(paths, "ia32", [nativeImage]);
    expect(unsupported).toEqual({
      available: false, reason: expect.stringContaining('"ia32"'), sdkRoot: "/sdk", installCommand: null,
    });
  });
});

describe("resolveAndroidAvdHome", () => {
  it("honors owner AVD, emulator and user home overrides rather than assuming ~/.android/avd", () => {
    const env = {
      ANDROID_AVD_HOME: "/disk/avds", ANDROID_EMULATOR_HOME: "/emulator", ANDROID_USER_HOME: "/user",
      ANDROID_SDK_HOME: "/legacy",
    };
    expect(resolveAndroidAvdHome(env, "/h", "linux")).toBe("/disk/avds");
    expect(resolveAndroidAvdHome({ ...env, ANDROID_AVD_HOME: "" }, "/h", "linux")).toBe("/emulator/avd");
    expect(resolveAndroidAvdHome({ ANDROID_USER_HOME: "/user", ANDROID_SDK_HOME: "/legacy" }, "/h", "linux")).toBe("/user/avd");
    expect(resolveAndroidAvdHome({ ANDROID_SDK_HOME: "/legacy" }, "/h", "linux")).toBe("/legacy/.android/avd");
    expect(resolveAndroidAvdHome({}, "/h", "linux")).toBe("/h/.android/avd");
    expect(resolveAndroidAvdHome({ ANDROID_AVD_HOME: "C:\\AVDs" }, "C:\\U", "win32")).toBe("C:\\AVDs");
  });
});

describe("resolveAvdConfigPath", () => {
  it("uses the actual absolute metadata content path, including paths containing spaces", () => {
    const metadata = "avd.ini.encoding=UTF-8\npath=/other disk/Android devices/fold.avd\npath.rel=avd/stale.avd\n";
    expect(resolveAvdConfigPath("fold", metadata, "/custom/avds", "linux")).toBe("/other disk/Android devices/fold.avd/config.ini");
    expect(resolveAvdConfigPath("fold", "path=C:\\Android Devices\\fold.avd\r\n", "C:\\avds", "win32")).toBe("C:\\Android Devices\\fold.avd\\config.ini");
  });

  it("resolves path.rel against the AVD home's parent, never against the SDK root", () => {
    expect(resolveAvdConfigPath("fold", "path.rel=avd/relocated.avd\n", "/h/.android/avd", "linux")).toBe("/h/.android/avd/relocated.avd/config.ini");
    expect(resolveAvdConfigPath("fold", "path.rel=devices/relocated.avd\n", "/custom/avds", "linux")).toBe("/custom/devices/relocated.avd/config.ini");
    expect(resolveAvdConfigPath("fold", "path.rel=avd\\fold.avd\r\n", "C:\\Android\\avd", "win32")).toBe("C:\\Android\\avd\\fold.avd\\config.ini");
  });

  it("uses the resolved AVD home only when metadata does not redirect the content directory", () => {
    expect(resolveAvdConfigPath("a.b", "avd.ini.encoding=UTF-8\n", "/mounted/avds", "linux")).toBe("/mounted/avds/a.b.avd/config.ini");
    expect(resolveAvdConfigPath("a.b", "", "C:\\AVDs", "win32")).toBe("C:\\AVDs\\a.b.avd\\config.ini");
  });

  it("rejects malformed metadata paths instead of patching an unrelated default location", () => {
    expect(() => resolveAvdConfigPath("fold", "path=relative/fold.avd\n", "/avds", "linux")).toThrow("absolute");
    expect(() => resolveAvdConfigPath("fold", "path.rel=/absolute/fold.avd\n", "/avds", "linux")).toThrow("relative");
    expect(() => resolveAvdConfigPath("../escape", "", "/avds", "linux")).toThrow("Invalid AVD name");
    expect(() => resolveAvdConfigPath("..", "", "/avds", "linux")).toThrow("Invalid AVD name");
  });
});

describe("androidChildEnv", () => {
  it("prepends tool dirs to PATH and sets ANDROID_HOME", () => {
    const env = androidChildEnv(
      { sdkRoot: "/s", adb: "/s/platform-tools/adb", emulator: "/s/emulator/emulator", avdmanager: null },
      { PATH: "/usr/bin" },
      "linux",
    );
    expect(env.PATH).toBe("/s/platform-tools:/s/emulator:/usr/bin");
    expect(env.ANDROID_HOME).toBe("/s");
  });
});

describe("parsers", () => {
  it("parseAdbDevices skips the header and keeps offline/unauthorized states", () => {
    const out =
      "List of devices attached\nemulator-5554          device product:sdk model:x\nemulator-5556\toffline\nR58M\tunauthorized usb:1\n\n";
    expect(parseAdbDevices(out)).toEqual([
      { serial: "emulator-5554", state: "device" },
      { serial: "emulator-5556", state: "offline" },
      { serial: "R58M", state: "unauthorized" },
    ]);
  });

  it("parseAvdList drops INFO lines", () => {
    expect(parseAvdList("INFO    | Storing crashdata in: /tmp\nPixel_7_API_34\nsmall.phone\n")).toEqual([
      "Pixel_7_API_34",
      "small.phone",
    ]);
  });

  it("parseWmSize prefers Override size", () => {
    expect(parseWmSize("Physical size: 1080x2400\nOverride size: 720x1600\n")).toEqual({ width: 720, height: 1600 });
    expect(parseWmSize("Physical size: 1080x2400\n")).toEqual({ width: 1080, height: 2400 });
    expect(parseWmSize("error")).toBeNull();
  });

  it("parseDiscoveryIni reads key=value lines", () => {
    const ini = parseDiscoveryIni("port.serial=5554\r\ngrpc.port=8554\ngrpc.token=a=b\n");
    expect(ini.get("port.serial")).toBe("5554");
    expect(ini.get("grpc.token")).toBe("a=b");
  });
});

describe("emulatorDiscoveryDirs", () => {
  it("linux order", () => {
    expect(
      emulatorDiscoveryDirs({ platform: "linux", env: { XDG_RUNTIME_DIR: "/x" }, home: "/h", tmpdir: "/t", uid: 1000 }),
    ).toEqual(["/x/avd/running", "/run/user/1000/avd/running", "/h/.android/avd/running", "/t/avd/running"]);
    expect(
      emulatorDiscoveryDirs({ platform: "linux", env: { ANDROID_EMULATOR_HOME: "/e" }, home: "/h", tmpdir: "/t", uid: 1 }),
    ).toEqual(["/run/user/1/avd/running", "/e/avd/running", "/t/avd/running"]);
  });

  it("darwin order", () => {
    expect(emulatorDiscoveryDirs({ platform: "darwin", env: {}, home: "/h", tmpdir: "/t" })).toEqual([
      "/h/Library/Caches/TemporaryItems/avd/running",
      "/h/.android/avd/running",
      "/t/avd/running",
    ]);
  });

  it("win32 order", () => {
    expect(emulatorDiscoveryDirs({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, home: "C:\\U" })).toEqual([
      "C:\\L\\Temp\\avd\\running",
      "C:\\U\\.android\\avd\\running",
    ]);
  });
});
