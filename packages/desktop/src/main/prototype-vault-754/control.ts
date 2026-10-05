// PROTOTYPE (#754): throwaway.
import * as fs from "node:fs";

export const PROTO754_CONTROL_ENV = "OMP_UI_PROTOTYPE_754_CONTROL";

export interface Proto754Control {
  vaultPath: string;
  vaultId: string;
  vaultName: string;
  /** Trailing slash required, e.g. "omp-ui/". */
  homeFolder: string;
  loadMode: "discoverable" | "essential";
  guidance: "none" | "message";
  /** Refuse vault writes while omp-ui Plan mode is on. */
  planGuard: boolean;
  searchDelayMs: number;
  searchBackend: "fs" | "cli";
  /** Attach the first embedded image on read. */
  readImages: boolean;
}

/** Re-read on every call so a run can switch settings without restarting the app. */
export function readProto754Control(): Proto754Control | null {
  const file = process.env[PROTO754_CONTROL_ENV];
  if (file === undefined || file === "") return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    const c = parsed as Partial<Proto754Control>;
    if (
      typeof c.vaultPath !== "string" ||
      typeof c.vaultId !== "string" ||
      typeof c.vaultName !== "string" ||
      typeof c.homeFolder !== "string" ||
      !c.homeFolder.endsWith("/") ||
      (c.loadMode !== "discoverable" && c.loadMode !== "essential") ||
      (c.guidance !== "none" && c.guidance !== "message") ||
      typeof c.planGuard !== "boolean" ||
      typeof c.searchDelayMs !== "number" ||
      (c.searchBackend !== "fs" && c.searchBackend !== "cli") ||
      typeof c.readImages !== "boolean"
    ) {
      throw new Error("missing or mistyped field");
    }
    return c as Proto754Control;
  } catch (error) {
    console.warn(`[proto754] control file ${file} unreadable: ${String(error)}`);
    return null;
  }
}
