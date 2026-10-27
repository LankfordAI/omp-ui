import type { SessionSummary } from "@omp-ui/core/types";
import { strField } from "./fields";
import { shortModelLabel } from "./format";
import { planSelect } from "./multi-select";
import { parsePage } from "./question-series";

/** What a waiting session's tile quotes (issue #938). */
export interface TileQuote {
  kind: "plan" | "question";
  text: string;
}

/**
 * The question text a blocking dialog frame shows, derived exactly as the
 * dialog card's heading: a select loop's "(N selected)" prefix and an
 * editor's body lines are dropped, then the "(i/n)" page marker. Null for a
 * frame with no usable title.
 */
export function dialogQuestion(frame: unknown): string | null {
  const title = strField(frame, "title");
  if (title === undefined) return null;
  const method = strField(frame, "method");
  const base =
    method === "select"
      ? planSelect(title, []).base
      : method === "editor"
        ? (title.split("\n", 1)[0] ?? "")
        : title;
  const text = parsePage(base).base.trim();
  return text === "" ? null : text;
}

/** The pending plan gate outranks a dialog, as in deriveSidebarSessionState. */
export function tileQuote(s: SessionSummary): TileQuote | null {
  const planTitle = s.pendingPlan?.title.trim() ?? "";
  if (planTitle !== "") return { kind: "plan", text: planTitle };
  const head = s.pendingDialogs?.[0];
  const text = head === undefined ? null : dialogQuestion(head);
  return text === null ? null : { kind: "question", text };
}

/** `model · thinking` for the tile; null while the record pins no model. */
export function tileModel(s: SessionSummary): string | null {
  if (s.model === null) return null;
  const model = shortModelLabel(s.model);
  return s.thinkingLevel === null ? model : `${model} · ${s.thinkingLevel}`;
}
