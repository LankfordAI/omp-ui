// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ToolItem } from "../lib/transcript";
// The spread keeps the real HIGHLIGHT_CHAR_CAP/langFromPath; only the hook is
// stubbed so no wasm/dynamic grammar loads run under jsdom. splitReadResult is
// NOT mocked here — it lives in ./ToolCard, so the parser units below run the
// production code.
import { HIGHLIGHT_CHAR_CAP } from "../lib/highlight";
import { splitReadResult, ToolCard } from "./ToolCard";

const highlightCalls = vi.hoisted(
  () => [] as Array<{ code: string; lang?: string; enabled: boolean }>,
);
vi.mock(import("../lib/highlight"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useHighlightTokens: (code: string, lang?: string, enabled = false) => {
      highlightCalls.push({ code, lang, enabled });
      return enabled
        ? [[{ content: code.split("\n")[0] ?? "", offset: 0, color: "#aabbcc" }]]
        : null;
    },
  };
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Defensive parity with TranscriptView.test.tsx: nothing under ToolCard builds
// one today, but the stub keeps that true even if an inner component grows one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;

function tool(over: Partial<ToolItem>): ToolItem {
  return {
    kind: "tool",
    id: "t1",
    toolCallId: "call-1",
    name: "Generic",
    args: {},
    status: "done",
    ...over,
  };
}

function renderCard(item: ToolItem): { el: HTMLDivElement; root: Root } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(<ToolCard item={item} />);
  });
  return { el, root };
}

beforeEach(() => {
  highlightCalls.length = 0;
});

describe("splitReadResult", () => {
  it("splits the bracketed header from N:-guttered body rows", () => {
    const parts = splitReadResult("[src/app.ts#A1B2]\n1:const a = 1;\n2:\n3:// tail");
    expect(parts.header).toBe("[src/app.ts#A1B2]");
    expect(parts.rows).toEqual([
      { num: "1", text: "const a = 1;" },
      { num: "2", text: "" },
      { num: "3", text: "// tail" },
    ]);
  });

  it("keeps every row gutterless when there is no header", () => {
    const parts = splitReadResult("just prose\nsee https://example.com/a:1");
    expect(parts.header).toBeNull();
    expect(parts.rows).toEqual([
      { num: null, text: "just prose" },
      { num: null, text: "see https://example.com/a:1" },
    ]);
  });

  it("treats mid-body elision markers as ordinary gutterless lines", () => {
    const parts = splitReadResult("[big.txt]\n1:a\n… 96 lines elided …\n98:c");
    expect(parts.rows[1]).toEqual({ num: null, text: "… 96 lines elided …" });
    expect(parts.rows[2]).toEqual({ num: "98", text: "c" });
  });

  it("a trailing newline yields a final empty row, untrimmed", () => {
    const parts = splitReadResult("[f.txt]\n1:a\n");
    expect(parts.rows).toEqual([
      { num: "1", text: "a" },
      { num: null, text: "" },
    ]);
  });

  it("header-only input produces no rows", () => {
    expect(splitReadResult("[f.txt]")).toEqual({ header: "[f.txt]", rows: [] });
  });
});

describe("ToolCard read-result slab", () => {
  it("tokenizes the body beside faint select-none gutters and skips autolink", () => {
    const { el, root } = renderCard(
      tool({
        name: "Read",
        path: "src/app.ts",
        resultText: "[src/app.ts#A1B2]\n1:see https://example.com/x now\n2:\n",
      }),
    );

    expect(highlightCalls.at(-1)).toEqual({
      code: "see https://example.com/x now\n\n",
      lang: "ts",
      enabled: true,
    });

    const gutters = [...el.querySelectorAll("pre .tabular-nums")];
    expect(gutters.map((g) => g.textContent)).toEqual(["1:", "2:"]);
    for (const g of gutters) {
      expect(g.classList.contains("select-none")).toBe(true);
      expect(g.classList.contains("text-ink-faint")).toBe(true);
    }

    const faint = [...el.querySelectorAll("span.text-ink-faint")].map((s) => s.textContent ?? "");
    expect(faint.some((t) => t.startsWith("[src/app.ts#A1B2]"))).toBe(true);

    const tokened = [...el.querySelectorAll("span")].find(
      (s) => s.style.color === "rgb(170, 187, 204)", // #aabbcc as jsdom serializes it
    );
    expect(tokened?.textContent).toBe("see https://example.com/x now");

    // Read slabs never autolink — the URL stays plain text inside the token.
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("https://example.com/x");
    act(() => root.unmount());
  });

  it("an errored read (no bracketed header) stays on the legacy rose slab", () => {
    const { el, root } = renderCard(
      tool({
        name: "Read",
        path: "src/app.ts",
        status: "error",
        resultText: "read failed: see https://example.com/docs",
      }),
    );

    const anchor = el.querySelector<HTMLAnchorElement>('a[role="link"]');
    expect(anchor?.getAttribute("title")).toBe("https://example.com/docs");
    const slab = el.querySelector("pre.text-rose");
    expect(slab?.textContent).toContain("read failed");
    expect(highlightCalls).toHaveLength(0);
    act(() => root.unmount());
  });

  it("a bash result keeps the plain slab and its autolinks", () => {
    const { el, root } = renderCard(
      tool({ name: "Bash", resultText: "pong from https://example.com/a" }),
    );

    expect(el.querySelector('a[role="link"]')).not.toBeNull();
    expect(highlightCalls).toHaveLength(0);
    expect(el.querySelector("pre .tabular-nums")).toBeNull();
    act(() => root.unmount());
  });
});

