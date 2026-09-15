// PROTOTYPE (#527) — throwaway. The chrome every variant shares: the toolbar
// (navigation, URL bar, agent liveness, open-external, attach-to-prompt), the
// frame painter with its empty state, and the globe glyph. Literal English —
// the real words are #528's.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { cn } from "../../lib/cn";
import { AttachmentButton, Button, Chip, Dot, Empty, ICON_STROKE, IconButton, IconRefresh, Switch } from "../ui";
import { startFakeFrames } from "./frame-source";
import {
  getPane,
  goBack,
  goForward,
  latestFrame,
  navigate,
  normalizeUrl,
  reload,
  setSimulateAgent,
  useBrowserPane,
} from "./state";

/** Globe glyph for a 16-unit viewBox; the HUD toggle, the rail's TabIcon, and the palette row share it. */
export function IconBrowserPaths() {
  return (
    <>
      <circle cx="8" cy="8" r="5.6" {...ICON_STROKE} />
      <path d="M2.4 8h11.2M8 2.4c-2.2 2.4-2.2 8.8 0 11.2M8 2.4c2.2 2.4 2.2 8.8 0 11.2" {...ICON_STROKE} />
    </>
  );
}

function IconChevron({ dir }: { dir: "back" | "forward" }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path d={dir === "back" ? "M10 3.5L5.5 8 10 12.5" : "M6 3.5L10.5 8 6 12.5"} {...ICON_STROKE} />
    </svg>
  );
}

function IconOpenExternal() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path d="M6.5 3.5H4.2A1.7 1.7 0 0 0 2.5 5.2v6.6a1.7 1.7 0 0 0 1.7 1.7h6.6a1.7 1.7 0 0 0 1.7-1.7V9.5" {...ICON_STROKE} />
      <path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5" {...ICON_STROKE} />
    </svg>
  );
}

/* ------------------------------------------------------- attach to prompt */

export type AttachOutcome = "attached" | "no-frame" | "no-composer";

export function attachToPrompt(tabId: string): AttachOutcome {
  const frame = latestFrame.get(tabId);
  if (frame === undefined) return "no-frame";
  const textarea = document.querySelector<HTMLTextAreaElement>(
    `[data-tab-id="${CSS.escape(tabId)}"] [data-composer-input]:not([disabled])`,
  );
  // offsetParent === null: hidden while the plan review owns the column.
  if (textarea === null || textarea.offsetParent === null) return "no-composer";

  // The image rides the composer's own paste path (Composer.tsx onPaste →
  // hasClipboardImage → the Attachment preview) — no store-level API exists.
  const file = new File([frame.jpeg], `browser-${Date.now()}.jpg`, { type: "image/jpeg" });
  const dt = new DataTransfer();
  dt.items.add(file);
  textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));

  // The URL joins the draft through the native setter + an input event so
  // React's controlled value updates — the same trick the repo's tests use.
  const url = getPane(tabId).url ?? "";
  const value = textarea.value;
  const next = `${value}${value === "" || value.endsWith(" ") ? "" : " "}${url} `;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, next);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.focus();
  return "attached";
}

/* ---------------------------------------------------------------- toolbar */

const NOTE_TEXT: Record<AttachOutcome, string> = {
  attached: "attached",
  "no-frame": "no frame yet",
  "no-composer": "no composer here",
};

/** 0 → 100 % over the 900 ms sweep; re-arms on every navigation via `since`. */
function LoadingBar({ since }: { since: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    ref.current?.animate([{ width: "0%" }, { width: "100%" }], { duration: 900, easing: "linear", fill: "forwards" });
  }, [since]);
  return <span ref={ref} aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 w-0 bg-signal" />;
}

const ROW = "flex shrink-0 items-center gap-1 border-b border-line-soft px-2 py-1.5";

/**
 * `dense` = two rows (navigation + URL, then indicator + actions): variant B
 * and every compact Sheet. `className` overrides the single-row frame (C's
 * banner supplies its own border and gutter).
 */
