// Fleet view domain (issue #899, ADR-0061): the Fleet surface's view state,
// the dispatch dialog's open flag, and the in-memory requests behind unknown
// outcomes. Placement, spawning, and the pending list belong to main's
// FleetDispatcher; this slice only reads machines and forwards requests. The
// machine read is polled by the open view, so its failure lands in the view
// (an error notice every five seconds would bury the app) while every user
// action reports through reportError.
import { backend, displayMessage } from "../../backend";
import type { FleetSlice } from "../types";
import type { GetState, SetState } from "./shared";

export function createFleetSlice(set: SetState, get: GetState): FleetSlice {
  /** Single-flight guard for the machine read: a slow round never stacks under the poll. */
  let reading = false;

  const refreshFleet: FleetSlice["refreshFleet"] = async () => {
    if (get().fleet === null || reading) return;
    reading = true;
    set((s) => (s.fleet === null ? s : { fleet: { ...s.fleet, loading: true } }));
    try {
      const machines = await backend.fleetMachines();
      set((s) => (s.fleet === null ? s : { fleet: { machines, loading: false, error: null } }));
    } catch (err) {
      const error = displayMessage(err);
      set((s) => (s.fleet === null ? s : { fleet: { ...s.fleet, loading: false, error } }));
    } finally {
      reading = false;
    }
  };

  const openFleet: FleetSlice["openFleet"] = () => {
    const s = get();
    // closeLab, not a bare `lab: null`: it also stops the Lab's refresh timer.
    if (s.lab !== null) s.closeLab();
    if (s.fleet === null) set({ fleet: { machines: null, loading: false, error: null }, stats: null });
    else set({ stats: null });
    void refreshFleet();
  };

  const dispatchFleet: FleetSlice["dispatchFleet"] = async (req) => {
    try {
      const result = await backend.fleetDispatch(req);
      const unknown = result.outcomes.filter((o) => o.status === "unknown");
      if (unknown.length > 0) {
        const fleetLastRequests = { ...get().fleetLastRequests };
        for (const o of unknown) {
          fleetLastRequests[o.dispatchId] = { req, pick: { machineKey: o.machineKey, projectCwd: o.projectCwd } };
        }
        set({ fleetLastRequests });
      }
      return result;
    } catch (err) {
      get().reportError(err);
      return null;
    }
  };

  const forgetRequest = (dispatchId: string): void => {
    if (!(dispatchId in get().fleetLastRequests)) return;
    const fleetLastRequests = { ...get().fleetLastRequests };
    delete fleetLastRequests[dispatchId];
    set({ fleetLastRequests });
  };

  return {
    fleet: null,
    fleetDispatchOpen: false,
    fleetLastRequests: {},
    openFleet,
    closeFleet: () => set({ fleet: null }),
    refreshFleet,
    openFleetDispatch: () => set({ fleetDispatchOpen: true }),
    closeFleetDispatch: () => set({ fleetDispatchOpen: false }),
    dispatchFleet,

    async setFleetPlacement(machineKey, pref) {
      try {
        await backend.setFleetPlacement(machineKey, pref);
      } catch (err) {
        get().reportError(err);
      }
      // The machine list carries each preference: re-read so the capsule settles.
      void refreshFleet();
    },

    async setFleetAgentDispatch(on) {
      try {
        await backend.setFleetAgentDispatch(on);
      } catch (err) {
        get().reportError(err);
      }
    },

    async retryFleetDispatch(pending) {
      const entry = get().fleetLastRequests[pending.dispatchId];
      if (entry === undefined) return;
      const result = await dispatchFleet({
        ...entry.req,
        targets: { kind: "explicit", picks: [entry.pick] },
        retryOf: { dispatchId: pending.dispatchId, batchId: pending.batchId },
      });
      const outcome = result?.outcomes[0];
      if (outcome === undefined) return;
      if (outcome.status === "started") forgetRequest(pending.dispatchId);
      else if (outcome.status === "failed") get().reportError(new Error(outcome.message));
    },

    async dismissFleetDispatch(dispatchId) {
      try {
        await backend.fleetDismissPending(dispatchId);
        forgetRequest(dispatchId);
      } catch (err) {
        get().reportError(err);
      }
    },
  };
}
