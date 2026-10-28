import type { SessionStatus, SessionSummary } from "./types";
import type { RpcControlFrame } from "./rpc/control-frames";
import { fleetSessionState } from "./fleet";
import { isObject } from "./guards";

/**
 * Fleet results (issue #957, ADR-0069): the visible message omp-ui posts into
 * the session that dispatched work when a dispatched session finishes its
 * first run, or starts waiting on the user. Pure wire contract shared by
 * main, the generated bridge, and the renderer card; no Node imports.
 */

export const FLEET_WAKE_CUSTOM_TYPE = "omp-ui:fleet-wake";
export const FLEET_WAKE_COMMAND = "omp-ui-fleet-wake";
/** Inclusive UTF-16 ceiling on one wake message's text (bridge and main agree). */
export const FLEET_WAKE_TEXT_MAX = 16_000;
/** Question notices per dispatch; the result is never capped. */
export const FLEET_WAKE_QUESTION_CAP = 3;
/** setStatus key the bridge publishes `{"wakeId":…}` on when the branch already holds that wake (main settles it). */
export const FLEET_WAKE_STATUS_KEY = "omp-ui:fleet-wake";
const WAKE_ID = /^[A-Za-z0-9._-]{1,160}$/;
const CARD_FIELD_MAX = 512;

export type FleetWakeKind = "result" | "question";
export interface FleetWakeCard {
  wakeId: string;
  dispatchId: string;
  kind: FleetWakeKind;
  title: string;
  /** "this computer" or the remote nickname. */
  machine: string;
  childTabId: string;
  /** result: the child's SessionStatus; question: "plan review" or "question". */
  outcome: string;
}
export interface FleetWakeMessage {
  card: FleetWakeCard;
  text: string;
}

export const fleetWakeResultId = (dispatchId: string): string => `${dispatchId}.result`;
export const fleetWakeQuestionId = (dispatchId: string, n: number): string => `${dispatchId}.q${n}`;
export const fleetWakeCommandId = (wakeId: string): string => `omp-ui-fleet-wake-${wakeId}`;
export function fleetWakeArmMessage(msg: FleetWakeMessage): string {
  return `/${FLEET_WAKE_COMMAND} deliver ${JSON.stringify({ text: msg.text, card: msg.card })}`;
}

const CARD_KEYS = ["wakeId", "dispatchId", "kind", "title", "machine", "childTabId", "outcome"] as const;

function cardField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= CARD_FIELD_MAX;
}

/** Strict: exactly the seven keys, wakeId matching WAKE_ID, kind in the enum,
 *  every other field a non-empty string of at most CARD_FIELD_MAX units. Else null. */
export function parseFleetWakeCard(value: unknown): FleetWakeCard | null {
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== CARD_KEYS.length || !CARD_KEYS.every((k) => Object.hasOwn(value, k))) return null;
  const { wakeId, dispatchId, kind, title, machine, childTabId, outcome } = value;
  if (typeof wakeId !== "string" || !WAKE_ID.test(wakeId)) return null;
  if (kind !== "result" && kind !== "question") return null;
  if (!cardField(dispatchId) || !cardField(title) || !cardField(machine)) return null;
  if (!cardField(childTabId) || !cardField(outcome)) return null;
  return { wakeId, dispatchId, kind, title, machine, childTabId, outcome };
}

/** The wakeId of a message_end frame carrying a fleet-wake custom message; else null. */
export function fleetWakeDeliveredId(frame: unknown): string | null {
  if (!isObject(frame) || frame.type !== "message_end") return null;
  const message = frame.message;
  if (!isObject(message) || message.role !== "custom" || message.customType !== FLEET_WAKE_CUSTOM_TYPE) return null;
  return parseFleetWakeCard(message.details)?.wakeId ?? null;
}

/**
 * The wakeId the bridge acknowledged over setStatus because the branch already
 * held that wake (a crash between omp persisting it and main settling it); else null.
 */
export function fleetWakeAcknowledgedId(control: RpcControlFrame | null): string | null {
  if (control === null || control.kind !== "ext_request" || control.method !== "setStatus") return null;
  if (control.frame.statusKey !== FLEET_WAKE_STATUS_KEY) return null;
  const text = control.frame.statusText;
  if (typeof text !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(parsed) || Object.keys(parsed).length !== 1) return null;
  const wakeId = parsed.wakeId;
  return typeof wakeId === "string" && WAKE_ID.test(wakeId) ? wakeId : null;
}

const TERMINAL: ReadonlySet<SessionStatus> = new Set(["complete", "error", "aborted", "interrupted"]);
/** A dispatched session finished a run (§2.1). */
export function fleetChildSettled(
  s: Pick<SessionSummary, "live" | "pendingPlan" | "awaitingHumanAnswer" | "turnRunning" | "sessionId" | "status">,
): boolean {
  if (s.live !== "live" && s.live !== "dormant") return false;
  if (s.live === "live" && s.turnRunning === undefined) return false;
  const state = fleetSessionState(s);
  if (state !== "idle" && state !== "dormant") return false;
  return s.sessionId !== null && s.status !== null && TERMINAL.has(s.status);
}

function capText(text: string): string {
  if (text.length <= FLEET_WAKE_TEXT_MAX) return text;
  let end = FLEET_WAKE_TEXT_MAX - 1; // room for the ellipsis inside the ceiling
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // never leave a lone high surrogate
  return `${text.slice(0, end)}…`;
}

export function fleetWakeResultText(card: FleetWakeCard, summary: string): string {
  return capText(
    `Fleet result — dispatched session "${card.title}" on ${card.machine} finished its run ` +
      `(outcome: ${card.outcome}; dispatch ${card.dispatchId}; tab ${card.childTabId}).\n\n${summary}\n\n` +
      `omp-ui reports each dispatched session's first finished run once. Use omp-ui_fleet_status with this ` +
      `dispatchId for later changes, or omp-ui_fleet_send to give the session a follow-up.`,
  );
}

export function fleetWakeQuestionText(card: FleetWakeCard, what: string): string {
  return capText(
    `Fleet notice — dispatched session "${card.title}" on ${card.machine} is waiting for the user to answer ` +
      `${what} (dispatch ${card.dispatchId}; tab ${card.childTabId}). Only the user can answer it: tell them ` +
      `which session needs them, then continue with other work.`,
  );
}
