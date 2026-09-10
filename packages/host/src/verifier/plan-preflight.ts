import * as path from "node:path";
import {
  encodePlanPreflightReply,
  isHtmlPlanPath,
  normalizeControlFrame,
  parsePlanReviewTitle,
  PLAN_REVIEW_SENTINEL,
  type OwnedSessionRecord,
  type PlanDiagnostic,
  type PlanPreflightResult,
  type PlanRenderResult,
  type Registry,
  type RpcFrame,
  type FrameObserver,
} from "@omp-ui/core";
import type { ConfinedPlanRead } from "./plan-file";
import type { LiveEntry, RpcLiveEntry } from "../session/live-entry";

/**
 * The main-owned plan preflight gate (issue #312 follow-up, §5). An HTML
 * `PLAN_REVIEW_SENTINEL` select is CLAIMED at the `onFrame` edge — before
 * frame observers and before the client broadcast — so no pendingPlan, no
 * transcript plan card, no generic extension dialog, no notification, and no
 * awaiting-user badge can exist while validation runs. Markdown and all
 * other traffic flow untouched.
 *
 * On success the authored snapshot and its hash are retained HERE (main's),
 * the review request is enriched with a main-authored `sourceHash`, and the
 * request is delivered exactly once through the original observer/fan-out
 * path. On failure or unavailability the originating live entry gets the
 * documented string-valued response
 * `PLAN_PREFLIGHT_RESULT_PREFIX + JSON` and nothing reaches any client — the
 * generated extension turns that into the repair tool result.
 *
 * Keyed by live-entry identity + tabId + frameId; a late completion from a
 * replaced generation is dropped, and an aborted proposal can never surface
 * later. The held latch is consulted by `awaitingHumanAnswer` so the stall
 * watchdog, hibernation, and tool-mutation guards all respect preflight
 * without publishing a human-answer state.
 */

export interface HeldPlanProposal {
  tabId: string;
  frameId: string;
  entry: RpcLiveEntry;
  record: OwnedSessionRecord;
  /** The claimed request frame, kept for byte-faithful re-delivery. */
  originalFrame: RpcFrame;
  planFilePath: string;
  planAbsPath: string;
  controller: AbortController;
  settled: boolean;
}

export interface PlanPreflightDeps {
  registry: Registry;
  getSessionsRoot: () => string;
  /** The confined reader (shared with ordinary plan reads). */
  readPlanFile: (root: string, absPath: string) => Promise<ConfinedPlanRead>;
  /** The main verifier service. */
  verify: (html: string, themeId: string, signal: AbortSignal) => Promise<PlanRenderResult>;
  getThemeId: () => string;
  /** Private response path: straight to THIS live entry's child. */
  sendToLive: (entry: RpcLiveEntry, frame: RpcFrame) => void;
  /** Deliver a (title-enriched) frame through the ORIGINAL fan-out. */
  deliver: (tabId: string, frame: RpcFrame, entry: RpcLiveEntry) => void;
  /** Called when a hold ends internally so the stall clock can rebase. */
  onHoldReleased: (tabId: string) => void;
}

interface Snapshot {
  text: string;
  sourceHash: string;
  planAbsPath: string;
}

export class PlanPreflightController implements FrameObserver<LiveEntry> {
  private readonly held = new Map<string, HeldPlanProposal>();
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(private readonly deps: PlanPreflightDeps) {}

  /* ------------------------------ observation ----------------------------- */

  onFrame(): void {
    // Claiming happens in SessionManager.spawnRpc's onFrame (before the
    // observer list runs); this observer exists only for lifecycle cleanup.
  }

  onExit(tabId: string): void {
    this.clear(tabId);
  }

  dispose(tabId: string): void {
    this.clear(tabId);
  }

  /* -------------------------------- claims -------------------------------- */

