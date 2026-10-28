import fs from "node:fs";
import path from "node:path";
import {
  FLEET_WAKE_QUESTION_CAP,
  FLEET_WAKE_TEXT_MAX,
  LOCAL_MACHINE_KEY,
  fleetChildSettled,
  fleetMachineName,
  fleetSessionState,
  fleetWakeQuestionId,
  fleetWakeQuestionText,
  fleetWakeResultId,
  fleetWakeResultText,
  parseFleetWakeCard,
  writeTextAtomic,
  type BackendState,
  type FleetWakeCard,
  type FleetWakeMessage,
  type SessionSummary,
} from "@omp-ui/core";

/** One agent dispatch whose child this parent waits on (§2.1). */
export interface FleetWakeWatch {
  dispatchId: string;
  machineKey: string;
  resultStaged: boolean;
  questionKeys: string[];
}

interface FleetWakeLedger {
  version: 1;
  watches: FleetWakeWatch[];
  staged: FleetWakeMessage[];
}

/** What SessionManager reads and settles. */
export interface FleetWakeLedgerAccess {
  staged(parentTabId: string): FleetWakeMessage[];
  delivered(parentTabId: string, wakeId: string): void;
}

export interface FleetWakeCoordinatorDeps {
  /** <dirname(registryFile)>/fleet-wake */
  dir: string;
  instanceId(): string;
  hasSession(tabId: string): boolean;
  /** Local renderSessionSummary or the proxied fleet:sessionSummary, raced against 5 s; "Summary unavailable." on failure. */
  summaryText(machineKey: string, childTabId: string): Promise<string>;
  /** SessionManager.flushFleetWakes */
  flush(parentTabId: string): void;
  log(line: string): void;
}

const LEDGER_FILE = /^[A-Za-z0-9_-]{1,128}\.json$/;
const WATCH_MAX = 500;

interface FleetChild {
  machineKey: string;
  machine: string;
  summary: SessionSummary;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseWatch(value: unknown): FleetWakeWatch | null {
  if (!isObject(value)) return null;
  const { dispatchId, machineKey, resultStaged, questionKeys } = value;
  if (typeof dispatchId !== "string" || dispatchId.length === 0) return null;
  if (typeof machineKey !== "string" || machineKey.length === 0) return null;
  if (typeof resultStaged !== "boolean") return null;
  if (!Array.isArray(questionKeys) || !questionKeys.every((k) => typeof k === "string")) return null;
  return { dispatchId, machineKey, resultStaged, questionKeys: [...questionKeys] };
}

function parseStaged(value: unknown): FleetWakeMessage | null {
  if (!isObject(value)) return null;
  const card = parseFleetWakeCard(value.card);
  const text = value.text;
  if (card === null || typeof text !== "string" || text.length < 1 || text.length > FLEET_WAKE_TEXT_MAX) return null;
  return { card, text };
}

function parseLedger(value: unknown): FleetWakeLedger | null {
  if (!isObject(value) || value.version !== 1) return null;
  if (!Array.isArray(value.watches) || !Array.isArray(value.staged)) return null;
  const watches: FleetWakeWatch[] = [];
  for (const raw of value.watches) {
    const watch = parseWatch(raw);
    if (watch === null) return null;
    watches.push(watch);
  }
  const staged: FleetWakeMessage[] = [];
  for (const raw of value.staged) {
    const msg = parseStaged(raw);
    if (msg === null) return null;
    staged.push(msg);
  }
  return { version: 1, watches, staged };
}

/**
 * Stages a dispatching agent's Fleet results and notices (§2.1). The in-memory
 * map is the only source of truth; every mutation persists synchronously.
 */
export class FleetWakeCoordinator implements FleetWakeLedgerAccess {
  readonly #deps: FleetWakeCoordinatorDeps;
  readonly #ledgers = new Map<string, FleetWakeLedger>();
  #chain: Promise<void> = Promise.resolve();

  constructor(deps: FleetWakeCoordinatorDeps) {
    this.#deps = deps;
    let names: string[];
    try {
      names = fs.readdirSync(deps.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!LEDGER_FILE.test(name)) continue;
      const file = path.join(deps.dir, name);
      let ledger: FleetWakeLedger | null;
      try {
        ledger = parseLedger(JSON.parse(fs.readFileSync(file, "utf8")));
      } catch {
        ledger = null;
      }
      if (ledger === null) {
        deps.log(`[fleet-wake] ignoring invalid ledger ${file}`);
        continue;
      }
      this.#ledgers.set(name.slice(0, -".json".length), ledger);
    }
  }

