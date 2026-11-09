import type { ArtifactReference, DraftArtifactReference } from "@omp-ui/core/artifacts";
import { withArtifactReferenceContext } from "@omp-ui/core/artifact-references";
import { t } from "../../lib/i18n";
import { backendFor } from "../../backend";
import { findOwner, getNavigationGeneration } from "./view";
import type { GetState, SetState } from "./shared";

export interface ArtifactReferencesSlice {
  artifactDrafts: Record<string, DraftArtifactReference[]>;
  artifactDraftText: Record<string, string[]>;
  attachArtifactReference(tabId: string, reference: DraftArtifactReference, suggestedText?: string): boolean;
  canRestoreArtifactReferences(tabId: string, references: readonly DraftArtifactReference[]): boolean;
  restoreArtifactReferences(tabId: string, references: readonly DraftArtifactReference[]): boolean;
  beginArtifactReferenceMove(sourceTabId: string, targetTabId: string): (() => void) | null;
  removeArtifactReference(tabId: string, referenceId: string): void;
  clearArtifactReferences(tabId: string, submitted?: readonly ArtifactReference[]): void;
  drainArtifactDraftText(tabId: string): string[];
  referenceArtifactInSession(tabId: string, reference: ArtifactReference, suggestedText?: string, options?: { navigationGeneration?: number }): Promise<boolean>;
}

