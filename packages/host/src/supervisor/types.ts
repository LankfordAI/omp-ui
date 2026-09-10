/**
 * Platform supervisors for the persistent host (issue #442 §9, #456). Each
 * adapter owns exactly one reserved identity — a systemd user unit, a
 * LaunchAgent label, a Scheduled Task path — renders the definition it
 * installs there, recognises its own definition back, and converges
 * install/uninstall without ever replacing a foreign one. Every shell-out
 * goes through `SupervisorDeps.run`, so the adapters are exercised by tests
 * against scripted argv and never touch a real supervisor.
 */

export type SupervisorId = "systemd-user" | "launchd-agent" | "windows-task" | "unsupported";

export type SupervisorStatus =
  | { kind: "absent" }
  | {
      kind: "installed";
      running: boolean;
      /** A definition sits at our reserved identity but `parse` says it is not ours. */
      foreign: boolean;
      /** Where the definition lives: a file path, or the task path on Windows. */
      path: string;
      /** The supervisor's own state word (`active`, `waiting`, `Running`, …). */
      detail: string;
    }
  | { kind: "unsupported"; reason: string };

export interface RenderOpts {
  /** Absolute path of the `omp-ui` binary the definition starts. */
  execPath: string;
  dataRoot: string;
  /** Where a supervisor without a journal captures stdout/stderr. */
  logDir: string;
}

export type UninstallOpts = { purgeData: false } | { purgeData: true; dataRoot: string };

export interface Supervisor {
  readonly id: SupervisorId;
  /** The reserved identity's location; on Windows the task path itself. */
  readonly definitionPath: string;
  render(opts: RenderOpts): string;
  parse(existing: string): { ours: boolean; execStart: string | null };
  /** Writes (when changed), enables, and starts. Never probes the host. */
  install(opts: RenderOpts): Promise<void>;
  status(): Promise<SupervisorStatus>;
  /** Stops and removes only an omp-ui-owned definition; absent is success. */
  uninstall(opts: UninstallOpts): Promise<void>;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (cmd: string, args: string[]) => Promise<RunResult>;

export interface SupervisorFs {
  /** `null` when the file does not exist. */
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, data: string | Uint8Array, mode: number): Promise<void>;
  /** Recursive; existing is fine. */
  mkdir(path: string): Promise<void>;
  /** Forced; absent is fine. */
  rm(path: string, opts: { recursive: boolean }): Promise<void>;
}

export interface SupervisorDeps {
  run: RunCommand;
  home: string;
  platform: NodeJS.Platform;
  /** Defaults to `node:fs`. */
  fs?: SupervisorFs;
  /** Login name; Linux linger and the Windows logon principal. Defaults to `os.userInfo().username`. */
  user?: string;
  /** macOS `gui/<uid>` domain. Defaults to `process.getuid()`. */
  uid?: number;
  /** Where the Windows task XML is written before `schtasks /Create`. Defaults to `os.tmpdir()`. */
  tmpDir?: string;
  /** Windows `USERDOMAIN` qualifies the principal. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Throws when a required command failed, naming it and its stderr. */
export function must(result: RunResult, what: string): void {
  if (result.code === 0) return;
  const stderr = result.stderr.trim();
  throw new Error(`${what} failed (exit ${result.code})${stderr ? `: ${stderr}` : ""}`);
}

export function foreignDefinition(where: string): Error {
  return new Error(`foreign supervisor definition at ${where}`);
}
