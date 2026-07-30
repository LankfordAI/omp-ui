export interface DiffRow {
  kind: "add" | "del" | "ctx" | "meta";
  lineNum?: number;
  text: string;
}

const NUMBERED_ROW = /^([+\- ])(\d+)\|(.*)$/;

/**
 * OMP's generateDiffString format is NOT unified diff: rows of
 * `+<num>|<text>` / `-<num>|<text>` / ` <num>|<text>`, `@@ ` context markers,
 * and an `*** End of File` marker — no hunk headers. Anything unrecognized
 * stays a meta row verbatim (forward-compatible).
 */
export function parseOmpDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const line of diff.split("\n")) {
    const m = NUMBERED_ROW.exec(line);
    if (m) {
      const [, sig = " ", num = "", text = ""] = m;
      const kind = sig === "+" ? "add" : sig === "-" ? "del" : "ctx";
      rows.push({ kind, lineNum: Number(num), text });
    } else {
      rows.push({ kind: "meta", text: line });
    }
  }
  return rows;
}
