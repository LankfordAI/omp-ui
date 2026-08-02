import { strField } from "./fields";

/**
 * omp's ask tool runs multi-select over RPC as a *loop* of independent
 * `select` requests: answering an option label toggles it, then a fresh
 * request arrives titled `(N selected) <question>` with a `✔ Done selecting`
 * sentinel in the options. Answering `Other (type your own)` swaps the loop
 * for a `method: "editor"` request. The frames never carry the selected set —
 * only the count — but this host is the only writer: every toggle is a
 * response it sent, so the set is reconstructible and the count is the
 * integrity check.
 *
 * In multi-question asks (`Which? (2/3)`), loop frames arrive *without* the
 * sentinel — the TUI finishes via arrow-key navigation there — but omp's
 * accept path still matches the sentinel string, so sending it unlisted
 * completes the question all the same (verified against omp v17 over RPC).
 */

export interface SelectOption {
  /** What omp gets back. For object options this is `value ?? label`. */
  value: string;
  label: string;
  description?: string;
}

export function readOptions(raw: unknown): SelectOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((option): SelectOption => {
    if (typeof option === "string") return { value: option, label: option };
    const label =
      strField(option, "label") ?? strField(option, "name") ?? strField(option, "value") ?? "";
    return {
      value: strField(option, "value") ?? label,
      label,
      description: strField(option, "description"),
    };
  });
}

/** The escape-hatch option omp's ask tool appends to every option list. */
export const OTHER_OPTION = "Other (type your own)";

/** What omp's default theme names the finish sentinel. */
export const DONE_SENTINEL = "✔ Done selecting";

/**
 * The finish sentinel. omp prefixes it with a theme-dependent check glyph
 * (`✔ Done selecting` under the default theme), so match the text leniently.
 */
export function isDoneSentinel(label: string): boolean {
  return /^[✔✓☑✅]?\s*Done selecting$/.test(label.trim());
}

export interface SelectPlan {
  /** The question with `(N selected) ` stripped; page markers (`(2/3)`) stay. */
  base: string;
  /** N from `(N selected)`, or null when this frame isn't a loop frame. */
  count: number | null;
  /** Options with the sentinel removed — what the picker should list. */
  listed: SelectOption[];
  /**
   * The value that finishes a multi-select, or null for single-select.
   * Prefers the frame's own sentinel (exact themed glyph); loop frames
   * without one (multi-question mode) fall back to the default literal.
   */
  doneValue: string | null;
}

const COUNT_PREFIX = /^\((\d+) selected\)\s*/;

/** Classifies a select frame: single-select, or a multi-select loop frame. */
export function planSelect(title: string, options: SelectOption[]): SelectPlan {
  const m = COUNT_PREFIX.exec(title);
  const base = m ? title.slice(m[0].length) : title;
  const count = m ? Number(m[1]) : null;
  const sentinel = options.find((o) => isDoneSentinel(o.label));
  return {
    base,
    count,
    listed: options.filter((o) => !isDoneSentinel(o.label)),
    doneValue: sentinel?.value ?? (count !== null ? DONE_SENTINEL : null),
  };
}

/** Toggle semantics of the loop: re-answering a picked label unpicks it. */
export function togglePick(picked: readonly string[] | null, label: string): string[] | null {
  if (picked === null) return null;
  return picked.includes(label) ? picked.filter((p) => p !== label) : [...picked, label];
}