  /**
   * True when the frame was claimed: an HTML plan select (or a malformed
   * plan-sentinel request, which fails closed rather than falling through to
   * the generic dialog). The CALLER must suppress observer fan-out and the
   * client broadcast for a claimed frame. Non-plan and markdown frames always
   * return false.
   */
  claimFrame(tabId: string, frame: RpcFrame, entry: RpcLiveEntry): boolean {
    const control = normalizeControlFrame(frame);
    if (control === null || control.kind !== "ext_request" || control.method !== "select") {
      return false;
    }
    const title = typeof control.frame.title === "string" ? control.frame.title : undefined;
    if (title === undefined || !title.startsWith(PLAN_REVIEW_SENTINEL)) return false;
    const frameId = typeof control.id === "string" ? control.id : "";
    const review = parsePlanReviewTitle(title);
    if (review === null) {
      // A plan sentinel that does not parse fails CLOSED with an application
      // diagnostic; it must never surface as a generic dialog.
      this.respond(entry, frameId, "unknown", {
        status: "unavailable",
        sourceHash: null,
        diagnostics: [
          {
            code: "RENDER_INVARIANT",
            stage: "service",
            repair: "application",
            severity: "error",
            message: "the plan-review request was malformed and could not be gated",
          },
        ],
      });
      return true;
    }
    if (!isHtmlPlanPath(review.planFilePath)) return false; // markdown: unchanged path

    // One concurrent proposal per live session (§4): an additional request
    // from the SAME generation is refused without replacing the held one.
    const existing = this.held.get(tabId);
    if (existing !== undefined && existing.entry === entry) {
      this.respond(entry, frameId, review.planFilePath, {
        status: "unavailable",
        sourceHash: null,
        diagnostics: [
          {
            code: "VERIFIER_UNAVAILABLE",
            stage: "service",
            repair: "application",
            severity: "error",
            message: "another proposal from this session is already being verified",
          },
        ],
      });
      return true;
    }
    // A proposal from a NEW generation replaces the old held request.
    if (existing !== undefined) this.abortHeld(existing);
    // The previous cycle's snapshot is gone the moment a new claim exists.
    this.snapshots.delete(tabId);

    const planAbsPath = review.planAbsPath;
    if (planAbsPath === null) {
      this.respond(entry, frameId, review.planFilePath, {
        status: "failed",
        sourceHash: null,
        diagnostics: [
          {
            code: "PLAN_READ_FAILED",
            stage: "service",
            repair: "source",
            severity: "error",
            message: "the proposal named no absolute artifact path",
          },
        ],
      });
      return true;
    }

    const controller = new AbortController();
    const held: HeldPlanProposal = {
      tabId,
      frameId,
      entry,
      record: entry.record,
      originalFrame: frame,
      planFilePath: review.planFilePath,
      planAbsPath,
      controller,
      settled: false,
    };
    this.held.set(tabId, held);
    void this.process(held, review.title);
    return true;
  }

  /** True while a plan select from this tab is held mid-validation. */
  isHeld(tabId: string): boolean {
    return this.held.has(tabId);
  }

  /** True when `frameId` is a frame this controller currently holds (§6). */
  holdsFrame(tabId: string, frameId: string): boolean {
    return this.held.get(tabId)?.frameId === frameId;
  }

  /**
   * The validated snapshot while an HTML gate for `absPath` is pending (§5.4)
   * — presentation reads what validation read, never freshly changed bytes.
   * While a NEW validation is mid-flight the snapshot is gone (there is no
   * gate yet), so ordinary reads stay honest.
   */
  snapshotFor(tabId: string, absPath: string): Snapshot | null {
    if (this.held.has(tabId)) return null;
    const snapshot = this.snapshots.get(tabId);
    if (snapshot !== undefined && snapshot.planAbsPath === path.resolve(absPath)) return snapshot;
    return null;
  }

  /** Cancel any held proposal; a late completion cannot revive it. */
  clear(tabId: string): void {
    const held = this.held.get(tabId);
    this.snapshots.delete(tabId);
    if (held === undefined) return;
    this.abortHeld(held);
    this.deps.onHoldReleased(tabId);
  }

  /** Cancel every held proposal (process teardown / killAll). */
  clearAll(): void {
    for (const tabId of [...this.held.keys()]) this.clear(tabId);
  }

  /** Drop a snapshot without touching a held proposal (post-settlement). */
  clearSnapshot(tabId: string): void {
    this.snapshots.delete(tabId);
  }

  /* ------------------------------- pipeline ------------------------------- */

