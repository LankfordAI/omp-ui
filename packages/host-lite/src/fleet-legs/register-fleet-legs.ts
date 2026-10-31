/**
 * The member-side fleet channel table for the headless lite host (issue
 * #1010). `registerFleetLegs` returns the request/notify slice a composition
 * root merges into its ChannelTable. Arguments reach these handlers already
 * decoded by the shared codecs at `dispatchRequest` — the same single
 * boundary the desktop backend uses — so handler signatures match
 * `RequestHandlers` exactly and refusals stay answers, never transport errors.
 *
 * Ladder semantics mirror `packages/desktop/src/main/fleet-server.ts`
 * decision-for-decision: effective rung = min(grant ?? "dispatch", ceiling);
 * Full control and above additionally require the master switch; every
 * accepted-or-refused action lands in a 200-entry audit ring (same truncation
 * rule) through `auditSink`. First sight records a label-only grant row — it
 * names the dispatcher without granting anything.
 *
 * Absent-not-denied (#449): a channel whose machinery the host was not given
 * is simply missing from the returned table, so the transport answers
 * "unknown channel" like any older peer would. Deliberately never registered:
 * `fleet:updateMember` / `fleet:updatePoll` (a SEA binary has no updater to
 * drive — nothing can arm an install-on-quit hook, and a refused-with-reason
 * answer would pretend otherwise), and the owner-local fleet verbs, which are
 * off REMOTE_PROXY_CHANNELS by design.
 */
import { CH, FLEET_LABEL_MAX, MIN_SUPPORTED_OMP, compareVersions, fleetEffectiveRung, fleetRungAtLeast, fleetRungRank } from "@omp-ui/core";
import type {
  ChannelTable,
  FleetAuditEntry,
  FleetDetachedExecRequest,
  FleetDetachedExecStartOutcome,
  FleetExecOutcome,
  FleetExecPollRequest,
  FleetExecRequest,
  FleetFinishOutcome,
  FleetFinishRequest,
  FleetGrantRaiseOutcome,
  FleetGrantRaiseRequest,
  FleetGrantRecord,
  FleetHostReport,
  FleetProjectFilesRequest,
  FleetProjectManageRequest,
  FleetProviderKeysRequest,
  FleetRequester,
  FleetRung,
  FleetSendOutcome,
  FleetSendRequest,
  FleetTerminalEndRequest,
  FleetTerminalOpenOutcome,
  FleetTerminalOpenRequest,
  FleetTerminalRenewRequest,
  RequestHandlers,
} from "@omp-ui/core";
import { passwordSessionCredential, tokenMatches, verifyRemotePassword } from "@omp-ui/server";
import { realpathSync } from "node:fs";
import * as os from "node:os";
import type { FleetLegsDeps, FleetLegsHandle, FleetLegsRegistry } from "./types.js";

const AUDIT_RING_CAPACITY = 200;
const AUDIT_DETAIL_LIMIT = 200;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The same identity clamp the desktop member reports under. */
function fleetLabel(): string {
  return [...os.hostname()].slice(0, FLEET_LABEL_MAX).join("") || "omp-ui";
}

const DEFAULT_FLEET_USER: string | null = (() => {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
})();

type RungGate = { ok: true; rung: FleetRung } | { ok: false; reason: string };

/**
 * `Partial<T>` keeps the mapped type's `readonly` modifiers, which blocks
 * per-key assignment while assembling; strip them for the builder and hand
 * out the readonly Partial through `FleetLegsHandle`.
 */
type MutableTable<T> = { -readonly [K in keyof T]?: T[K] };

/**
 * Build the lite member's fleet legs. Every seam in `deps` is optional except
 * `registry` and `host`: pass nothing else and the host still answers
 * grantRung / grantRaise / hostReport (the ladder bookkeeping a join needs),
 * while the execution channels stay absent.
 */