  /** Called by the dispatcher for an agent dispatch; synchronous file write before the tool answers. */
  watch(parentTabId: string, dispatches: Array<{ dispatchId: string; machineKey: string }>): void {
    const ledger = this.#ledgers.get(parentTabId) ?? { version: 1 as const, watches: [], staged: [] };
    for (const { dispatchId, machineKey } of dispatches) {
      if (ledger.watches.some((w) => w.dispatchId === dispatchId)) continue;
      ledger.watches.push({ dispatchId, machineKey, resultStaged: false, questionKeys: [] });
    }
    while (ledger.watches.length > WATCH_MAX) {
      const oldest = ledger.watches.findIndex((w) => w.resultStaged);
      if (oldest < 0) break;
      ledger.watches.splice(oldest, 1);
    }
    this.#ledgers.set(parentTabId, ledger);
    this.#write(parentTabId, ledger);
  }

  /** Called after every state broadcast; enqueues on a private serial chain, never throws. */
  observe(state: BackendState): void {
    this.#chain = this.#chain
      .then(() => this.#observe(state))
      .catch((err: unknown) => {
        this.#deps.log(`[fleet-wake] observe failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /** Resolves once every observe enqueued so far has run. */
  settled(): Promise<void> {
    return this.#chain;
  }

  staged(parentTabId: string): FleetWakeMessage[] {
    return [...(this.#ledgers.get(parentTabId)?.staged ?? [])];
  }

  delivered(parentTabId: string, wakeId: string): void {
    const ledger = this.#ledgers.get(parentTabId);
    if (ledger === undefined) return;
    const index = ledger.staged.findIndex((m) => m.card.wakeId === wakeId);
    if (index < 0) return;
    ledger.staged.splice(index, 1);
    this.#write(parentTabId, ledger);
  }

  async #observe(state: BackendState): Promise<void> {
    const instanceId = this.#deps.instanceId();
    const children = new Map<string, FleetChild>();
    const collect = (machineKey: string, machine: string, sessions: SessionSummary[]): void => {
      for (const summary of sessions) {
        if (summary.fleet?.requestedBy.instanceId !== instanceId) continue;
        children.set(summary.fleet.dispatchId, { machineKey, machine, summary });
      }
    };
    const localName = fleetMachineName({ nickname: null });
    for (const group of state.projects) collect(LOCAL_MACHINE_KEY, localName, group.sessions);
    for (const remote of state.remoteInstances) {
      for (const group of remote.projects) collect(remote.id, remote.nickname, group.sessions);
    }

    for (const parentTabId of [...this.#ledgers.keys()]) {
      if (this.#deps.hasSession(parentTabId)) continue;
      this.#ledgers.delete(parentTabId);
      try {
        fs.rmSync(this.#file(parentTabId), { force: true });
      } catch (err) {
        this.#deps.log(`[fleet-wake] ${parentTabId}: delete failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const [parentTabId, ledger] of this.#ledgers) {
      for (const watch of ledger.watches) {
        const child = children.get(watch.dispatchId);
        if (child === undefined || child.summary.fleet?.requestedBy.sourceTabId !== parentTabId) continue;
        const summary = child.summary;
        const id = watch.dispatchId;
        if (!watch.resultStaged && fleetChildSettled(summary)) {
          const text = await this.#deps.summaryText(child.machineKey, summary.tabId);
          // The ledger may have been settled or replaced while awaiting.
          if (this.#ledgers.get(parentTabId) !== ledger || watch.resultStaged) continue;
          const card: FleetWakeCard = {
            wakeId: fleetWakeResultId(id),
            dispatchId: id,
            kind: "result",
            title: summary.title,
            machine: child.machine,
            childTabId: summary.tabId,
            outcome: summary.status ?? "unknown",
          };
          ledger.staged.push({ card, text: fleetWakeResultText(card, text) });
          watch.resultStaged = true;
          this.#write(parentTabId, ledger);
        }
        if (fleetSessionState(summary) === "awaiting answer") {
          const dialogId = (summary.pendingDialogs?.[0] as { id?: unknown } | undefined)?.id;
          const key = summary.pendingPlan?.frameId ?? String(dialogId ?? "dialog");
          if (!watch.questionKeys.includes(key) && watch.questionKeys.length < FLEET_WAKE_QUESTION_CAP) {
            const plan = summary.pendingPlan;
            const card: FleetWakeCard = {
              wakeId: fleetWakeQuestionId(id, watch.questionKeys.length),
              dispatchId: id,
              kind: "question",
              title: summary.title,
              machine: child.machine,
              childTabId: summary.tabId,
              outcome: plan !== null ? "plan review" : "question",
            };
            const what = plan !== null ? `the plan review "${plan.title}"` : "a question";
            watch.questionKeys.push(key);
            ledger.staged.push({ card, text: fleetWakeQuestionText(card, what) });
            this.#write(parentTabId, ledger);
          }
        }
      }
    }

    for (const [parentTabId, ledger] of this.#ledgers) {
      if (ledger.staged.length > 0) this.#deps.flush(parentTabId);
    }
  }

  #file(tabId: string): string {
    return path.join(this.#deps.dir, `${tabId}.json`);
  }

  #write(tabId: string, ledger: FleetWakeLedger): void {
    writeTextAtomic(this.#file(tabId), JSON.stringify(ledger));
  }
}
