import { spawn } from "node:child_process";
import { homedir } from "node:os";

import { withoutAppImageRuntime } from "@omp-ui/core";
import { shell } from "electron";

/*
 * Hands URLs and paths to the desktop's default handler. On Linux, Electron's
 * shell.openExternal/openPath start xdg-open (xdg-email for mailto:) from
 * omp-ui's own process.env and accept no replacement (Electron 43
 * shell/common/platform_util_linux.cc, XDGUtil). An AppImage's ARGV0,
 * APPIMAGE, APPDIR, OWD and AppRun PATH/LD_LIBRARY_PATH edits then reach the
 * handler and everything it starts: a VS Code window's terminals (#633), or a
 * browser the launch starts cold and every program that browser opens later
 * (#635). Linux therefore spawns the same tools from withoutAppImageRuntime().
 * The cost is Electron's XDG activation token, which a Node spawn cannot
 * mint: on Wayland a handler that is already running opens the target
 * without raising its window. Other platforms keep Electron's shell.
 */

/**
 * Long-lived process started from withoutAppImageRuntime(): detached and
 * unref'd; resolves on the 'spawn' event, rejects on 'error', never waits for
 * exit. Executor form (not Promise.withResolvers): the node tsconfig lib is
 * ES2022, same convention as live-entry.ts.
 */
export function spawnDetached(file: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      detached: true,
      stdio: "ignore",
      env: withoutAppImageRuntime(),
    });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * The Linux launch, with the tool Electron itself picks. The home directory
 * cannot vanish the way a deleted project directory can, so a rejection
 * means the tool itself could not start.
 */
function xdgLaunch(tool: "xdg-open" | "xdg-email", target: string): Promise<void> {
  return spawnDetached(tool, [target], homedir());
}

/** Opens a URL with its default handler; rejects when the handler cannot start. */
export function openExternal(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "linux") return shell.openExternal(url);
  return xdgLaunch(/^mailto:/i.test(url) ? "xdg-email" : "xdg-open", url);
}

/**
 * Opens an absolute path with its default handler. Rejects when the handler
 * cannot start (Linux) or reports a failure (Electron's error string
 * elsewhere).
 */
export async function openPath(
  absPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "linux") {
    await xdgLaunch("xdg-open", absPath);
    return;
  }
  const failure = await shell.openPath(absPath);
  if (failure !== "") throw new Error(failure);
}
