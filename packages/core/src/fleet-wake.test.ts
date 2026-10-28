import { describe, expect, it } from "vitest";
import {
  FLEET_WAKE_CUSTOM_TYPE,
  FLEET_WAKE_STATUS_KEY,
  fleetChildSettled,
  fleetWakeAcknowledgedId,
  fleetWakeDeliveredId,
  parseFleetWakeCard,
  type FleetWakeCard,
} from "./fleet-wake";
import { normalizeControlFrame } from "./rpc/control-frames";

type Settle = Parameters<typeof fleetChildSettled>[0];

const idleComplete: Settle = {
  live: "live",
  pendingPlan: null,
  awaitingHumanAnswer: false,
  turnRunning: false,
  sessionId: "s1",
  status: "complete",
};

const card: FleetWakeCard = {
  wakeId: "d1.result",
  dispatchId: "d1",
  kind: "result",
  title: "Fix the build",
  machine: "this computer",
  childTabId: "tab-1",
  outcome: "complete",
};

describe("fleetChildSettled", () => {
  it.each<[string, Partial<Settle>, boolean]>([
    ["live idle complete", {}, true],
    ["live idle pending", { status: "pending" }, false],
    ["live without turnRunning", { turnRunning: undefined, status: "interrupted" }, false],
    ["working", { turnRunning: true }, false],
    ["awaiting answer", { awaitingHumanAnswer: true }, false],
    ["dormant complete", { live: "dormant", turnRunning: undefined }, true],
    ["archived", { live: "archived" }, false],
    ["no sessionId", { sessionId: null }, false],
  ])("%s", (_name, patch, expected) => {
    expect(fleetChildSettled({ ...idleComplete, ...patch } as Settle)).toBe(expected);
  });
});

describe("parseFleetWakeCard", () => {
  it("accepts a well-formed card", () => {
    expect(parseFleetWakeCard({ ...card })).toEqual(card);
  });

  it.each<[string, unknown]>([
    ["an extra key", { ...card, extra: "x" }],
    ["a bad wakeId", { ...card, wakeId: "d1/result" }],
    ["an unknown kind", { ...card, kind: "done" }],
    ["an over-long field", { ...card, title: "t".repeat(513) }],
    ["a missing key", { ...card, outcome: undefined }],
    ["an array", [card]],
  ])("rejects %s", (_name, value) => {
    expect(parseFleetWakeCard(value)).toBeNull();
  });
});

describe("fleetWakeDeliveredId", () => {
  const message = { role: "custom", customType: FLEET_WAKE_CUSTOM_TYPE, details: card };

  it("finds the id on a message_end with the fleet-wake custom type", () => {
    expect(fleetWakeDeliveredId({ type: "message_end", message })).toBe("d1.result");
  });

  it("ignores other frames and custom types", () => {
    expect(fleetWakeDeliveredId({ type: "message_start", message })).toBeNull();
    expect(fleetWakeDeliveredId({ type: "message_end", message: { ...message, customType: "other" } })).toBeNull();
    expect(fleetWakeDeliveredId({ type: "message_end", message: { ...message, role: "user" } })).toBeNull();
    expect(fleetWakeDeliveredId({ type: "message_end", message: { ...message, details: { wakeId: "d1" } } })).toBeNull();
  });
});

describe("fleetWakeAcknowledgedId", () => {
  const ack = (fields: Record<string, unknown>) =>
    normalizeControlFrame({ type: "extension_ui_request", id: "r1", method: "setStatus", ...fields });

  it("accepts a setStatus on the fleet-wake key carrying exactly { wakeId }", () => {
    expect(
      fleetWakeAcknowledgedId(ack({ statusKey: FLEET_WAKE_STATUS_KEY, statusText: JSON.stringify({ wakeId: "d1.q0" }) })),
    ).toBe("d1.q0");
  });

  it("rejects other methods, keys and payloads", () => {
    const text = JSON.stringify({ wakeId: "d1.q0" });
    expect(fleetWakeAcknowledgedId(ack({ method: "notify", statusKey: FLEET_WAKE_STATUS_KEY, statusText: text }))).toBeNull();
    expect(fleetWakeAcknowledgedId(ack({ statusKey: "other", statusText: text }))).toBeNull();
    expect(
      fleetWakeAcknowledgedId(
        ack({ statusKey: FLEET_WAKE_STATUS_KEY, statusText: JSON.stringify({ wakeId: "d1.q0", extra: 1 }) }),
      ),
    ).toBeNull();
    expect(
      fleetWakeAcknowledgedId(ack({ statusKey: FLEET_WAKE_STATUS_KEY, statusText: JSON.stringify({ wakeId: "a b" }) })),
    ).toBeNull();
    expect(fleetWakeAcknowledgedId(ack({ statusKey: FLEET_WAKE_STATUS_KEY, statusText: "not json" }))).toBeNull();
    expect(fleetWakeAcknowledgedId(normalizeControlFrame({ type: "response", id: "x" }))).toBeNull();
    expect(fleetWakeAcknowledgedId(null)).toBeNull();
  });
});
