import { useState } from "react";
import { useStore } from "../store";

export function PromptBox({ tabId }: { tabId: string }) {
  const [text, setText] = useState("");
  const rpc = useStore((s) => s.rpc[tabId]);
  const rpcCommand = useStore((s) => s.rpcCommand);
  const streaming = rpc?.status === "running";
  const dead = useStore((s) => s.exited[tabId] !== undefined);

  const send = () => {
    const message = text.trim();
    if (!message || streaming || dead) return;
    setText("");
    rpcCommand(tabId, { type: "prompt", message }).catch((err: unknown) => {
      window.alert(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <div className="flex items-center gap-2 border-t border-neutral-800 px-3 py-2">
      <input
        className="min-w-0 flex-1 rounded bg-neutral-800 px-3 py-1.5 text-sm outline-none placeholder:text-neutral-500 focus:ring-1 focus:ring-neutral-600 disabled:opacity-50"
        placeholder={dead ? "agent exited — resume to continue" : "prompt the agent… (Enter)"}
        value={text}
        disabled={dead}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      {streaming ? (
        <button
          className="shrink-0 rounded bg-red-900/60 px-3 py-1.5 text-xs text-red-200 hover:bg-red-800"
          onClick={() => void rpcCommand(tabId, { type: "abort" }).catch(() => {})}
        >
          abort
        </button>
      ) : (
        <button
          className="shrink-0 rounded bg-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-600 disabled:opacity-40"
          disabled={!text.trim() || dead}
          onClick={send}
        >
          send
        </button>
      )}
    </div>
  );
}
