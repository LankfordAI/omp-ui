/** Addressed to omp-ui itself: the runtime, electron-updater's relaunch, install.sh's no-FUSE launcher. */
const RUNTIME_VARS = [
  "APPDIR",
  "APPIMAGE",
  "ARGV0",
  "OWD",
  "APPIMAGE_SILENT_INSTALL",
  "APPIMAGE_EXTRACT_AND_RUN",
] as const;

/** The entries AppRun derives from one AppImage root, per variable. */
const APPRUN_ENTRIES = [
  ["PATH", ["", "/usr/sbin"]],
  ["LD_LIBRARY_PATH", ["/usr/lib"]],
  ["GSETTINGS_SCHEMA_DIR", ["/usr/share/glib-2.0/schemas"]],
  ["XDG_DATA_DIRS", ["/usr/share/"]],
] as const;

/** AppRun also appends these to XDG_DATA_DIRS on every launch. */
const APPRUN_XDG_SUFFIX = ["/usr/share/gnome", "/usr/local/share/", "/usr/share/"] as const;

/**
 * Every launch generation's AppDir: $APPDIR, plus each PATH entry followed by
 * its own /usr/sbin whose /usr/lib is on LD_LIBRARY_PATH. That is the
 * fingerprint AppRun leaves; a user's own PATH pair does not carry it.
 */
function appImageRoots(env: NodeJS.ProcessEnv): Set<string> {
  const roots = new Set<string>();
  if (env.APPDIR) roots.add(env.APPDIR);
  const dirs = env.PATH ? env.PATH.split(":") : [];
  const libs = new Set(env.LD_LIBRARY_PATH ? env.LD_LIBRARY_PATH.split(":") : []);
  for (let i = 0; i + 1 < dirs.length; i++) {
    const root = dirs[i];
    if (root !== "" && dirs[i + 1] === `${root}/usr/sbin` && libs.has(`${root}/usr/lib`)) {
      roots.add(root);
    }
  }
  return roots;
}

function endsWithXdgSuffix(dirs: string[]): boolean {
  const offset = dirs.length - APPRUN_XDG_SUFFIX.length;
  return offset >= 0 && APPRUN_XDG_SUFFIX.every((dir, i) => dirs[offset + i] === dir);
}

/**
 * The environment omp-ui was launched with, recovered from its own
 * process.env. An AppImage launch edits that environment for omp-ui's process
 * alone: the type-2 runtime exports APPDIR, APPIMAGE, ARGV0 and OWD, and
 * electron-builder's AppRun prepends the mount to PATH, XDG_DATA_DIRS,
 * LD_LIBRARY_PATH and GSETTINGS_SCHEMA_DIR
 * (app-builder-lib/out/targets/appimage/appImageUtil.js:192-195). A child that
 * runs the user's programs must inherit neither: zsh hands an exported ARGV0
 * to every external command as its argv[0].
 *
 * electron-updater relaunches the new AppImage with the old process.env
 * (electron-updater/out/AppImageUpdater.js:103), so the edits stack once per
 * relaunch; every generation is undone. Call it per spawn, never cache it:
 * ProviderKeys installs keys into process.env after startup (ADR-0010).
 */
export function withoutAppImageRuntime(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  // AppImage is Linux-only, and splitting on ":" would cut a Windows drive letter.
  if (platform !== "linux") return env;

  const roots = appImageRoots(base);
  if (roots.size > 0) {
    for (const [name, suffixes] of APPRUN_ENTRIES) {
      const value = base[name];
      if (!value) continue;
      const derived = new Set<string>();
      for (const root of roots) {
        for (const suffix of suffixes) derived.add(`${root}${suffix}`);
      }
      const entries = value.split(":");
      const kept = entries.filter((entry) => !derived.has(entry));
      if (name === "XDG_DATA_DIRS") {
        // One suffix per generation whose AppDir entry was present, never more:
        // a launch environment that already ended in these dirs keeps its copy.
        for (let n = entries.length - kept.length; n > 0 && endsWithXdgSuffix(kept); n--) {
          kept.length -= APPRUN_XDG_SUFFIX.length;
        }
      }
      // A variable AppRun created from nothing is removed, not left empty.
      if (kept.length === 0) delete env[name];
      else env[name] = kept.join(":");
    }
  }
  for (const name of RUNTIME_VARS) delete env[name];
  return env;
}
