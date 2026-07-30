import { useEffect, useMemo, useState } from "react";
import { cn } from "../lib/cn";
import { field, strField } from "../lib/fields";
import { useStore } from "../store";
import { Button, Chip, Modal } from "./ui";

/**
 * omp *blocks* on `extension_ui_response`, so every path out of this dialog —
 * Escape, scrim click, cancel button — must still send a reply. The payloads are
 * protocol, not UI: confirm → `{confirmed}`, select → `{value}`, input →
 * `{value}`, abandon → `{cancelled:true}`.
 */

interface SelectOption {
  /** What omp gets back. For object options this is `value ?? label`. */
  value: string;
  label: string;
  description?: string;
}

function readOptions(raw: unknown): SelectOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((option): SelectOption => {
    if (typeof option === "string") return { value: option, label: option };
    const label =
      strField(option, "label") ?? strField(option, "name") ?? strField(option, "value") ?? "";
    return {
      value: strField(option, "value") ?? label,
      label,
      description: strField(option, "description"),
    };
  });
}

export function ExtensionDialogHost({ tabId }: { tabId: string }) {
  const queue = useStore((s) => s.rpc[tabId]?.extensionQueue) ?? [];
  const answerExtension = useStore((s) => s.answerExtension);
  const current = queue[0];

  const [inputValue, setInputValue] = useState("");
  const [active, setActive] = useState(0);

  // Each request gets its own draft and its own cursor — a queued second dialog
  // must not inherit the first one's half-typed answer.
  useEffect(() => {
    setInputValue("");
    setActive(0);
  }, [current]);

  const method = strField(current, "method") ?? "";
  // Stable identity keeps the select keydown listener from re-registering per render.
  const options = useMemo(() => readOptions(field(current, "options")), [current]);

  useEffect(() => {
    if (!current || method !== "select" || options.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % options.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + options.length) % options.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const choice = options[active];
        if (choice) answerExtension(tabId, current, { value: choice.value });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, method, options, active, answerExtension, tabId]);

  if (!current) return null;

  const title = strField(current, "title") ?? "extension request";
  const message = strField(current, "message") ?? strField(current, "label") ?? "";
  const cancel = () => answerExtension(tabId, current, { cancelled: true });

  return (
    <Modal onClose={cancel}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h2 className="min-w-0 flex-1 truncate font-display text-sm text-ink">{title}</h2>
        {queue.length > 1 && <Chip tone="copper">{queue.length - 1} more</Chip>}
        <Chip mono title="the extension method awaiting a reply">
          {method || "?"}
        </Chip>
      </div>

      <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
        {message && (
          <p className="mb-3 whitespace-pre-wrap text-xs leading-relaxed text-ink-mid">{message}</p>
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

        {method === "select" && (
          <div className="space-y-1">
            {options.map((option, i) => (
              <button
                key={`${option.value}:${i}`}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => answerExtension(tabId, current, { value: option.value })}
                className={cn(
                  "block w-full rounded-md border px-2.5 py-1.5 text-left transition-colors",
                  i === active
                    ? "border-line-strong bg-hover"
                    : "border-transparent hover:bg-hover",
                )}
              >
                <span className="block truncate text-xs text-ink">{option.label}</span>
                {option.description && (
                  <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">
                    {option.description}
                  </span>
                )}
              </button>
            ))}
            <div className="flex justify-end pt-2">
              <Button variant="ghost" size="xs" onClick={cancel}>
                cancel
              </Button>
            </div>
          </div>
        )}

        {method === "input" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              answerExtension(tabId, current, { value: inputValue });
            }}
          >
            <input
              autoFocus
              value={inputValue}
              aria-label={message || title}
              onChange={(e) => setInputValue(e.target.value)}
              className="mb-3 w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-ink outline-none focus:border-signal-dim"
            />
            <div className="flex justify-end gap-2">
              <Button onClick={cancel}>cancel</Button>
              <Button type="submit" variant="solid" tone="signal">
                submit
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
