import { useState } from "react";
import { field, strField } from "../lib/fields";
import { useStore } from "../store";

function optionLabel(option: unknown): string {
  if (typeof option === "string") return option;
  return strField(option, "label") ?? strField(option, "value") ?? strField(option, "name") ?? "";
}

export function ExtensionDialogHost({ tabId }: { tabId: string }) {
  const [inputValue, setInputValue] = useState("");
  const queue = useStore((s) => s.rpc[tabId]?.extensionQueue);
  const answerExtension = useStore((s) => s.answerExtension);
  const current = queue?.[0];
  if (!current) return null;

  const method = strField(current, "method") ?? "";
  const title = strField(current, "title") ?? "extension request";
  const message = strField(current, "message") ?? strField(current, "label") ?? "";
  const options = field(current, "options");
  const cancel = () => answerExtension(tabId, current, { cancelled: true });

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60">
      <div className="w-96 rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-xl">
        <div className="mb-1 text-sm font-semibold">{title}</div>
        {message && <p className="mb-3 whitespace-pre-wrap text-xs text-neutral-400">{message}</p>}

        {method === "confirm" && (
          <div className="flex justify-end gap-2">
            <button
              className="rounded bg-neutral-700 px-3 py-1 text-xs hover:bg-neutral-600"
              onClick={() => answerExtension(tabId, current, { confirmed: false })}
            >
              Cancel
            </button>
            <button
              className="rounded bg-neutral-200 px-3 py-1 text-xs text-neutral-900 hover:bg-white"
              onClick={() => answerExtension(tabId, current, { confirmed: true })}
            >
              OK
            </button>
          </div>
        )}

        {method === "select" && (
          <div className="space-y-1">
            {Array.isArray(options) &&
              options.map((option, i) => {
                const label = optionLabel(option);
                return (
                  <button
                    key={i}
                    className="block w-full rounded bg-neutral-800 px-3 py-1.5 text-left text-xs hover:bg-neutral-700"
                    onClick={() => answerExtension(tabId, current, { value: label })}
                  >
                    {label}
                  </button>
                );
              })}
            <button
              className="mt-2 rounded px-2 py-1 text-[11px] text-neutral-500 hover:text-neutral-300"
              onClick={cancel}
            >
              cancel
            </button>
          </div>
        )}

        {method === "input" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setInputValue("");
              answerExtension(tabId, current, { value: inputValue });
            }}
          >
            <input
              autoFocus
              className="mb-3 w-full rounded bg-neutral-800 px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-neutral-600"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded bg-neutral-700 px-3 py-1 text-xs hover:bg-neutral-600"
                onClick={() => {
                  setInputValue("");
                  cancel();
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded bg-neutral-200 px-3 py-1 text-xs text-neutral-900 hover:bg-white"
              >
                OK
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
