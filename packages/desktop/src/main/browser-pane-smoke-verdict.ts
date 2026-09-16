export const SMOKE_EXIT = {
  ok: 0,
  listenerFailed: 2,
  noFrame: 3,
  inputFailed: 4,
  watchdog: 5,
} as const;

/** Unattended verdict over the summary: paint first, then the input self-test (#540). */
export function smokeExitCode(summary: {
  frames: { count: number; firstFrameIsJpeg: boolean | null };
  inputTest: ReadonlyArray<{ ok: boolean | null }>;
  quitPath: string | null;
}): number {
  if (summary.quitPath === "watchdog") return SMOKE_EXIT.watchdog;
  if (summary.frames.count < 1 || summary.frames.firstFrameIsJpeg !== true) return SMOKE_EXIT.noFrame;
  if (summary.inputTest.some((step) => step.ok === false)) return SMOKE_EXIT.inputFailed;
  return SMOKE_EXIT.ok;
}
