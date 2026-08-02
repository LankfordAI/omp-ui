import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { field, strField } from "../lib/fields";
import { OTHER_OPTION, planSelect, readOptions, togglePick } from "../lib/multi-select";
import { useStore } from "../store";
import { Button, Chip, Dot } from "./ui";

/**
 * omp *blocks* on `extension_ui_response`, so every path out of this panel —
 * Escape, cancel button — must still send a reply. The payloads are protocol,
 * not UI: confirm → `{confirmed}`, select/editor → `{value}`, input →
 * `{value}`, abandon → `{cancelled:true}`.
 *
 * Deliberately *not* a modal: a question often needs the conversation to
 * answer it, so the panel docks above the composer and leaves the transcript
 * scrollable and readable. Keyboard nav therefore ignores events from text
 * fields — the composer keeps Enter/arrows/Escape while the user is typing.
 *
 * Multi-select (omp's ask tool with `multi: true`) is a *loop* of select
 * frames — see lib/multi-select.ts for the wire behavior. This host
 * reconstructs the picked set from the toggles it sent and verifies it
 * against the frame's `(N selected)` count.
 */

/** True when the key event belongs to a text field, not to this panel. */
function fromTextField(e: KeyboardEvent): boolean {
  const t = e.target;
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}

export function ExtensionDialogHost({ tabId }: { tabId: string }) {
  const queue = useStore((s) => s.rpc[tabId]?.extensionQueue) ?? [];
  const answerExtension = useStore((s) => s.answerExtension);
  const current = queue[0];

  const [inputValue, setInputValue] = useState("");
  const [active, setActive] = useState(0);
  /**
   * The reconstructed multi-select set for the loop in progress; null when
   * the host lost track (count mismatch, attach mid-loop). Keyed off the
   * question text via the plan's `base` — a different question resets it.
   */
  const [picked, setPicked] = useState<string[] | null>([]);
  /** The base question of the loop `picked` belongs to. */
  const loopBase = useRef<string | null>(null);
  /** The last toggle sent, pending confirmation by the next loop frame. */
  const lastSent = useRef<string | null>(null);

  const method = strField(current, "method") ?? "";
  const rawTitle = strField(current, "title") ?? "extension request";
  const options = useMemo(() => readOptions(field(current, "options")), [current]);

  const plan = method === "select" ? planSelect(rawTitle, options) : null;
  /** Multi-select is only recognizable from the loop frames omp sends. */
  const inMultiLoop = plan !== null && plan.count !== null;

  // Each request gets its own draft — a queued second dialog must not
  // inherit the first one's half-typed answer. The multi-select set instead
  // *survives* across frames of the same question: the arriving frame is the
  // loop continuing, and the toggle we sent for the previous frame is folded
  // in here, then verified against omp's count.
  useEffect(() => {
    setInputValue("");
    if (!current) return;
    if (method !== "select") {
      // An editor frame ("Other") belongs to the same ask loop — keep the
      // set so the panel still shows it when the loop resumes.
      setActive(0);
      return;
    }
    const parsed = planSelect(strField(current, "title") ?? "", []);
    // Consume the pending toggle outside setPicked — updaters must stay pure
    // (StrictMode invokes them twice).
    const sent = lastSent.current;
    lastSent.current = null;
    if (parsed.count === null || parsed.base !== loopBase.current) {
      // A fresh question (or a single-select) starts a new, empty set; a
      // loop frame for a question we never saw the start of stays unknown.
      loopBase.current = parsed.base;
      setPicked(parsed.count === null ? [] : null);
      setActive(0);
      return;
    }
    // Same question, next loop frame: fold in the toggle we sent, then let
    // omp's count arbitrate. A mismatch means missed frames — show count
    // only. The cursor deliberately survives — resetting it would yank the
    // highlight to the top after every toggle.
    setPicked((prev) => {
      const next = sent === null ? prev : togglePick(prev, sent);
      return next !== null && next.length === parsed.count ? next : null;
    });
  }, [current, method]);

  useEffect(() => {
    if (!current || plan === null) return;
    const listed = plan.listed;
    const onKey = (e: KeyboardEvent) => {
      // The composer owns keys while it has focus — Enter there is a steer,
      // not an answer, and Escape there is an agent abort.
      if (fromTextField(e)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        answerExtension(tabId, current, { cancelled: true });
        return;
      }
      if (listed.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % listed.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + listed.length) % listed.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        // In a multi loop Enter finishes; the highlighted option is toggled
        // with Space instead — matching the checkbox mental model and
        // keeping "Enter = answer" truthful.
        if (plan.doneValue !== null) {
          answerExtension(tabId, current, { value: plan.doneValue });
          return;
        }
        const choice = listed[active];
        if (choice) pick(choice.value);
      } else if (e.key === " " && plan.doneValue !== null) {
        e.preventDefault();
        const choice = listed[active];
        if (choice) pick(choice.value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!current) return null;

  const title = plan ? plan.base : rawTitle;
  const message = strField(current, "message") ?? strField(current, "label") ?? "";
  const cancel = () => answerExtension(tabId, current, { cancelled: true });
  /**
   * Answer with an option label. Only real options are recorded as pending
   * toggles — the Done sentinel and "Other" are loop affordances, and folding
   * them into the picked set would corrupt it.
   */
  function pick(value: string): void {
    if (current === undefined) return;
    lastSent.current = value === OTHER_OPTION ? null : value;
    answerExtension(tabId, current, { value });
  }

  return (
    <div className="animate-rise shrink-0 border-t border-signal-dim/40 bg-raised">
      <div className="flex items-start gap-2 px-4 pt-3">
        <Dot tone="signal" pulse className="mt-1.5" title="the agent is waiting on this answer" />
        <h2 className="min-w-0 flex-1 whitespace-pre-wrap break-words font-display text-sm leading-snug text-ink">
          {method === "editor" ? title.split("\n", 1)[0] : title}
        </h2>
        {inMultiLoop && (
          <Chip tone="iris" mono title="answers picked so far — picking again removes one">
            {plan.count} selected
          </Chip>
        )}
        {queue.length > 1 && <Chip tone="copper">{queue.length - 1} more</Chip>}
        <Chip mono title="the extension method awaiting a reply">
          {method || "?"}
        </Chip>
      </div>

      {/* The panel caps its own height so a long option list never buries the
          composer or the transcript; the list scrolls inside instead. */}
      <div className="max-h-[38vh] overflow-y-auto px-4 py-3">
        {message && (
          <p className="mb-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-mid">
            {message}
          </p>
        )}

        {method === "confirm" && (
          <div className="flex justify-end gap-2">
            <Button onClick={() => answerExtension(tabId, current, { confirmed: false })}>
              cancel
            </Button>
            <Button
              variant="solid"
              tone="signal"
              onClick={() => answerExtension(tabId, current, { confirmed: true })}
            >
              confirm
            </Button>
          </div>
        )}

        {plan !== null && (
          <div className="space-y-1">
            {plan.listed.map((option, i) => {
              const isPicked = picked?.includes(option.value) ?? false;
              const other = option.label === OTHER_OPTION;
              return (
                <button
                  key={`${option.value}:${i}`}
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(option.value)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                    i === active
                      ? "border-line-strong bg-hover"
                      : "border-transparent hover:bg-hover",
                    other && "text-ink-dim",
                  )}
                >
                  {inMultiLoop && !other && (
                    <span
                      aria-hidden
                      className={cn(
                        "mt-px grid size-3.5 shrink-0 place-items-center rounded-sm border text-[9px] leading-none",
                        isPicked
                          ? "border-signal-dim bg-signal-wash text-signal"
                          : "border-line text-transparent",
                      )}
                    >
                      ✓
                    </span>
                  )}
                  <span className="min-w-0">
                    <span
                      className={cn(
                        "block whitespace-pre-wrap break-words text-xs",
                        isPicked ? "text-signal" : "text-ink",
                      )}
                    >
                      {other ? "Other — type your own…" : option.label}
                    </span>
                    {option.description && (
                      <span className="mt-0.5 block whitespace-pre-wrap break-words text-[11px] leading-snug text-ink-faint">
                        {option.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            <div className="flex items-center justify-between pt-2">
              <span className="text-[10px] text-ink-faint">
                {plan.doneValue !== null
                  ? "↑↓ move · Space or click toggles · Enter done · Esc dismiss"
                  : "↑↓ choose · Enter answer · Esc dismiss"}
              </span>
              <span className="flex items-center gap-2">
                <Button variant="ghost" size="xs" onClick={cancel}>
                  cancel
                </Button>
                {plan.doneValue !== null && (
                  <Button
                    variant="solid"
                    tone="signal"
                    size="xs"
                    onClick={() => {
                      lastSent.current = null;
                      answerExtension(tabId, current, { value: plan.doneValue });
                    }}
                    title="finish selecting and send the answer"
                  >
                    done selecting
                  </Button>
                )}
              </span>
            </div>
          </div>
        )}

        {(method === "input" || method === "editor") && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              answerExtension(tabId, current, { value: inputValue });
            }}
          >
            {/* omp's editor titles carry the full prompt (ask's checkbox state
                and "Enter your response:") — the header shows line one, the
                rest lands here. */}
            {method === "editor" && rawTitle.includes("\n") && (
              <p className="mb-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-faint">
                {rawTitle.split("\n").slice(1).join("\n").trim()}
              </p>
            )}
            {method === "editor" ? (
              <textarea
                autoFocus
                rows={3}
                value={inputValue}
                aria-label={message || title}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancel();
                  } else if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    answerExtension(tabId, current, { value: inputValue });
                  }
                }}
                className="mb-3 w-full resize-y rounded-md border border-line bg-void px-2 py-1.5 text-sm text-ink outline-none focus:border-signal-dim"
              />
            ) : (
              <input
                autoFocus
                value={inputValue}
                aria-label={message || title}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  // The window listener skips text fields, so Escape-to-dismiss
                  // is restored here for the panel's own input.
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancel();
                  }
                }}
                className="mb-3 w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-ink outline-none focus:border-signal-dim"
              />
            )}
            <div className="flex justify-end gap-2">
              <Button onClick={cancel}>cancel</Button>
              <Button type="submit" variant="solid" tone="signal">
                submit
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