export function registerFleetLegs(deps: FleetLegsDeps): FleetLegsHandle {
  const registry: FleetLegsRegistry = deps.registry;
  const label = deps.label ?? fleetLabel();
  const ring: FleetAuditEntry[] = [];

  const audit = (
    action: FleetAuditEntry["action"],
    requester: FleetRequester,
    rung: FleetAuditEntry["rung"],
    accepted: boolean,
    detail: string,
    exitCode: number | null,
  ): void => {
    const entry: FleetAuditEntry = {
      at: new Date().toISOString(),
      dispatcherId: requester.instanceId,
      dispatcherLabel: requester.label,
      sourceTabId: requester.sourceTabId,
      action,
      rung,
      accepted,
      detail: detail.length > AUDIT_DETAIL_LIMIT ? `${detail.slice(0, AUDIT_DETAIL_LIMIT - 1)}…` : detail,
      exitCode,
    };
    ring.push(entry);
    if (ring.length > AUDIT_RING_CAPACITY) ring.shift();
    deps.auditSink?.(entry);
  };

  const recordFirstSight = (requester: FleetRequester): void => {
    const grants = registry.getSetting("fleetGrants");
    if (requester.instanceId in grants) return;
    const next: Record<string, FleetGrantRecord> = {
      ...grants,
      [requester.instanceId]: { label: requester.label, updatedAt: new Date().toISOString() },
    };
    registry.setSetting("fleetGrants", next);
  };

  /** The ladder check — identical decision text to the desktop node's `check`. */
  const check = (requester: FleetRequester, need: FleetRung): RungGate => {
    recordFirstSight(requester);
    const ceiling = registry.getSetting("fleetExecCeiling");
    const rung = fleetEffectiveRung(registry.getSetting("fleetGrants")[requester.instanceId], ceiling);
    if (!fleetRungAtLeast(rung, need)) {
      return { ok: false, reason: `${requester.label} holds fleet access "${rung}" on this machine; this call needs "${need}"` };
    }
    if (fleetRungAtLeast(need, "full") && !registry.getSetting("fleetExecEnabled")) {
      return { ok: false, reason: "fleet exec is off on this machine (Settings → Remote instances → Fleet access)" };
    }
    return { ok: true, rung };
  };

  const enforceLadder = (): void => {
    const holds = (id: string, need: FleetRung): boolean =>
      fleetRungAtLeast(fleetEffectiveRung(registry.getSetting("fleetGrants")[id], registry.getSetting("fleetExecCeiling")), need);
    deps.exec?.revokeWhere((id) => holds(id, "full"));
    deps.terminals?.revokeWhere((id) => holds(id, "terminal"));
  };

  const request: MutableTable<RequestHandlers> = {};
  const notify: MutableTable<ChannelTable["notify"]> = {};

  // ── Ladder bookkeeping: always served (a join needs rung visibility + raise) ──

  // `fleet:grantRung`: the dispatcher's effective rung here (observe floor — never refused).
  request[CH.fleetGrantRung] = (requester: FleetRequester) => {
    recordFirstSight(requester);
    return {
      rung: fleetEffectiveRung(registry.getSetting("fleetGrants")[requester.instanceId], registry.getSetting("fleetExecCeiling")),
      ceiling: registry.getSetting("fleetExecCeiling"),
      execEnabled: registry.getSetting("fleetExecEnabled"),
    };
  };

  const credentialMatches = (credential: string): boolean => {
    if (credential === "") return false;
    if (tokenMatches(registry.getSetting("remoteToken"), credential)) return true;
    const hash = registry.getSetting("remotePasswordHash");
    if (hash === "") return false;
    // A password holder's browser session credential is the same secret they
    // could type; accept it too (the transport's cookie-path rule).
    if (tokenMatches(passwordSessionCredential(hash), credential)) return true;
    return verifyRemotePassword(credential, registry.getSetting("remotePasswordSalt"), hash);
  };

  // `fleet:grantRaise`: the dispatcher re-presents this node's join credential;
  // it is verified against OUR settings before any grant is written. The
  // credential never enters a log or the ring.
  request[CH.fleetGrantRaise] = (req: FleetGrantRaiseRequest): FleetGrantRaiseOutcome => {
    if (!credentialMatches(req.credential)) {
      audit("grant-raise", req.requester, "raise", false, `target ${req.targetRung}: wrong credential`, null);
      return { ok: false, reason: "the token or password does not match this machine" };
    }
    const ceiling = registry.getSetting("fleetExecCeiling");
    if (fleetRungRank(req.targetRung) > fleetRungRank(ceiling)) {
      audit("grant-raise", req.requester, "raise", false, `target ${req.targetRung}: above ceiling ${ceiling}`, null);
      return { ok: false, reason: `this machine's ceiling is "${ceiling}"; a grant above it never takes effect` };
    }
    const grants = { ...registry.getSetting("fleetGrants") };
    grants[req.requester.instanceId] = { rung: req.targetRung, label: req.requester.label, updatedAt: new Date().toISOString() };
    registry.setSetting("fleetGrants", grants);
    deps.stateChanged?.();
    audit("grant-raise", req.requester, "raise", true, `raised to ${req.targetRung}`, null);
    // A "raise" may name a lower rung: a dispatcher it drops below Full loses its running detached execs.
    enforceLadder();
    return { ok: true, rung: req.targetRung };
  };

  // ── Execution ladder legs: registered only when the machinery was given ──

  const exec = deps.exec;
  if (exec !== undefined) {
    // `fleet:exec`: ladder (Full control + master switch), then the bounded runner.
    request[CH.fleetExec] = async (req: FleetExecRequest): Promise<FleetExecOutcome> => {
      const gate = check(req.requester, "full");
      if (!gate.ok) {
        audit("exec", req.requester, "full", false, req.command, null);
        return { status: "refused", reason: gate.reason };
      }
      const outcome = await exec.run({ command: req.command, cwd: req.cwd, timeoutMs: req.timeoutMs });
      audit(
        "exec",
        req.requester,
        gate.rung,
        outcome.status === "accepted",
        req.command,
        outcome.status === "accepted" ? outcome.exitCode : null,
      );
      return outcome;
    };
    // `fleet:execDetach`: same ladder as exec; the member keeps the process running past the call.
    request[CH.fleetExecDetach] = (req: FleetDetachedExecRequest): FleetDetachedExecStartOutcome => {
      const gate = check(req.requester, "full");
      if (!gate.ok) {
        audit("exec-detached", req.requester, "full", false, req.command, null);
        return { status: "refused", reason: gate.reason };
      }
      const outcome = exec.start(req.requester, gate.rung, { command: req.command, cwd: req.cwd, timeoutMs: req.timeoutMs });
      audit(
        "exec-detached",
        req.requester,
        gate.rung,
        outcome.status === "accepted",
        outcome.status === "accepted" ? `${outcome.execId.slice(0, 8)} ${req.command}` : req.command,
        null,
      );
      return outcome;
    };
    // `fleet:execPoll`: no ladder check — only the dispatcher that started the
    // exec can see it (the seam owns that rule). Never audited.
    request[CH.fleetExecPoll] = (req: FleetExecPollRequest) => {
      recordFirstSight(req.requester);
      return exec.poll(req.requester, req.execId, req.waitMs, req.cancel);
    };
  }

  const terminals = deps.terminals;
  if (terminals !== undefined) {
    // `fleet:terminalOpen` (ADR-0084): the Terminal rung plus the master
    // switch, then one login shell under the dispatcher's own id.
    request[CH.fleetTerminalOpen] = (req: FleetTerminalOpenRequest): FleetTerminalOpenOutcome => {
      const gate = check(req.requester, "terminal");
      if (!gate.ok) {
        audit("terminal", req.requester, "terminal", false, "open", null);
        return { status: "refused", reason: gate.reason };
      }
      const outcome = terminals.open(req.requester, gate.rung, req.terminalId, req.cols, req.rows);
      const detail = outcome.status === "accepted" ? `${req.terminalId.slice(0, 8)} opened` : `open: ${outcome.reason}`;
      audit("terminal", req.requester, gate.rung, outcome.status === "accepted", detail, null);
      return outcome;
    };
    // `fleet:terminalRenew`: no ladder check — only the requester's own ids
    // renew, and revocation ends them. Never audited.
    request[CH.fleetTerminalRenew] = (req: FleetTerminalRenewRequest) => ({ alive: terminals.renew(req.requester, req.terminalIds) });
    // `fleet:terminalEnd`: the requester's own terminal only; the end lands in
    // the audit through the seam's onEnd callback (the adapter wires it).
    request[CH.fleetTerminalEnd] = (req: FleetTerminalEndRequest): void => {
      terminals.end(req.requester, req.terminalId);
    };
    // `fleet:terminalWrite` / `fleet:terminalSize`: keystrokes and geometry
    // into the claimed dispatcher's own terminal; anything else is dropped by
    // the seam's ownership check.
    notify[CH.fleetTerminalWrite] = (dispatcherId: string, terminalId: string, data: string): void => {
      terminals.write(dispatcherId, terminalId, data);
    };
    notify[CH.fleetTerminalSize] = (dispatcherId: string, terminalId: string, cols: number, rows: number): void => {
      terminals.resize(dispatcherId, terminalId, cols, rows);
    };
  }

  const project = deps.project;
  if (project !== undefined) {
    // `fleet:projectManage`: rung 3 + declared roots; the fixed clone/register verbs.
    request[CH.fleetProjectManage] = async (req: FleetProjectManageRequest) => {
      const gate = check(req.requester, "manage");
      if (!gate.ok) {
        audit("manage", req.requester, "manage", false, req.verb, null);
        return { status: "refused" as const, reason: gate.reason };
      }
      const roots = registry.getSetting("fleetProjectRoots");
      if (roots.length === 0) {
        audit("manage", req.requester, gate.rung, false, req.verb, null);
        return { status: "refused" as const, reason: "no project roots are declared on this machine" };
      }
      const outcome =
        req.verb === "clone" ? await project.clone(req.repositoryUrl, roots) : await project.register(req.path, roots);
      audit(
        "manage",
        req.requester,
        gate.rung,
        outcome.status === "accepted",
        `${req.verb} ${outcome.status === "accepted" ? outcome.path : ""}`.trim(),
        null,
      );
      return outcome;
    };
    // `fleet:projectFiles` (Project copy, #992): rung 3; the write rules — new
    // files only, roots containment, symlink escape refusal — run on the seam
    // against this machine's filesystem, with the registry's project list as
    // the registration gate.
    request[CH.fleetProjectFiles] = async (req: FleetProjectFilesRequest) => {
      const gate = check(req.requester, "manage");
      if (!gate.ok) {
        audit("manage", req.requester, "manage", false, "files", null);
        return { status: "refused" as const, reason: gate.reason };
      }
      const roots = registry.getSetting("fleetProjectRoots");
      const isRegisteredPath = (realPath: string): boolean =>
        registry.projects.some((p) => {
          try {
            return realpathSync(p.path) === realPath;
          } catch {
            return false;
          }
        });
      const outcome = await project.writeFiles(req, roots, isRegisteredPath);
      if (outcome.status === "refused") {
        audit("manage", req.requester, gate.rung, false, `files ${req.path}`, null);
        return outcome;
      }
      // Every file attempted ≠ every file written: a failed entry marks the
      // action refused in the ring (the desktop member's rule).
      audit("manage", req.requester, gate.rung, outcome.failed.length === 0, `files ${outcome.written.length}/${req.files.length}`, null);
      return outcome;
    };
  }

  const sessions = deps.sessions;
  if (sessions !== undefined) {
    // `fleet:send` (#959): a foreign instance needs the Dispatch rung; the own
    // instance skips the ladder. The message text never enters the ring.
    request[CH.fleetSend] = async (req: FleetSendRequest): Promise<FleetSendOutcome> => {
      const own = req.requester.instanceId === registry.getSetting("instanceId");
      let rung: FleetRung = "dispatch";
      if (!own) {
        const gate = check(req.requester, "dispatch");
        if (!gate.ok) {
          audit("send", req.requester, "dispatch", false, req.dispatchId.slice(0, 8), null);
          return { status: "refused", reason: gate.reason };
        }
        rung = gate.rung;
      }
      const outcome = await sessions.deliverSend(req);
      audit("send", req.requester, rung, outcome.status !== "refused", `${req.dispatchId.slice(0, 8)} ${outcome.status}`, null);
      return outcome;
    };
    // `fleet:finish` (#978): the same gate as send.
    request[CH.fleetFinish] = async (req: FleetFinishRequest): Promise<FleetFinishOutcome> => {
      const own = req.requester.instanceId === registry.getSetting("instanceId");
      let rung: FleetRung = "dispatch";
      if (!own) {
        const gate = check(req.requester, "dispatch");
        if (!gate.ok) {
          audit("finish", req.requester, "dispatch", false, req.dispatchId.slice(0, 8), null);
          return { status: "refused", reason: gate.reason };
        }
        rung = gate.rung;
      }
      const outcome = await sessions.deliverFinish(req);
      audit("finish", req.requester, rung, outcome.status === "finished", `${req.dispatchId.slice(0, 8)} ${outcome.status}`, null);
      return outcome;
    };
  }

  const providerKeys = deps.providerKeys;
  if (providerKeys !== undefined) {
    // `fleet:providerKeys` (#905, ADR-0065): Full control + master switch, then
    // each key into this machine's own credential store. The audit names env
    // names only; a key value never reaches a log or the ring.
    request[CH.fleetProviderKeys] = (req: FleetProviderKeysRequest) => {
      const names = req.keys.map((k) => k.envName).join(", ");
      const gate = check(req.requester, "full");
      if (!gate.ok) {
        audit("keys", req.requester, "full", false, names, null);
        return { status: "refused" as const, reason: gate.reason };
      }
      const installed: string[] = [];
      const failed: Array<{ envName: string; reason: string }> = [];
      for (const { envName, value } of req.keys) {
        try {
          providerKeys.install(envName, value);
          installed.push(envName);
        } catch (err) {
          failed.push({ envName, reason: messageOf(err) });
        }
      }
      audit(
        "keys",
        req.requester,
        gate.rung,
        failed.length === 0,
        `installed ${installed.join(", ") || "none"}${failed.length > 0 ? `; failed ${failed.map((f) => f.envName).join(", ")}` : ""}`,
        null,
      );
      return { status: "accepted", installed, failed };
    };
  }

  // ── fleet:hostReport: always served (placement reads it before dispatch) ──

  const host = deps.host;
  request[CH.fleetHostReport] = async (): Promise<FleetHostReport> => {
    const now = Date.now();
    const resources = await host.resources();
    const [projects, hostOs, packageManagers, ompVersion] = await Promise.all([
      host.projects(),
      // A failed optional probe reports as null (the owner reads that as the
      // pre-feature member) and never rejects the whole report.
      host.os === undefined ? Promise.resolve(null) : host.os().catch(() => null),
      host.packageManagers === undefined ? Promise.resolve(null) : host.packageManagers().catch(() => null),
      host.ompVersion === undefined ? Promise.resolve(null) : host.ompVersion().catch(() => null),
    ]);
    const activity = host.activity();
    return {
      instanceId: registry.getSetting("instanceId"),
      label,
      version: deps.version ?? "0.0.0",
      platform: process.platform,
      arch: process.arch,
      ...resources,
      liveSessions: activity.liveSessions,
      runningTurns: activity.runningTurns,
      sampledAt: now,
      projects,
      user: DEFAULT_FLEET_USER,
      projectRoots: registry.getSetting("fleetProjectRoots"),
      os: hostOs,
      packageManagers,
      ompVersion,
      ompPath: host.ompPath?.() ?? null,
      ompPinned: host.ompPinned?.() ?? false,
      ompBelowMinimum: ompVersion !== null && compareVersions(ompVersion, MIN_SUPPORTED_OMP) < 0,
      // Issue #1010 ships no app updater for the SEA binary: these three
      // answer exactly as a member that predates the update feature does —
      // absent-not-denied nulls, and `fleet:updateMember` stays unregistered.
      packageFormat: null,
      appLatestVersion: null,
      appUpdateStaged: false,
      modelFavorites: [...registry.getSetting("modelFavorites")],
    };
  };

  return {
    request,
    notify,
    enforceLadder,
    dispose(): void {
      deps.exec?.dispose();
      deps.terminals?.dispose();
    },
  };
}
