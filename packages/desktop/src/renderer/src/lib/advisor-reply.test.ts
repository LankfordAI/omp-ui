import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvisorNote, RenderItem } from "./transcript";
import {
  ADVISOR_REPLY_CAP_NOTICE,
  ADVISOR_REPLY_LEAD,
  ADVISOR_REPLY_MAX,
  ADVISOR_REPLY_SETTLE_MS,
  AdvisorReplyWatcher,
} from "./advisor-reply";

const TAB = "tab-reply";

const note = (text: string, severity?: string, advisor?: string): AdvisorNote => ({
  note: text,
  ...(severity !== undefined && { severity }),
  ...(advisor !== undefined && { advisor }),
});

/** An advisor's end-of-turn card. */
const advisory = (id: string, notes: AdvisorNote[]): RenderItem => ({ kind: "advisory", id, notes });

/** A done tool result — any tool result can carry advisor notes alongside its output. */
const toolDone = (id: string, notes: AdvisorNote[] = []): RenderItem => ({
  kind: "tool",
  id,
  toolCallId: `tc-${id}`,
  name: "read",
  args: {},
  status: "done",
  ...(notes.length > 0 && { notes }),
});

describe("AdvisorReplyWatcher", () => {
  let items: RenderItem[];
  let notices: Array<{ text: string; level: "info" | "warn" }>;
  let replies: Array<{ message: string; notes: AdvisorNote[] }>;
  /** Stands in for the session being between turns; the watcher only replies while idle. */
  let idle: boolean;
  let watcher: AdvisorReplyWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    items = [];
    notices = [];
    replies = [];
    idle = true;
    watcher = new AdvisorReplyWatcher({
      getItems: () => items,
      canReply: () => idle,
      onNotice: (_tabId, text, level) => {
        notices.push({ text, level });
      },
      onReply: (_tabId, message, notes) => {
        replies.push({ message, notes });
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers a finding that lands while idle exactly once, after the settle window", async () => {
    watcher.feed(TAB); // establishes the cursor at the end of the current transcript
    items.push(advisory("adv-1", [note("Hardcoded key", "blocker", "security")]));
    watcher.feed(TAB);

    await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS - 1);
    expect(replies).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.message).toContain(ADVISOR_REPLY_LEAD);
    expect(replies[0]!.message).toContain("- [blocker] (security) Hardcoded key");
    expect(replies[0]!.notes).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.level).toBe("info");
    expect(notices[0]!.text).toMatch(/answering it \(1 finding\)/);
  });

  it("collapses the same note arriving on a card and a tool result into one listed finding", async () => {
    const duplicate = note("Hardcoded key", "blocker", "security");
    watcher.feed(TAB);
    items.push(advisory("adv-1", [duplicate]));
    watcher.feed(TAB);
    items.push(toolDone("t1", [duplicate]));
    watcher.feed(TAB);

    await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.notes).toHaveLength(1);
    expect(replies[0]!.message.split("Hardcoded key").length - 1).toBe(1);
  });

  it("never replies during a running turn, and leaves the findings it spanned unanswered", async () => {
    idle = false;
    items.push(advisory("adv-1", [note("Hardcoded key", "blocker", "security")]));
    watcher.feed(TAB);
    await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS * 2);
    expect(replies).toHaveLength(0);

    // The turn ends: the cursor already moved past that finding, so it is not resurrected.
    idle = true;
    watcher.feed(TAB);
    await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS * 2);
    expect(replies).toHaveLength(0);
  });

  it("suppresses the reply when the session stops being idle inside the settle window", async () => {
    watcher.feed(TAB);
    items.push(advisory("adv-1", [note("Hardcoded key", "blocker", "security")]));
    watcher.feed(TAB); // arms the settle timer

    idle = false;
    await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS * 2);
    expect(replies).toHaveLength(0);
    expect(notices.filter((n) => n.level === "info")).toHaveLength(0);
  });

  it("ignores findings that already sat below the initial cursor", async () => {
    items.push(advisory("adv-old", [note("old nit", "nit", "style")]));
    watcher.feed(TAB);
    await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS * 2);
    expect(replies).toHaveLength(0);
  });

  it("stops after the consecutive-reply cap, notices once, and re-arms on reset", async () => {
    watcher.feed(TAB);
    for (let i = 0; i < ADVISOR_REPLY_MAX; i += 1) {
      items.push(advisory(`adv-${i}`, [note(`finding ${i}`, "concern", "ops")]));
      watcher.feed(TAB);
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS);
    }
    expect(replies).toHaveLength(ADVISOR_REPLY_MAX);

    // One finding past the cap: the watcher explains itself instead of dispatching.
    items.push(advisory("adv-capped", [note("over the cap", "concern", "ops")]));
    watcher.feed(TAB);
    const capped = notices.filter((n) => n.text === ADVISOR_REPLY_CAP_NOTICE);
    expect(capped).toHaveLength(1);
    expect(capped[0]!.level).toBe("warn");
    expect(replies).toHaveLength(ADVISOR_REPLY_MAX);
    await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS * 2);
    expect(replies).toHaveLength(ADVISOR_REPLY_MAX);

    // Further feeds without a newer finding must not repeat the explanation.
    watcher.feed(TAB);
    expect(notices.filter((n) => n.text === ADVISOR_REPLY_CAP_NOTICE)).toHaveLength(1);

    // A prompt from the operator resets the streak, so auto-reply works again.
    watcher.reset(TAB);
    items.push(advisory("adv-after-reset", [note("post reset", "concern", "ops")]));
    watcher.feed(TAB);
    await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS);
    expect(replies).toHaveLength(ADVISOR_REPLY_MAX + 1);
    expect(replies.at(-1)!.message).toContain("post reset");
  });

  it("cancel clears an armed settle window so nothing fires", async () => {
    watcher.feed(TAB);
    items.push(advisory("adv-1", [note("Hardcoded key", "blocker", "security")]));
    watcher.feed(TAB);
    watcher.cancel(TAB);
    await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS * 2);
    expect(replies).toHaveLength(0);
  });
});
