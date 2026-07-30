import { strField } from "../lib/fields";
import { useStore } from "../store";

function modelKey(m: unknown): string | null {
  const provider = strField(m, "provider");
  const modelId = strField(m, "modelId") ?? strField(m, "id");
  return provider && modelId ? `${provider}/${modelId}` : null;
}

export function ModelSelector({ tabId }: { tabId: string }) {
  const rpc = useStore((s) => s.rpc[tabId]);
  const rpcCommand = useStore((s) => s.rpcCommand);
  const models = rpc?.availableModels ?? [];
  const current = modelKey(rpc?.model);

  if (models.length === 0) {
    return <span className="text-[11px] text-neutral-500">{current ?? "no models"}</span>;
  }

  return (
    <select
      className="max-w-56 rounded bg-neutral-800 px-1.5 py-0.5 text-[11px]"
      value={current ?? ""}
      onChange={(e) => {
        const selected = models.find((m) => modelKey(m) === e.target.value);
        const provider = strField(selected, "provider");
        const modelId = strField(selected, "modelId") ?? strField(selected, "id");
        if (!provider || !modelId) return;
        rpcCommand(tabId, { type: "set_model", provider, modelId }).catch(() => {});
      }}
    >
      {!current && <option value="">—</option>}
      {models.map((m) => {
        const key = modelKey(m);
        if (!key) return null;
        const label = strField(m, "name") ?? key;
        return (
          <option key={key} value={key}>
            {label}
          </option>
        );
      })}
    </select>
  );
}