describe("ToolCard arguments dump", () => {
  it("tokenizes as json only once the disclosure opens", () => {
    const args = { config: { retries: 2 }, url: "https://example.com" };
    const { el, root } = renderCard(tool({ name: "DoThing", args }));

    // Closed by default: the tokenize cost must not be paid unseen.
    expect(highlightCalls).toHaveLength(0);

    const btn = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("all arguments"),
    );
    expect(btn).toBeDefined();
    act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(highlightCalls).toHaveLength(1);
    expect(highlightCalls[0]).toEqual({
      code: JSON.stringify(args, null, 2),
      lang: "json",
      enabled: true,
    });
    act(() => root.unmount());
  });
});

describe("ToolCard search args", () => {
  it("bounds a long unbroken pattern and keeps the full text in title", () => {
    const pattern =
      "\b(shellExitCb|windowStub|emptyOmpSettings|mockBackend|idleAppUpdate|idleOmpUpdate|idleRemoteState|deferred|flushMicrotasks|driveBoot|stateWithRecord|openedUrls|registerShellWriter|deriveSidebarSessionState|RpcCommandTimeoutError)\b";
    const { el, root } = renderCard(
      tool({ name: "Grep", args: { pattern, path: "src" } }),
    );

    const chip = [...el.querySelectorAll("span")].find((s) =>
      s.className.includes("max-w-full"),
    );
    expect(chip).toBeDefined();
    // Full pattern survives in the DOM (selectable) and in the hover title.
    expect(chip!.querySelector(".truncate")?.textContent).toBe(pattern);
    expect(chip!.getAttribute("title")).toBe(pattern);
    act(() => root.unmount());
  });
});

describe("ToolCard streaming partials", () => {
  it("a write partial highlights with the target file's language", () => {
    const partialText = "<html><body>streaming…";
    const { root } = renderCard(
      tool({
        name: "Write",
        status: "running",
        args: { content: "<p>hi</p>", file_path: "index.html" },
        partialText,
      }),
    );

    // Two surfaces tokenize (the write draft and the partial); both are html,
    // and the newest call carries the streamed partial text itself.
    expect(highlightCalls.length).toBe(2);
    expect(highlightCalls.every((c) => c.lang === "html")).toBe(true);
    expect(highlightCalls.at(-1)).toMatchObject({ code: partialText, enabled: true });
    act(() => root.unmount());
  });

  it("a bash partial stays on the pinned plain slab with autolinks", () => {
    const { el, root } = renderCard(
      tool({ name: "Bash", status: "running", partialText: "PING https://example.com" }),
    );

    expect(el.querySelector('a[role="link"]')).not.toBeNull();
    expect(el.textContent).toContain("streaming");
    expect(highlightCalls).toHaveLength(0);
    act(() => root.unmount());
  });
});

describe("ToolCard highlight cap", () => {
  it("payloads at the char cap stay plain; just under it tokenize", () => {
    // Strictly over the line: exactly HIGHLIGHT_CHAR_CAP chars is NOT < cap.
    const atCap = renderCard(
      tool({
        name: "Write",
        status: "running",
        args: { content: "a".repeat(HIGHLIGHT_CHAR_CAP), file_path: "a.txt" },
      }),
    );
    expect(highlightCalls.at(-1)).toMatchObject({
      code: "a".repeat(HIGHLIGHT_CHAR_CAP),
      lang: "txt",
      enabled: false,
    });
    act(() => atCap.root.unmount());

    highlightCalls.length = 0;
    const underCap = renderCard(
      tool({
        name: "Write",
        status: "running",
        args: { content: "a".repeat(HIGHLIGHT_CHAR_CAP - 1), file_path: "a.txt" },
      }),
    );
    expect(highlightCalls.at(-1)).toMatchObject({
      code: "a".repeat(HIGHLIGHT_CHAR_CAP - 1),
      lang: "txt",
      enabled: true,
    });
    act(() => underCap.root.unmount());
  });
});
