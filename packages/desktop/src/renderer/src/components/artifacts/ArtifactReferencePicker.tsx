import { useId, useState } from "react";
import type { ArtifactDescription } from "@omp-ui/core/artifacts";
import { backend, displayMessage } from "../../backend";
import { useStore } from "../../store";
import { useT } from "../../lib/i18n";
import { Button, IconButton, IconClose, Modal, Switch } from "../ui";
import { getNavigationGeneration } from "../../store/slices/view";

export function ArtifactReferencePicker({ description, mode = "reference", onClose }: { description: ArtifactDescription; mode?: "reference" | "refresh"; onClose(): void }) {
  const t = useT();
  const titleId = useId();
  const state = useStore((s) => s.state);
  const [target, setTarget] = useState("");
  const [includeData, setIncludeData] = useState(false);
  const [datasetIds, setDatasetIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessions = [...(state?.chats ?? []), ...(state?.projects.flatMap((group) => group.sessions) ?? [])].filter((session) => session.mode === "rpc-ui" && session.live !== "missing");
  const origin = description.artifact.originContext;
  const originProjects = origin.kind === "project" ? state?.projects.filter(group => group.project.path === origin.path) ?? [] : [];
  const submit = async (): Promise<void> => {
    setBusy(true); setError(null);
    const navigationGeneration = getNavigationGeneration();
    try {
      const store = useStore.getState();
      let tabId: string | null = target;
      if (mode === "refresh" && target === "new:chat") tabId = await store.newChat({ background: true });
      else if (mode === "refresh" && target.startsWith("new:project:")) tabId = await store.newSession(target.slice(12), "rpc-ui", null, { background: true });
      if (!tabId) throw new Error(t("artifacts.noTarget"));
      const exact = { targetTabId: tabId, artifactId: description.artifact.artifactId, codeRevisionId: description.code.codeRevisionId, dataSnapshotId: description.snapshot.dataSnapshotId };
      if (mode === "refresh") {
        const prepared = await backend.artifactPrepareRefresh({ ...exact, datasetIds });
        if (!await store.referenceArtifactInSession(tabId, prepared.reference, prepared.text, { navigationGeneration })) return;
      } else {
        const reference = await backend.artifactReference({ ...exact, includeData });
        if (!await store.referenceArtifactInSession(tabId, reference, undefined, { navigationGeneration })) return;
      }
      onClose();
    } catch (reason) { setError(displayMessage(reason)); }
    finally { setBusy(false); }
  };
  return <Modal onClose={() => { if (!busy) onClose(); }} labelledBy={titleId} width="w-[min(34rem,96vw)]" className="flex max-h-[90dvh] flex-col">
    <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3"><h2 id={titleId} className="min-w-0 flex-1 text-base font-semibold">{t(mode === "refresh" ? "artifacts.refresh" : "artifacts.reference")}</h2><IconButton label={t("common.overlay.close")} onClick={onClose} disabled={busy}><IconClose /></IconButton></header>
    <div className="min-h-0 space-y-4 overflow-y-auto p-4">
      <p className="break-words text-sm text-ink-mid">{description.artifact.title}</p>
      <label className="block space-y-1 text-sm"><span>{t("artifacts.targetSession")}</span><select autoFocus className="block w-full min-w-0 rounded border border-line bg-raised p-2" value={target} onChange={(event) => setTarget(event.target.value)} disabled={busy}><option value="">{t("artifacts.chooseSession")}</option>{sessions.map((session) => <option key={session.tabId} value={session.tabId}>{session.title || session.tabId}</option>)}{mode === "refresh" && <><option value="new:chat">{t("artifacts.newChat")}</option>{originProjects.map((group) => <option key={group.project.path} value={`new:project:${group.project.path}`}>{t("artifacts.newSession", { project: group.project.name })}</option>)}</>}</select></label>
      {mode === "reference" ? <><div className="flex items-center justify-between gap-3 text-sm"><span>{t("artifacts.includeData")}</span><Switch on={includeData} onChange={setIncludeData} label={t("artifacts.includeData")} /></div><p className="text-sm text-ink-dim">{t("artifacts.consentWarning")}</p></> : <><fieldset className="space-y-2"><legend className="mb-2 text-sm font-semibold">{t("artifacts.chooseDatasets")}</legend>{description.snapshot.datasets.map((dataset) => <label key={dataset.id} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={datasetIds.includes(dataset.id)} onChange={(event) => setDatasetIds((old) => event.target.checked ? [...old, dataset.id] : old.filter((id) => id !== dataset.id))} /><span className="min-w-0 break-words">{dataset.title}</span></label>)}</fieldset><p className="text-sm text-ink-dim">{t("artifacts.refreshHint")}</p></>}
      {error && <p role="alert" className="text-sm text-rose">{error}</p>}
    </div>
    <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line p-3"><Button onClick={onClose} disabled={busy}>{t("artifacts.cancel")}</Button><Button variant="solid" disabled={busy || !target || (mode === "refresh" && datasetIds.length === 0)} onClick={() => void submit()}>{t(busy ? "artifacts.loading" : "artifacts.addToDraft")}</Button></footer>
  </Modal>;
}