/** Draft grants are independent of rpc slots: resume/restart cannot erase consent chips. */
export function createArtifactReferencesSlice(set: SetState, get: GetState): ArtifactReferencesSlice {
  const movingDrafts = new Map<string, string>();
  return {
    artifactDrafts: {},
    artifactDraftText: {},
    attachArtifactReference(tabId, reference, suggestedText) {
      const movedTo = movingDrafts.get(tabId);
      if (movedTo !== undefined) return get().attachArtifactReference(movedTo, reference, suggestedText);
      const owner = findOwner(get().state, tabId);
      const tab = get().tabs.find(candidate => candidate.tabId === tabId);
      if ((owner?.record.mode ?? tab?.mode) !== "rpc-ui") return false;
      if (reference.instanceId !== (owner?.instanceId ?? tab?.instanceId ?? null)) {
        const message = t("artifacts.reference.wrongMachine", { machine: reference.machine });
        if (get().rpc[tabId] !== undefined) get().appendNotice(tabId, message, "warn");
        else get().reportError(message);
        return false;
      }
      const current = get().artifactDrafts[tabId] ?? [];
      // A newly prepared refresh is bound to its exact grant. Replace the old
      // descriptor with the incoming grant, never widen consent on the old ID.
      const next: DraftArtifactReference[] = [];
      let replaced = false;
      for (const ref of current) {
        if (ref.ownerInstanceId === reference.ownerInstanceId && ref.artifactId === reference.artifactId && ref.codeRevisionId === reference.codeRevisionId && ref.dataSnapshotId === reference.dataSnapshotId) {
          if (!replaced) next.push(reference);
          replaced = true;
        } else next.push(ref);
      }
      if (!replaced) next.push(reference);
      try { withArtifactReferenceContext("", next); }
      catch (error) { get().reportError(error); return false; }
      set(state => ({
        artifactDrafts: { ...state.artifactDrafts, [tabId]: next },
        ...(suggestedText?.trim() ? { artifactDraftText: { ...state.artifactDraftText, [tabId]: [...(state.artifactDraftText[tabId] ?? []), suggestedText] } } : {}),
      }));
      return true;
    },
    canRestoreArtifactReferences(tabId, references) {
      const movedTo = movingDrafts.get(tabId);
      if (movedTo !== undefined) return get().canRestoreArtifactReferences(movedTo, references);
      const owner = findOwner(get().state, tabId);
      const tab = get().tabs.find(candidate => candidate.tabId === tabId);
      const instanceId = owner !== undefined ? owner.instanceId : tab?.instanceId ?? null;
      if ((owner?.record.mode ?? tab?.mode) !== "rpc-ui" || references.some(ref => ref.instanceId !== instanceId)) return false;
      const next = [...(get().artifactDrafts[tabId] ?? [])];
      for (const reference of references) if (!next.some(ref => ref.referenceId === reference.referenceId)) next.push(reference);
      try { withArtifactReferenceContext("", next); return true; }
      catch (error) { get().reportError(error); return false; }
    },
    restoreArtifactReferences(tabId, references) {
      const movedTo = movingDrafts.get(tabId);
      if (movedTo !== undefined) return get().restoreArtifactReferences(movedTo, references);
      const owner = findOwner(get().state, tabId);
      const tab = get().tabs.find(candidate => candidate.tabId === tabId);
      const instanceId = owner !== undefined ? owner.instanceId : tab?.instanceId ?? null;
      if ((owner?.record.mode ?? tab?.mode) !== "rpc-ui" || references.some(ref => ref.instanceId !== instanceId)) return false;
      try { for (const reference of references) withArtifactReferenceContext("", [reference]); }
      catch (error) { get().reportError(error); return false; }
      const next = [...(get().artifactDrafts[tabId] ?? [])];
      for (const reference of references) if (!next.some(ref => ref.referenceId === reference.referenceId)) next.push(reference);
      // Destructive/unsolicited queue restores cannot discard overflow. Keep
      // every exact grant as a visible removable chip; wire sends stay bounded.
      set(state => ({ artifactDrafts: { ...state.artifactDrafts, [tabId]: next } }));
      try { withArtifactReferenceContext("", next); }
      catch (error) { get().reportError(error); }
      return true;
    },
    beginArtifactReferenceMove(sourceTabId, targetTabId) {
      if (movingDrafts.has(sourceTabId) || movingDrafts.has(targetTabId)) return null;
      const references = get().artifactDrafts[sourceTabId] ?? [];
      const owner = findOwner(get().state, targetTabId);
      const tab = get().tabs.find(candidate => candidate.tabId === targetTabId);
      const instanceId = owner !== undefined ? owner.instanceId : tab?.instanceId ?? null;
      const foreign = references.find(ref => ref.instanceId !== instanceId);
      if (foreign !== undefined) {
        get().appendNotice(sourceTabId, t("artifacts.reference.wrongMachine", { machine: foreign.machine }), "warn");
        return null;
      }
      movingDrafts.set(sourceTabId, targetTabId);
      if (!get().restoreArtifactReferences(targetTabId, references)) { movingDrafts.delete(sourceTabId); return null; }
      const pendingText = get().artifactDraftText[sourceTabId] ?? [];
      if (pendingText.length > 0) set(state => {
        const artifactDraftText = { ...state.artifactDraftText, [targetTabId]: [...(state.artifactDraftText[targetTabId] ?? []), ...pendingText] };
        delete artifactDraftText[sourceTabId];
        return { artifactDraftText };
      });
      return () => { if (movingDrafts.get(sourceTabId) === targetTabId) movingDrafts.delete(sourceTabId); };
    },
    removeArtifactReference(tabId, referenceId) {
      set(state => ({ artifactDrafts: { ...state.artifactDrafts, [tabId]: (state.artifactDrafts[tabId] ?? []).filter(ref => ref.referenceId !== referenceId) } }));
    },
    clearArtifactReferences(tabId, submitted) {
      set(state => {
        const artifactDrafts = { ...state.artifactDrafts };
        if (submitted === undefined) {
          delete artifactDrafts[tabId];
          const artifactDraftText = { ...state.artifactDraftText };
          delete artifactDraftText[tabId];
          return { artifactDrafts, artifactDraftText };
        }
        else {
          const ids = new Set(submitted.map(ref => ref.referenceId));
          artifactDrafts[tabId] = (artifactDrafts[tabId] ?? []).filter(ref => !ids.has(ref.referenceId));
        }
        return { artifactDrafts };
      });
    },
    drainArtifactDraftText(tabId) {
      const text = get().artifactDraftText[tabId] ?? [];
      if (text.length) set(state => { const pending = { ...state.artifactDraftText }; delete pending[tabId]; return { artifactDraftText: pending }; });
      return text;
    },
    async referenceArtifactInSession(tabId, reference, suggestedText, options) {
      const owner = findOwner(get().state, tabId);
      if (owner === undefined || owner.record.mode !== "rpc-ui") return false;
      const navigation = options?.navigationGeneration ?? getNavigationGeneration();
      try {
        const identity = await backendFor(owner.instanceId).getInstanceIdentity();
        const current = findOwner(get().state, tabId);
        if (current === undefined || current.instanceId !== owner.instanceId || current.record.mode !== "rpc-ui") return false;
        const movedTo = movingDrafts.get(tabId);
        if (movedTo !== undefined) return get().referenceArtifactInSession(movedTo, reference, suggestedText, options);
        if (identity.instanceId !== reference.ownerInstanceId) {
          const message = t("artifacts.reference.wrongMachine", { machine: reference.machine });
          if (get().rpc[tabId] !== undefined) get().appendNotice(tabId, message, "warn");
          else get().reportError(message);
          return false;
        }
        if (!get().attachArtifactReference(tabId, { ...reference, instanceId: owner.instanceId }, suggestedText)) return false;
        await get().openSession(tabId, { activate: false });
        const landed = findOwner(get().state, tabId);
        if (landed === undefined || landed.instanceId !== owner.instanceId) return false;
        if (getNavigationGeneration() === navigation && get().tabs.some(tab => tab.tabId === tabId)) get().focusTab(tabId);
        else get().reportNotice(t("artifacts.reference.attached", {title: landed.record.title || tabId}));
        return true;
      } catch (error) { get().reportError(error); return false; }
    },
  };
}
