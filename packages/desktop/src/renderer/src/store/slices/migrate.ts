// Session migration over the bundle-transfer channels (issue #888). The pack
// and ingest legs are omp's own CLI on each host; this slice is the relay:
// every chunk that arrives from the source is forwarded to the target before
// the next is requested, so neither side ever holds the full bundle. Bytes may
// ride the renderer here because transcript content already is renderer-
// visible (ADR-0028) — credential bundles never take this path.
import { t } from "../../lib/i18n";
import { backendFor } from "../../backend";
import type { UiStore } from "../types";
import { findInstance, findOwner } from "./view";
import type { GetState, SetState } from "./shared";

export type MigrateSlice = Pick<
  UiStore,
  "migrating" | "migrationProgress" | "migrateSession"
>;

export function createMigrateSlice(set: SetState, get: GetState): MigrateSlice {
  /** In-flight migrations by tabId; membership is the single-flight guard. */
  const inFlight = new Set<string>();

  return {
    migrating: {},
    migrationProgress: {},

    async migrateSession(tabId, targetInstanceId, targetCwd) {
      if (inFlight.has(tabId)) return;
      inFlight.add(tabId);
      const setPhase = (phase: UiStore["migrating"][string] | null): void => {
        const migrating = { ...get().migrating };
        const migrationProgress = { ...get().migrationProgress };
        if (phase === null) {
          delete migrating[tabId];
          delete migrationProgress[tabId];
        } else {
          migrating[tabId] = phase;
          migrationProgress[tabId] ??= 0;
        }
        set({ migrating, migrationProgress });
      };

      const owner = findOwner(get().state, tabId);
      if (owner === undefined) {
        inFlight.delete(tabId);
        get().reportError(new Error(t("notice.migrate.failed", { message: "session not found" })));
        return;
      }
      const source = backendFor(owner.instanceId);
      const target = backendFor(targetInstanceId);
      let packId: string | null = null;
      try {
        setPhase("packing");
        const packed = await source.packStart(tabId);
        if (!packed.ok) throw new Error(packed.message);
        packId = packed.packId;
        if (packed.missingBlobs > 0) {
          // Images that GC already pruned will not load after unpack — a
          // warning, never a blocker.
          get().reportNotice(t("notice.migrate.missingBlobs", { count: packed.missingBlobs }));
        }

        const transferId = await target.ingestStart();
        let index = 0;
        let sent = 0;
        while (sent < packed.sizeBytes) {
          const chunk = await source.packChunk(packId, index);
          if (chunk === "") break; // past the end: the transfer is complete
          // Base64-decoded length: floor(3/4 of the payload, ignoring padding.
          sent += (chunk.length * 3) >>> 2;
          setPhase("transferring");
          const progress = {
            ...get().migrationProgress,
            [tabId]: Math.min(100, Math.round((sent / Math.max(packed.sizeBytes, 1)) * 100)),
          };
          set({ migrationProgress: progress });
          await target.ingestPush(transferId, chunk);
          index += 1;
        }
        // The source bundle has served its purpose: release it now rather
        // than waiting for the idle sweep. Past this point the bytes live on
        // the target, so the abort path no longer applies.
        await source.packAbort(packId).catch(() => undefined);
        packId = null;

        setPhase("finishing");
        const finished = await target.ingestFinish(transferId, targetCwd);
        if (!finished.ok) throw new Error(finished.message);

        // The target's state broadcast may not have landed yet; the source
        // record carries the same title, so the notice never reads empty.
        const title =
          findOwner(get().state, finished.tabId)?.record.cachedTitle ??
          findOwner(get().state, tabId)?.record.cachedTitle ??
          null;
        get().reportNotice(t("notice.migrate.done", { title: title ?? "" }));

        // Mark the source copy stale via omp's own moved-guard. A failure is
        // warn-only: the migration succeeded, and omp's fork-on-resume keeps
        // the stale copy from silently diverging. `mark-moved` runs only in
        // the acting app's main, so a remote source cannot answer it — the
        // warning then says so verbatim (ADR-0028's per-call skew rule).
        const targetLabel =
          targetInstanceId === null
            ? t("dialog.migrate.local")
            : (findInstance(get().state, targetInstanceId)?.nickname ?? targetInstanceId);
        const marked = await source.markSessionMoved(tabId, targetLabel);
        if (!marked.ok) {
          get().reportNotice(t("notice.migrate.markMoved", { message: marked.message }));
        }
      } catch (err) {
        // Best-effort source cleanup; a half-pushed target bundle expires via
        // its idle sweep (no channel can name a transfer we never finished).
        if (packId !== null) await source.packAbort(packId).catch(() => undefined);
        get().reportError(new Error(err instanceof Error ? err.message : String(err)));
      } finally {
        inFlight.delete(tabId);
        setPhase(null);
      }
    },
  };
}
