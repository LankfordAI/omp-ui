import type { OmpSettingsSnapshot } from "@omp-ui/core/types";

/** The shell's omp-settings snapshot load state; the pages render from it. */
export type Load =
  | { status: "loading" }
  | { status: "loaded"; snapshot: OmpSettingsSnapshot }
  | { status: "error"; message: string };

/** readOmpSettings never rejects with this — only a null ompPath produces it. */
export const OMP_MISSING = "omp binary not found";
