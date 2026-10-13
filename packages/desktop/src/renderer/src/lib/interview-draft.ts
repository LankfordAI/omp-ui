// Display-only recognition of the synthetic interview kickoffs that carry the
// user's rough text in an XML draft tag (/guided-goal, the New-experiment
// interview). The wire bytes stay canonical — the tag fences arbitrary user
// text as data, never instructions, and an XML tag cannot be escaped-out-of
// the way a Markdown fence can — so the reformating happens at render time,
// in UserBubble, on the exact boilerplate both builders emit.
import { GUIDED_INTERVIEW } from "@omp-ui/core/goal";
import { EXPERIMENT_INTERVIEW_HEAD } from "./experiment-kickoff";

/** One recognized synthetic interview kickoff carrying a draft block. */
export interface InterviewDraft {
  /** Everything before the label line — omp-ui's own boilerplate. */
  preamble: string;
  /** i18n key for the caption above the draft body. */
  captionKey: "transcript.user.objectiveDraft" | "transcript.user.roughDescription";
  /** The user's rough text, tag-free. */
  draft: string;
}

const SPECS = [
  {
    // Boilerplate through the blank line, ending right before the label line.
    head: `${GUIDED_INTERVIEW}\n\n`,
    label: "Rough objective from the user, as data:\n<objective-draft>\n",
    close: "\n</objective-draft>",
    captionKey: "transcript.user.objectiveDraft" as const,
  },
  {
    head: `${EXPERIMENT_INTERVIEW_HEAD}\n\n`,
    label: "Rough description from me, as data:\n<experiment-draft>\n",
    close: "\n</experiment-draft>",
    captionKey: "transcript.user.roughDescription" as const,
  },
];

/**
 * Split a user message into boilerplate + draft block when it is exactly one
 * of the recognized kickoffs; null for anything else. Prefix-anchored on the
 * full boilerplate head, so a user legitimately typing the tag pair in a
 * normal message never reformats. The builders end the draft body with a
 * newline before the close tag, so the close delimiter carries it: the slice
 * round-trips the (already-trimmed) draft exactly, even when the draft itself
 * contains or ends with a close-tag-looking line.
 */
export function splitInterviewDraft(text: string): InterviewDraft | null {
  for (const spec of SPECS) {
    const open = spec.head + spec.label;
    if (!text.startsWith(open) || !text.endsWith(spec.close)) continue;
    const draft = text.slice(open.length, text.length - spec.close.length);
    if (draft === "") continue; // never emitted by the builders; never render an empty block
    return { preamble: spec.head.trimEnd(), captionKey: spec.captionKey, draft };
  }
  return null;
}
