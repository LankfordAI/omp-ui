import type { ArtifactRefreshEntry, ArtifactReference, DraftArtifactReference } from "@omp-ui/core/artifacts";
import { withArtifactRefreshContext, withArtifactReferenceContext } from "@omp-ui/core/artifact-references";
import { t } from "../../lib/i18n";
import { backendFor } from "../../backend";
import { findOwner, getNavigationGeneration } from "./view";
import type { GetState, SetState } from "./shared";

export interface ArtifactReferencesSlice {
  artifactDrafts: Record<string, DraftArtifactReference[]>;
  /** Refresh requests awaiting send, per tab (ADR-0092) — chips, never prose. */
  artifactRefreshDrafts: Record<string, ArtifactRefreshEntry[]>;
  attachArtifactReference(tabId: string, reference: DraftArtifactReference): boolean;
  canRestoreArtifactReferences(tabId: string, references: readonly DraftArtifactReference[]): boolean;
  restoreArtifactReferences(tabId: string, references: readonly DraftArtifactReference[]): boolean;
  beginArtifactReferenceMove(sourceTabId: string, targetTabId: string): (() => void) | null;
  removeArtifactReference(tabId: string, referenceId: string): void;
  /** Position-preserving swap of one draft grant for a freshly minted one (consent toggle). */
  replaceArtifactReference(tabId: string, oldReferenceId: string, next: DraftArtifactReference): void;
  clearArtifactReferences(tabId: string, submitted?: readonly ArtifactReference[]): void;
  attachArtifactRefresh(tabId: string, entry: ArtifactRefreshEntry): boolean;
  attachArtifactRefreshDraft(tabId: string, reference: ArtifactReference, entry: ArtifactRefreshEntry, options?: { navigationGeneration?: number }): Promise<boolean>;
  removeArtifactRefresh(tabId: string, refreshRequestId: string): void;
  clearArtifactRefreshes(tabId: string, submitted?: readonly ArtifactRefreshEntry[]): void;
  restoreArtifactRefreshes(tabId: string, entries: readonly ArtifactRefreshEntry[]): boolean;
  referenceArtifactInSession(tabId: string, reference: ArtifactReference, options?: { navigationGeneration?: number }): Promise<boolean>;
}

