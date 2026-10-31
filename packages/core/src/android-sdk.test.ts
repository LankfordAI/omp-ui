import { describe, expect, it } from "vitest";
import {
  androidChildEnv,
  androidSdkStatus,
  avdConfigPath,
  emulatorDiscoveryDirs,
  parseAdbDevices,
  parseAvdList,
  parseDiscoveryIni,
  parseWmSize,
  resolveAndroidSdk,
} from "./android-sdk";

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

describe("avdConfigPath", () => {
  it("joins under ~/.android/avd", () => {
    expect(avdConfigPath("/h", "pixel_11_pro_xl", "linux")).toBe("/h/.android/avd/pixel_11_pro_xl.avd/config.ini");
    expect(avdConfigPath("C:\\U", "a.b", "win32")).toBe("C:\\U\\.android\\avd\\a.b.avd\\config.ini");
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
