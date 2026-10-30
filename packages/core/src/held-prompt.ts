// The held-prompt contract (issue #986): a prompt omp-ui keeps for a session
// until its provider's usage window resets, then sends through the normal
// prompt path. Pure — type-only imports — because the renderer imports it
// through the @omp-ui/core/held-prompt subpath, exactly like limits.ts.
import type { LimitsView } from "./limits";

/**
 * pi-ai's `Flag.UsageLimit` bit (omp 18.14 `errorId`, `UsageLimit: 524288`).
 * omp sets it on an assistant message whose provider call failed on a
 * subscription or quota limit, and on the `auto_retry_start` that waits on one.
 */
export const OMP_ERROR_FLAG_USAGE_LIMIT = 0x0008_0000;

/**
 * Margin past the provider's reported reset before the held prompt goes out:
 * provider clocks and usage endpoints lag the nominal reset by seconds.
 */
export const HELD_PROMPT_MARGIN_MS = 60_000;

/** Command-id prefix of a held prompt's `prompt` command; the suffix is its id. */
export const HELD_PROMPT_COMMAND_PREFIX = "omp-ui-held-prompt-";

/** Longest prose preview the record carries; the full text rides the lineage artifact. */
export const HELD_PROMPT_PREVIEW_MAX = 400;

/**
 * The held prompt as the session record carries it, so every client's
 * broadcast stays small: the wire text and image bytes live in the lineage
 * dir until the prompt is sent or cancelled.
 */
export interface HeldPrompt {
  /** Stable id; the prompt command's id is {@link heldPromptCommandId}. */
  id: string;
  /** The draft's prose, cut to {@link HELD_PROMPT_PREVIEW_MAX}. */
  preview: string;
  imageCount: number;
  documentCount: number;
  createdAtMs: number;
  /** Epoch ms at which the owning host sends it; null while it waits for a reported reset or for the user. */
  sendAtMs: number | null;
  /** Epoch ms omp admitted the last send; null until then and after a re-arm. A
   *  record still carrying it after its process died never re-sends on its own:
   *  omp may already hold the prompt. */
  sentAtMs: number | null;
  /** Sends that failed on the usage limit again and re-armed. */
  attempts: number;
  /** Why the last send did not go through; the prompt then waits for the user. */
  error: string | null;
}

/** The request a composer sends to hold its draft. */
export interface HeldPromptRequest {
  /** The wire text, already carrying any document block and image routing suffix. */
  text: string;
  /** The draft's prose, for the transcript card. */
  preview: string;
  images: { type: "image"; data: string; mimeType: string }[];
  /** Scratch paths of the PDFs the text's document block names (ADR-0044). */
  documents: string[];
  /** The provider-reported reset the composer offered. */
  resetAtMs: number;
}

/** What Cancel hands back to the composer draft: the wire text and its images. */
export interface HeldPromptPayload {
  text: string;
  images: { type: "image"; data: string; mimeType: string }[];
}

export function heldPromptCommandId(id: string): string {
  return `${HELD_PROMPT_COMMAND_PREFIX}${id}`;
}

export function isHeldPrompt(value: unknown): value is HeldPrompt {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  return (
    typeof v.id === "string" &&
    v.id !== "" &&
    typeof v.preview === "string" &&
    finite(v.imageCount) &&
    finite(v.documentCount) &&
    finite(v.createdAtMs) &&
    (v.sendAtMs === null || finite(v.sendAtMs)) &&
    (v.sentAtMs === null || finite(v.sentAtMs)) &&
    finite(v.attempts) &&
    (v.error === null || typeof v.error === "string")
  );
}

/** True when an assistant message's terminal error is omp's usage-limit class. */
export function isUsageLimitError(stopReason: unknown, errorId: unknown): boolean {
  return (
    stopReason === "error" &&
    typeof errorId === "number" &&
    (errorId & OMP_ERROR_FLAG_USAGE_LIMIT) !== 0
  );
}

/**
 * The reset a held prompt should wait for, or null when nothing says the
 * session is limited. An exhausted window (≥ 100% used) with a future reset
 * wins, earliest first. After a turn failed on the usage limit, a provider
 * that reports the binding window just under 100% still names it: the
 * fullest window with a future reset is taken.
 */
export function usageResetMs(
  limits: LimitsView | null,
  failedOnLimit: boolean,
  now: number,
): number | null {
  if (limits === null || !limits.available) return null;
  let exhausted: number | null = null;
  let fullest: { percent: number; at: number } | null = null;
  for (const window of limits.windows) {
    const at = window.resetsAtMs;
    if (at === null || at <= now) continue;
    const percent = window.percent ?? 0;
    if (percent >= 100 && (exhausted === null || at < exhausted)) exhausted = at;
    if (fullest === null || percent > fullest.percent) fullest = { percent, at };
  }
  if (exhausted !== null) return exhausted;
  return failedOnLimit && fullest !== null ? fullest.at : null;
}
