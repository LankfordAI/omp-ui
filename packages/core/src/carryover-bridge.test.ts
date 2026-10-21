import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CARRYOVER_CONTEXT_COMMAND,
  CARRYOVER_CONTEXT_CUSTOM_TYPE,
  carryoverContextArmMessage,
  carryoverContextExtensionPath,
  writeCarryoverContextExtension,
} from "./carryover-bridge";
import { CARRYOVER_CONTEXT_CHAR_MAX, renderCarryoverDigest } from "./carryover-context";
import { typecheckGeneratedExtension } from "./generated-extension-test-utils";
import { bound, hiddenContextHarness } from "./hidden-context-test-utils";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-carryover-bridge-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The `set <json>` argument string the spawner's arming command carries. */
function setArgs(text: string): string {
  return carryoverContextArmMessage(text).slice(`/${CARRYOVER_CONTEXT_COMMAND} `.length);
}

function harness() {
  return hiddenContextHarness({
    write: writeCarryoverContextExtension,
    command: CARRYOVER_CONTEXT_COMMAND,
    lineageDir: tempLineage(),
  });
}

const digest = renderCarryoverDigest([{ role: "user", text: "hello" }]);

describe("writeCarryoverContextExtension", () => {
  it("writes into the lineage dir, overwrites a stale copy, and strictly typechecks", () => {
    const lineage = path.join(tempLineage(), "nested");
    const file = writeCarryoverContextExtension(lineage);
    expect(file).toBe(carryoverContextExtensionPath(lineage));
    expect(path.basename(file)).toBe("omp-ui-carryover-context.ts");
    fs.writeFileSync(file, "// stale\n", "utf8");
    writeCarryoverContextExtension(lineage);
    expect(fs.readFileSync(file, "utf8")).not.toBe("// stale\n");
    // Proves the empty resend list still generates valid strict TS.
    typecheckGeneratedExtension(file);
  });
});

describe("carryover context delivery", () => {
  it("delivers the armed digest once as a hidden next-turn message", async () => {
    const h = harness();
    await bound(h);
    await h.invoke(setArgs(digest));
    expect(h.sent).toEqual([
      {
        msg: { customType: CARRYOVER_CONTEXT_CUSTOM_TYPE, content: digest, display: false, attribution: "agent" },
        opts: { deliverAs: "nextTurn", triggerTurn: false },
      },
    ]);
    expect(h.notices).toEqual([]);
  });

  it("never re-sends on compaction, branch, or switch", async () => {
    const h = harness();
    await bound(h);
    await h.invoke(setArgs(digest));
    // No pin left on the path and a compaction after it: Ask chats would re-send here.
    h.branch.push({ type: "compaction" });
    for (const event of ["session_compact", "session_branch", "session_switch"]) await h.fire(event);
    expect(h.sent).toHaveLength(1);
    expect(h.notices).toEqual([]);
  });

  it("accepts a digest at the ceiling and refuses one past it", async () => {
    const atCeiling = harness();
    await bound(atCeiling);
    const max = "a".repeat(CARRYOVER_CONTEXT_CHAR_MAX);
    await atCeiling.invoke(setArgs(max));
    expect(atCeiling.sent.map((s) => s.msg.content)).toEqual([max]);
    expect(atCeiling.notices).toEqual([]);

    const past = harness();
    await bound(past);
    await past.invoke(setArgs("a".repeat(CARRYOVER_CONTEXT_CHAR_MAX + 1)));
    expect(past.sent).toEqual([]);
    expect(past.notices).toEqual([{ message: "omp-ui carryover context: malformed context", level: "warning" }]);
  });
});
