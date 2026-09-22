import { describe, expect, it } from "vitest";
import { withoutAppImageRuntime } from "./appimage-env";

/** One launch through the AppImage runtime and AppRun (appImageUtil.js:192-195). */
function launch(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const prepend = (head: string, rest: string | undefined): string =>
    rest ? `${head}:${rest}` : head;
  return {
    ...env,
    APPDIR: root,
    APPIMAGE: "/home/u/.local/bin/omp-ui.AppImage",
    ARGV0: "/home/u/.local/bin/omp-ui.AppImage",
    OWD: "/home/u",
    PATH: prepend(`${root}:${root}/usr/sbin`, env.PATH),
    XDG_DATA_DIRS: `${prepend(`${root}/usr/share/`, env.XDG_DATA_DIRS)}:/usr/share/gnome:/usr/local/share/:/usr/share/`,
    LD_LIBRARY_PATH: prepend(`${root}/usr/lib`, env.LD_LIBRARY_PATH),
    GSETTINGS_SCHEMA_DIR: prepend(`${root}/usr/share/glib-2.0/schemas`, env.GSETTINGS_SCHEMA_DIR),
  };
}

const desktop: NodeJS.ProcessEnv = {
  HOME: "/home/u",
  SHELL: "/bin/zsh",
  PATH: "/usr/local/bin:/usr/bin",
  XDG_DATA_DIRS: "/home/u/.local/share/flatpak/exports/share:/usr/local/share/:/usr/share/",
};

describe("withoutAppImageRuntime", () => {
  it("restores the launch environment across updater relaunch generations", () => {
    const launched = {
      ...launch(launch(desktop, "/tmp/.mount_omp-uiAAAAAA"), "/tmp/.mount_omp-uiBBBBBB"),
      APPIMAGE_SILENT_INSTALL: "true",
    };
    const snapshot = { ...launched };

    const restored = withoutAppImageRuntime(launched, "linux");

    expect(restored).toEqual(desktop);
    expect(launched).toEqual(snapshot);
    expect(withoutAppImageRuntime(restored, "linux")).toEqual(restored);
  });

  it("keeps values the launch environment already had in the edited variables", () => {
    const own = {
      ...desktop,
      LD_LIBRARY_PATH: "/opt/cuda/lib64",
      GSETTINGS_SCHEMA_DIR: "/opt/schemas",
      // Already ends in AppRun's suffix: only the generation's own copy goes.
      XDG_DATA_DIRS: "/usr/share/gnome:/usr/local/share/:/usr/share/",
    };
    expect(withoutAppImageRuntime(launch(own, "/tmp/appimage_extracted_0123"), "linux")).toEqual(
      own,
    );
  });

  it("leaves a PATH pair that lacks AppRun's library entry", () => {
    const env = { PATH: "/opt/tool:/opt/tool/usr/sbin:/usr/bin", LD_LIBRARY_PATH: "/opt/other/lib" };
    expect(withoutAppImageRuntime(env, "linux")).toEqual(env);
  });

  it("returns other platforms' environments unchanged", () => {
    const env = { PATH: "C:\\tools;C:\\Windows", ARGV0: "x" };
    const result = withoutAppImageRuntime(env, "win32");
    expect(result).toEqual(env);
    expect(result).not.toBe(env);
  });
});