  private async process(held: HeldPlanProposal, title: string): Promise<void> {
    const root = path.resolve(this.deps.getSessionsRoot(), held.record.lineageDir);
    const read = await this.deps.readPlanFile(root, held.planAbsPath);
    if (this.isStale(held)) return;
    if (!read.ok) {
      this.fail(
        held,
        {
          code: "PLAN_READ_FAILED",
          stage: "service",
          repair: read.reason === "outside" ? "application" : "source",
          severity: "error",
          message:
            read.reason === "over-limit"
              ? "the plan artifact exceeds the byte limit the verifier may read"
              : read.reason === "outside"
                ? "the plan artifact resolves outside the session's lineage dir"
                : "the plan artifact could not be read — write the plan file before proposing",
          detail: `reason=${read.reason}`,
        },
        "failed",
      );
      return;
    }
    // Artifact identity: the requested absolute path's basename must be the
    // slug the proposal named (the extension derives one from the other).
    const named = held.planFilePath.split("/").pop() ?? "";
    if (named !== "" && named.toLowerCase() !== path.basename(held.planAbsPath).toLowerCase()) {
      this.fail(
        held,
        {
          code: "PLAN_READ_FAILED",
          stage: "service",
          repair: "application",
          severity: "error",
          message: "the artifact identity does not match the proposed plan slug",
          detail: `${named} vs ${path.basename(held.planAbsPath)}`,
        },
        "failed",
      );
      return;
    }

    const rendered = await this.deps.verify(read.text, this.deps.getThemeId(), held.controller.signal);
    if (this.isStale(held)) return;
    if (rendered.status === "passed") {
      // main's own hash from the confined read — a renderer hash is never trusted.
      this.succeed(held, title, read.text, read.sourceHash);
      return;
    }
    // failed / unavailable: the agent (or a later retry) sees the diagnostics;
    // no client ever learns the proposal existed.
    this.settle(held);
    this.respond(held.entry, held.frameId, held.planFilePath, {
      status: rendered.status,
      sourceHash: null,
      diagnostics: rendered.diagnostics,
    });
    this.deps.onHoldReleased(held.tabId);
  }

  private succeed(held: HeldPlanProposal, title: string, text: string, sourceHash: string): void {
    this.snapshots.set(held.tabId, {
      text,
      sourceHash,
      planAbsPath: path.resolve(held.planAbsPath),
    });
    // The delivered request is the ORIGINAL frame with only its title's JSON
    // enriched by main's hash — the fan-out sees the same frame shape the
    // child authored.
    const original = held.originalFrame as Record<string, unknown>;
    const enriched = {
      ...original,
      title: `${PLAN_REVIEW_SENTINEL}${JSON.stringify({
        title,
        planFilePath: held.planFilePath,
        planAbsPath: held.planAbsPath,
        sourceHash,
      })}`,
    };
    this.settle(held);
    this.deps.deliver(held.tabId, enriched, held.entry);
    // The gate now lives in the PlanGateTracker (fed by the delivered frame);
    // human-answer protection continues without this controller's latch.
    this.deps.onHoldReleased(held.tabId);
  }

  private fail(
    held: HeldPlanProposal,
    diagnostic: PlanDiagnostic,
    status: "failed" | "unavailable",
  ): void {
    this.settle(held);
    this.respond(held.entry, held.frameId, held.planFilePath, {
      status,
      sourceHash: null,
      diagnostics: [diagnostic],
    });
    this.deps.onHoldReleased(held.tabId);
  }

  /** Send the machine reply to the ORIGINATING entry only (§5.5). */
  private respond(
    entry: RpcLiveEntry,
    frameId: string,
    planFilePath: string,
    result: PlanPreflightResult,
  ): void {
    if (entry.rpc === null) return;
    this.deps.sendToLive(entry, {
      type: "extension_ui_response",
      id: frameId,
      value: encodePlanPreflightReply(planFilePath, result),
    });
  }

  /** §6: execute re-check found changed bytes — the extension hears SOURCE_CHANGED. */
  sendSourceChanged(entry: RpcLiveEntry, frameId: string, planFilePath: string): void {
    this.respond(entry, frameId, planFilePath, {
      status: "failed",
      sourceHash: null,
      diagnostics: [
        {
          code: "SOURCE_CHANGED",
          stage: "service",
          repair: "resubmit",
          severity: "error",
          message: "the plan artifact changed after validation",
        },
      ],
    });
  }

  private settle(held: HeldPlanProposal): void {
    if (held.settled) return;
    held.settled = true;
    if (this.held.get(held.tabId) === held) this.held.delete(held.tabId);
  }

  private abortHeld(held: HeldPlanProposal): void {
    if (this.held.get(held.tabId) === held) this.held.delete(held.tabId);
    if (!held.settled) {
      held.settled = true;
      held.controller.abort();
    }
  }

  /** A completion only counts while the SAME generation/frame still holds. */
  private isStale(held: HeldPlanProposal): boolean {
    return (
      held.settled ||
      this.held.get(held.tabId) !== held ||
      this.deps.registry.sessions.find((s) => s.tabId === held.tabId) === undefined
    );
  }
}
