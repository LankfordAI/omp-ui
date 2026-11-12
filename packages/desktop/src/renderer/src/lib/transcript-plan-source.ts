import { isHtmlPlanDocument } from "@omp-ui/core/plan";

export interface TranscriptPlanCandidate {
  entryId: string;
  role: "user" | "assistant";
  timestamp: string;
  contentIndex: number | null;
  start: number;
  end: number;
  /** The entire original part. Offsets select the document without normalizing it. */
  text: string;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const idOk = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 128;

function documentRanges(text: string): { start: number; end: number }[] {
  if (isHtmlPlanDocument(text)) return [{ start: 0, end: text.length }];
  const ranges: { start: number; end: number }[] = [];
  let fence: { char: string; length: number; html: boolean; body: number } | null = null;
  let offset = 0;
  while (offset < text.length) {
    const start = offset;
    while (offset < text.length && text[offset] !== "\r" && text[offset] !== "\n") offset++;
    const line = text.slice(start, offset);
    if (text[offset] === "\r") offset++;
    if (text[offset] === "\n") offset++;
    if (fence) {
      const closer = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closer && closer[1]![0] === fence.char && closer[1]!.length >= fence.length) {
        if (fence.html && isHtmlPlanDocument(text, fence.body, start)) ranges.push({ start: fence.body, end: start });
        fence = null;
      }
    } else {
      const opener = /^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
      if (opener) {
        const info = opener[2]!.trim().split(/\s+/, 1)[0];
        fence = { char: opener[1]![0]!, length: opener[1]!.length, html: info?.toLowerCase() === "html", body: offset };
      }
    }
  }
  return ranges;
}

/** Returns authoritative current-branch documents, including pre-compaction entries. */
export function transcriptPlanCandidates(entries: unknown[], leafId: unknown): TranscriptPlanCandidate[] | null {
  if (!Array.isArray(entries) || !idOk(leafId)) return null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (!object(entry) || !idOk(entry.id) || byId.has(entry.id)) return null;
    byId.set(entry.id, entry);
  }
  const path: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor !== null) {
    const entry = byId.get(cursor);
    if (!entry || seen.has(cursor)) return null;
    seen.add(cursor);
    path.push(entry);
    if (entry.parentId === null) cursor = null;
    else if (idOk(entry.parentId)) cursor = entry.parentId;
    else return null;
  }
  const candidates: TranscriptPlanCandidate[] = [];
  for (let i = path.length - 1; i >= 0; i--) {
    const entry = path[i]!;
    if (entry.type !== "message" || !object(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.role === "assistant" && message.stopReason !== "stop" && message.stopReason !== "toolUse") continue;
    if (typeof entry.timestamp !== "string") return null;
    const add = (text: string, contentIndex: number | null): void => {
      for (const range of documentRanges(text)) candidates.push({ entryId: entry.id as string, role: message.role as "user" | "assistant", timestamp: entry.timestamp as string, contentIndex, ...range, text });
    };
    if (typeof message.content === "string") add(message.content, null);
    else if (Array.isArray(message.content)) {
      for (let index = 0; index < message.content.length; index++) {
        const part: unknown = message.content[index];
        if (object(part) && part.type === "text" && typeof part.text === "string") add(part.text, index);
      }
    }
  }
  return candidates;
}
