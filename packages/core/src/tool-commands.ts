import { compareVersions } from "./semver";

/**
 * omp 19.1 replaced the `xd://` tool devices with tool commands: rarely-used
 * tools run as bash commands while `bash` is active, plan submission moved from
 * writing the slug to `xd://propose` to the `propose` command, and the session
 * probe renamed from `getMountedXdevToolNames` to
 * `getMountedToolCommandNames` (issue #1270). Both halves ship in the same
 * release, so one gate covers the mount-probe name and the submission channel.
 *
 * Renderer-safe: no Node imports, so the capabilities viewer and the main
 * process share one gate. Not registered against `MIN_SUPPORTED_OMP`: below it
 * omp-ui keeps speaking the `xd://` dialect the older harness dispatches.
 */
export const TOOL_COMMANDS_MIN_OMP = "19.1.0";

/** Unknown version is unsupported: an older omp has no tool-command surface. */
export function supportsToolCommands(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, TOOL_COMMANDS_MIN_OMP) >= 0;
}
