import { readLayeredConfigScalar } from "./omp-config";
import { writeOmpSetting, type OmpConfigRunner } from "./omp-settings";
import type { OmpSettingValue } from "./types";

/** The memory defaults omp's own schema leaves behind, and their desired value.
 *  Keys whose omp default already matches are absent on purpose: seeding them
 *  would pin the global layer against future omp default changes. */
export const MEMORY_DEFAULT_SEED: ReadonlyArray<{ key: string; value: OmpSettingValue }> = [
  { key: "memory.backend", value: "mnemopi" },
  { key: "mnemopi.scoping", value: "per-project-tagged" },
  { key: "autolearn.enabled", value: true },
];

/**
 * Writes every seed key the global agent config does not mention to omp's
 * global layer, sequentially. Never throws. Resolves true only when every
 * needed write landed — a false return leaves the caller's marker unset so the
 * next boot retries. A key the config already names — whatever its value — is
 * skipped, not failed: it is the user's choice, and presence, not value
 * equality, is the test (an explicit `memory.backend: off` must survive).
 */
export async function seedMemoryDefaults(
  ompPath: string | null,
  opts: { env?: NodeJS.ProcessEnv; run?: OmpConfigRunner } = {},
): Promise<boolean> {
  if (ompPath === null) return false;
  const env = opts.env ?? process.env;
  let ok = true;
  for (const { key, value } of MEMORY_DEFAULT_SEED) {
    const dot = key.lastIndexOf(".");
    // projectCwd null → global layer only, matching what writeOmpSetting edits.
    const present = readLayeredConfigScalar(null, key.slice(0, dot), key.slice(dot + 1), env);
    if (present !== undefined) continue;
    // Sequential, never Promise.all: `omp config set` rewrites the whole global
    // YAML on every call, so parallel writes race and lose keys.
    try {
      await writeOmpSetting({ ompPath, key, value }, opts.run);
    } catch {
      ok = false;
    }
  }
  return ok;
}