export function BrowserToolbar({ tabId, dense = false, className }: { tabId: string; dense?: boolean; className?: string }) {
  const state = useBrowserPane(tabId);
  const [draft, setDraft] = useState(state.url ?? "");
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);

  // Agent navigations update the bar; a bar the user is typing into is left alone.
  useEffect(() => {
    if (document.activeElement !== input.current) setDraft(state.url ?? "");
  }, [state.url]);

  useEffect(() => {
    if (note === null) return;
    const id = window.setTimeout(() => setNote(null), 2000);
    return () => window.clearTimeout(id);
  }, [note]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const url = normalizeUrl(draft);
    if (url === null) return; // invalid: leave the typed text in place
    navigate(tabId, url, "user");
    input.current?.blur();
  };

  const nav = (
    <>
      <IconButton label="back" disabled={state.index <= 0} onClick={() => goBack(tabId)}>
        <IconChevron dir="back" />
      </IconButton>
      <IconButton label="forward" disabled={state.index >= state.history.length - 1} onClick={() => goForward(tabId)}>
        <IconChevron dir="forward" />
      </IconButton>
      <IconButton label="reload" disabled={state.url === null} onClick={() => reload(tabId)}>
        <IconRefresh />
      </IconButton>
      <form className="relative flex min-w-0 flex-1 items-center" onSubmit={submit}>
        <input
          ref={input}
          type="text"
          inputMode="url"
          spellCheck={false}
          aria-label="address"
          placeholder="Enter a URL"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            setDraft(state.url ?? "");
            e.currentTarget.blur();
          }}
          className={cn(
            "min-w-0 flex-1 rounded-md border border-line bg-sunken px-2 py-1 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong",
            state.lastNav === "agent" && "pr-14",
          )}
        />
        {state.loading && <LoadingBar since={state.loadingSince} />}
        {state.lastNav === "agent" && (
          <Chip tone="copper" mono className="pointer-events-none absolute right-1.5">
            agent
          </Chip>
        )}
      </form>
    </>
  );

  const actions = (
    <>
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-ink-faint">
        <Dot
          tone={state.agentConnected ? "signal" : "neutral"}
          pulse={state.agentConnected}
          title={state.agentConnected ? "an agent is driving this page" : "no agent attached"}
        />
        {state.agentConnected ? "agent connected" : "no agent"}
      </span>
      <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-ink-faint">
        <Switch on={state.simulateAgent} label="simulate agent" onChange={(on) => setSimulateAgent(tabId, on)} />
        simulate agent
      </span>
      {dense && <span className="min-w-0 flex-1" />}
      <IconButton
        label="open in system browser"
        disabled={state.url === null}
        onClick={() => {
          if (state.url !== null) window.open(state.url);
        }}
      >
        <IconOpenExternal />
      </IconButton>
      <AttachmentButton
        label="attach page to prompt"
        disabled={state.url === null}
        onClick={() => setNote(NOTE_TEXT[attachToPrompt(tabId)])}
      />
      {note !== null && <span className="shrink-0 font-mono text-[10px] text-ink-faint">{note}</span>}
    </>
  );

  if (dense) {
    return (
      <>
        <div className={ROW}>{nav}</div>
        <div className={ROW}>{actions}</div>
      </>
    );
  }
  return (
    <div className={cn(ROW, className)}>
      {nav}
      {actions}
    </div>
  );
}

/* ------------------------------------------------------------ frame canvas */

let paintWarned = false;

export function FrameCanvas({ tabId }: { tabId: string }) {
  const state = useBrowserPane(tabId);
  const wrapper = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  /** Container size in CSS px — a ref, not state: it feeds the 8 fps loop. */
  const size = useRef({ width: 0, height: 0 });

  useEffect(() => {
    const el = wrapper.current;
    if (el === null) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      size.current = { width: rect.width, height: rect.height };
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);

    let decoding = false;
    const stop = startFakeFrames({
      tabId,
      size: () => size.current,
      // Reads the store directly so the loop never re-subscribes.
      model: () => getPane(tabId),
      onFrame: (frame) => {
        if (decoding || canvas.current === null) return; // drop while a decode is in flight
        decoding = true;
        createImageBitmap(new Blob([frame.jpeg], { type: "image/jpeg" }))
          .then((bitmap) => {
            const target = canvas.current;
            if (target !== null) {
              if (target.width !== frame.width) target.width = frame.width;
              if (target.height !== frame.height) target.height = frame.height;
              target.getContext("2d")?.drawImage(bitmap, 0, 0, target.width, target.height);
            }
            bitmap.close();
          })
          .catch((err: unknown) => {
            if (paintWarned) return;
            paintWarned = true;
            console.warn("[prototype-browser-pane] createImageBitmap failed; skipping frames", err);
          })
          .finally(() => {
            decoding = false;
          });
      },
    });
    return () => {
      observer.disconnect();
      stop();
    };
  }, [tabId]);

  return (
    <div
      ref={wrapper}
      className={cn(
        "relative flex min-h-0 flex-1 flex-col overflow-hidden",
        state.url === null ? "items-center justify-center bg-surface" : "bg-[#f6f7f9]",
      )}
    >
      {state.url === null ? (
        <Empty
          title="No page yet"
          hint="Type a URL above, or let the agent open one — this pane shows the page the agent is driving."
          action={
            <Button size="xs" onClick={() => navigate(tabId, "https://example.com/", "user")}>
              Open example.com
            </Button>
          }
        />
      ) : (
        <canvas ref={canvas} className="block h-full w-full" />
      )}
      {/* Agent cursor: chrome over the frame, not page pixels. */}
      {state.agentCursor !== null && (
        <span
          aria-hidden
          className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-2 border-signal"
          style={{ left: `${state.agentCursor.x * 100}%`, top: `${state.agentCursor.y * 100}%` }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- body */

export function BrowserPaneBody({ tabId, dense = false }: { tabId: string; dense?: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <BrowserToolbar tabId={tabId} dense={dense} />
      <FrameCanvas tabId={tabId} />
    </div>
  );
}
