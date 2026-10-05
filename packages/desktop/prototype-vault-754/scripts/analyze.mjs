// PROTOTYPE (#754): throwaway.
// Joins each run's frames with its main.log proto754 lines and prints the
// facts the rubric is filled from. Usage: node analyze.mjs [R1 R2 ...]
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const evidence = join(dirname(fileURLToPath(import.meta.url)), "../evidence");
const runsDir = join(evidence, "runs");
const ids = process.argv.slice(2).length > 0 ? process.argv.slice(2) : readdirSync(runsDir).filter((d) => !d.includes(".prev-"));
const logLines = readFileSync(join(evidence, "main.log"), "utf8").split("\n");

const VAULT_XD = /^xd:\/\/(omp-ui_vault_\w+)/;

for (const id of ids) {
  const dir = join(runsDir, id);
  if (!existsSync(join(dir, "summary.json"))) continue;
  const s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
  const from = Date.parse(s.mainLogWindow?.from ?? s.startedAt);
  const to = Date.parse(s.mainLogWindow?.to ?? s.endedAt) + 2000;
  const proto = logLines
    .filter((l) => l.includes("proto754"))
    .map((l) => {
      const ts = Date.parse(l.slice(0, 25));
      const json = l.indexOf("proto754 {");
      return { ts, line: l, data: json === -1 ? null : JSON.parse(l.slice(json + 9)) };
    })
    .filter((p) => p.ts >= from - 1000 && p.ts <= to && (p.data === null || p.data.tabId === s.tabId || p.line.includes("late answer")));
  const calls = s.calls.map((c) => {
    let via = "direct";
    let vaultTool = c.toolName?.startsWith("omp-ui_vault_") ? c.toolName : null;
    if ((c.toolName === "write" || c.toolName === "read") && typeof c.args?.path === "string") {
      const m = VAULT_XD.exec(c.args.path);
      if (m) {
        vaultTool = m[1];
        via = c.toolName === "write" ? "xd-write" : "xd-read-doc";
      }
    }
    return {
      tool: c.toolName,
      vaultTool,
      via,
      args: JSON.stringify(c.args ?? null).slice(0, 300),
      isError: c.isError,
      e2eMs: c.e2eMs,
      result: (c.resultTextPreview ?? "").slice(0, 240),
    };
  });
  const fsFallback = calls.filter(
    (c) => c.vaultTool === null && /Obsidian|Documents|\.md|vault|find |omp-ui:\/\//i.test(c.args),
  );
  console.log(`\n===== ${id}  tab=${s.tabId}  control=${JSON.stringify(s.control)}`);
  console.log(`planVia=${s.planVia ?? "-"} approvals=${JSON.stringify(s.approvals)} timeouts=${JSON.stringify(s.timeouts)} errors=${s.errors?.length ?? 0}`);
  for (const c of calls) console.log(`  [${c.via}] ${c.tool}${c.vaultTool && c.vaultTool !== c.tool ? `→${c.vaultTool}` : ""} err=${c.isError} e2e=${c.e2eMs}ms args=${c.args}\n      ⇒ ${c.result.replace(/\n/g, " ⏎ ")}`);
  console.log(`  proto754 lines: ${proto.length}; vault calls in frames: ${calls.filter((c) => c.via === "direct" || c.via === "xd-write").filter((c) => c.vaultTool).length}`);
  for (const p of proto) console.log(`    ${p.data ? JSON.stringify(p.data) : p.line.slice(26)}`);
  if (fsFallback.length > 0) console.log(`  possible fs fallback: ${fsFallback.map((c) => c.args).join(" | ")}`);
  console.log(`  final: ${(s.finalAssistantText ?? "").slice(0, 900).replace(/\n/g, " ⏎ ")}`);
}