/** Draft grants are independent of rpc slots: resume/restart cannot erase consent chips. */
export function createArtifactReferencesSlice(set: SetState, get: GetState): ArtifactReferencesSlice {
  const movingDrafts = new Map<string, string>();
  return {
    artifactDrafts: {},
    artifactRefreshDrafts: {},
    attachArtifactReference(tabId, reference) {
      const movedTo = movingDrafts.get(tabId);
      if (movedTo !== undefined) return get().attachArtifactReference(movedTo, reference);
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
      set(state => ({ artifactDrafts: { ...state.artifactDrafts, [tabId]: next } }));
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
      // A refresh request is bound to the session it was prepared against
      // (ADR-0092): a move cannot carry it, so the source's entries die with
      // it. The caller posts `artifacts.refreshMovedDropped` on the new tab.
      set(state => {
        const artifactRefreshDrafts = { ...state.artifactRefreshDrafts };
        delete artifactRefreshDrafts[sourceTabId];
        return { artifactRefreshDrafts };
      });
      return () => { if (movingDrafts.get(sourceTabId) === targetTabId) movingDrafts.delete(sourceTabId); };
    },
    removeArtifactReference(tabId, referenceId) {
      set(state => ({ artifactDrafts: { ...state.artifactDrafts, [tabId]: (state.artifactDrafts[tabId] ?? []).filter(ref => ref.referenceId !== referenceId) } }));
    },
    replaceArtifactReference(tabId, oldReferenceId, next) {
      set(state => ({ artifactDrafts: { ...state.artifactDrafts, [tabId]: (state.artifactDrafts[tabId] ?? []).map(ref => ref.referenceId === oldReferenceId ? next : ref) } }));
    },
    clearArtifactReferences(tabId, submitted) {
      set(state => {
        const artifactDrafts = { ...state.artifactDrafts };
        if (submitted === undefined) {
          delete artifactDrafts[tabId];
          return { artifactDrafts };
        }
        else {
          const ids = new Set(submitted.map(ref => ref.referenceId));
          artifactDrafts[tabId] = (artifactDrafts[tabId] ?? []).filter(ref => !ids.has(ref.referenceId));
        }
        return { artifactDrafts };
      });
    },
    attachArtifactRefresh(tabId, entry) {
      const movedTo = movingDrafts.get(tabId);
      if (movedTo !== undefined) return get().attachArtifactRefresh(movedTo, entry);
      const owner = findOwner(get().state, tabId);
      const tab = get().tabs.find(candidate => candidate.tabId === tabId);
      if ((owner?.record.mode ?? tab?.mode) !== "rpc-ui") return false;
      const current = get().artifactRefreshDrafts[tabId] ?? [];
      // One request per artifact: a second picker click re-prepares the same
      // chip (the newer request is the bound one), never stacks two sends for
      // one artifact. Load-bearing — refusing would make the chip unsendable.
      const next: ArtifactRefreshEntry[] = [];
      let replaced = false;
      for (const refresh of current) {
        if (refresh.artifactId === entry.artifactId) {
          if (!replaced) next.push(entry);
          replaced = true;
        } else next.push(refresh);
      }
      if (!replaced) next.push(entry);
      try { withArtifactRefreshContext("", next); }
      catch (error) { get().reportError(error); return false; }
      set(state => ({ artifactRefreshDrafts: { ...state.artifactRefreshDrafts, [tabId]: next } }));
      return true;
    },
    async attachArtifactRefreshDraft(tabId, reference, entry, options) {
      // Validate the request before binding anything: a bad entry must leave
      // the tab exactly as it was — grant included.
      try { withArtifactRefreshContext("", [entry]); }
      catch (error) { get().reportError(error); return false; }
      if (!await get().referenceArtifactInSession(tabId, reference, options)) return false;
      return get().attachArtifactRefresh(tabId, entry);
    },
    removeArtifactRefresh(tabId, refreshRequestId) {
      set(state => ({ artifactRefreshDrafts: { ...state.artifactRefreshDrafts, [tabId]: (state.artifactRefreshDrafts[tabId] ?? []).filter(refresh => refresh.refreshRequestId !== refreshRequestId) } }));
    },
    clearArtifactRefreshes(tabId, submitted) {
      set(state => {
        const artifactRefreshDrafts = { ...state.artifactRefreshDrafts };
        if (submitted === undefined) {
          delete artifactRefreshDrafts[tabId];
          return { artifactRefreshDrafts };
        }
        else {
          const ids = new Set(submitted.map(refresh => refresh.refreshRequestId));
          artifactRefreshDrafts[tabId] = (artifactRefreshDrafts[tabId] ?? []).filter(refresh => !ids.has(refresh.refreshRequestId));
        }
        return { artifactRefreshDrafts };
      });
    },
    restoreArtifactRefreshes(tabId, entries) {
      // Nothing to withdraw is nothing to restore: no chip key springs into
      // being for a prompt that carried no request.
      if (entries.length === 0) return true;
      const movedTo = movingDrafts.get(tabId);
      if (movedTo !== undefined) return get().restoreArtifactRefreshes(movedTo, entries);
      const owner = findOwner(get().state, tabId);
      const tab = get().tabs.find(candidate => candidate.tabId === tabId);
      if ((owner?.record.mode ?? tab?.mode) !== "rpc-ui") return false;
      try { for (const entry of entries) withArtifactRefreshContext("", [entry]); }
      catch (error) { get().reportError(error); return false; }
      const next = [...(get().artifactRefreshDrafts[tabId] ?? [])];
      for (const entry of entries) if (!next.some(refresh => refresh.refreshRequestId === entry.refreshRequestId)) next.push(entry);
      // Like grants, a withdrawn request comes back as a removable chip even
      // past the send limit; an over-limit wire is refused at send, not here.
      set(state => ({ artifactRefreshDrafts: { ...state.artifactRefreshDrafts, [tabId]: next } }));
      try { withArtifactRefreshContext("", next); }
      catch (error) { get().reportError(error); }
      return true;
    },
    async referenceArtifactInSession(tabId, reference, options) {
      const owner = findOwner(get().state, tabId);
      if (owner === undefined || owner.record.mode !== "rpc-ui") return false;
      const navigation = options?.navigationGeneration ?? getNavigationGeneration();
      try {
        const identity = await backendFor(owner.instanceId).getInstanceIdentity();
        const current = findOwner(get().state, tabId);
        if (current === undefined || current.instanceId !== owner.instanceId || current.record.mode !== "rpc-ui") return false;
        const movedTo = movingDrafts.get(tabId);
        if (movedTo !== undefined) return get().referenceArtifactInSession(movedTo, reference, options);
        if (identity.instanceId !== reference.ownerInstanceId) {
          const message = t("artifacts.reference.wrongMachine", { machine: reference.machine });
          if (get().rpc[tabId] !== undefined) get().appendNotice(tabId, message, "warn");
          else get().reportError(message);
          return false;
        }
        if (!get().attachArtifactReference(tabId, { ...reference, instanceId: owner.instanceId })) return false;
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
