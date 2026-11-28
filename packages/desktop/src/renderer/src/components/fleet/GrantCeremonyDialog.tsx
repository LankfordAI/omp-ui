import { useCallback, useState, type ReactElement } from "react";
import {
  FLEET_BINDING_REFUSAL,
  FLEET_RAISE_RUNGS,
  fleetRungRank,
  type FleetGrantRaiseOutcome,
  type FleetRung,
} from "@omp-ui/core/fleet";
import { backend, displayMessage } from "../../backend";
import { useLoad } from "../../lib/load";
import { cn } from "../../lib/cn";
import { useStore } from "../../store";
import { ChoiceCapsule, Modal } from "../ui";
import { RUNG_LABEL } from "../settings/RemoteInstancesPage";
import { GrantCredentialRow } from "./GrantCredentialRow";

/**
 * The shared grant-raise ceremony (issue #1398), one modal for every refusal
 * site: Settings rows, the Fleet view's access chip, the Copy dialog. Holds
 * the instance id — requests resolve by id, so a rename mid-entry cannot send
 * the secret elsewhere. Pre-checks run against the machine row's reported
 * ceiling and exec switch when the probe answered; without them (null) the
 * member's own refusal surfaces. Outcome stays visible until the user closes.
 */
export function GrantCeremonyDialog(): ReactElement | null {
  const ceremony = useStore((s) => s.grantCeremony);
  const closeGrantCeremony = useStore((s) => s.closeGrantCeremony);
  const requestFleetGrant = useStore((s) => s.requestFleetGrant);
  // Pre-checks need this machine's *current* gates: the store's fleet snapshot
  // is the Fleet view's poll and can be arbitrarily old (Settings and the Copy
  // dialog never load it), so the dialog fetches its own machine row on open —
  // the same read machines() does — and retries it whenever the ceremony opens.
  const readMachines = useCallback(() => backend.fleetMachines(), [ceremony]);
  const { load: machinesLoad } = useLoad(readMachines);
  const machines = machinesLoad.status === "loaded" ? machinesLoad.value : null;
  const [kind, setKind] = useState<"password" | "token">("password");
  const [rung, setRung] = useState<FleetRung>(ceremony?.neededRung ?? "manage");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<FleetGrantRaiseOutcome | null>(null);

  if (ceremony === null) return null;
  const machineName = ceremony.machineName;
  // Without a fresh answer (still loading, probe failed) the member's own
  // refusal is the check.
  const machine = machines?.find((m) => m.key === ceremony.instanceId) ?? null;
  const ceiling = machine?.grantCeiling ?? null;
  const execEnabled = machine?.memberExecEnabled ?? null;
  const heldRung = machine?.grantRung ?? null;
  const known = machine !== null && machine.status === "ready" && heldRung !== null;
  // The selection the user works with is the raw capsule state; a needed rung
  // above the ceiling displays as the first ceiling-allowed option instead, so
  // the gate, the warnings, and the send all read the same rung.
  const effectiveRung =
    ceiling !== null && fleetRungRank(rung) > fleetRungRank(ceiling)
      ? (FLEET_RAISE_RUNGS.find((r) => fleetRungRank(r) <= fleetRungRank(ceiling)) ?? rung)
      : rung;
  const aboveCeiling = ceiling !== null && FLEET_RAISE_RUNGS.every((r) => fleetRungRank(r) > fleetRungRank(ceiling));
  const execWarning = execEnabled === false && (effectiveRung === "full" || effectiveRung === "terminal");
  const bindingRefusal = outcome !== null && !outcome.ok && outcome.reason.endsWith(FLEET_BINDING_REFUSAL);

  const submit = (secret: string): void => {
    if (busy || aboveCeiling) return;
    setBusy(true);
    setOutcome(null);
    void requestFleetGrant(ceremony.instanceId, effectiveRung, secret)
      .then((o) => setOutcome(o))
      .catch((err: unknown) => setOutcome({ ok: false, reason: displayMessage(err) }))
      .finally(() => setBusy(false));
  };

  return (
    <Modal onClose={closeGrantCeremony} width="w-[34rem]" mobile="dialog" className="flex flex-col">
      <header className="shrink-0 border-b border-line px-4 py-3.5">
        <p className="mb-1 font-mono text-xs uppercase tracking-[0.16em] text-copper">fleet access</p>
        <h2 className="text-base font-semibold text-ink">{`Request higher access from ${machineName}`}</h2>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        <p className="text-sm leading-relaxed text-ink-faint">
          {`Re-type ${machineName}'s password or access token — ${machineName} checks it, and its own ceiling, before granting.`}
        </p>
        <GrantCredentialRow
          kind={kind}
          onKindChange={setKind}
          onSecretChange={() => {}}
          onSubmit={submit}
          onCancel={closeGrantCeremony}
          busy={busy}
          canSubmit={!busy && !aboveCeiling}
          submitLabel="Ask"
        >
          <ChoiceCapsule
            label={`Access for ${machineName}`}
            value={effectiveRung}
            options={FLEET_RAISE_RUNGS.map((r) => ({
              value: r,
              label: RUNG_LABEL[r],
              // Not an upgrade target: above that machine's ceiling, or a rung
              // the row already effectively holds (issue #1398).
              disabled:
                (ceiling !== null && fleetRungRank(r) > fleetRungRank(ceiling)) ||
                (heldRung !== null && fleetRungRank(r) <= fleetRungRank(heldRung)),
            }))}
            onChange={(next) => setRung(next as FleetRung)}
            optionClassName="tab-label px-2"
          />
        </GrantCredentialRow>
        {known && (
          <p className="text-xs leading-relaxed text-ink-faint">
            {`This app holds ${RUNG_LABEL[heldRung!]} there${ceiling !== null ? `; that machine's ceiling is ${RUNG_LABEL[ceiling]}` : ""}.`}
          </p>
        )}
        {aboveCeiling && (
          <p className="text-sm leading-relaxed text-rose" data-ceremony="above-ceiling">
            Above that machine's ceiling — its owner raises the ceiling on that machine.
          </p>
        )}
        {execWarning && (
          <p className="text-sm leading-relaxed text-copper" data-ceremony="exec-off">
            Granted runs would still refuse: that machine has fleet exec off.
          </p>
        )}
        {outcome !== null && (
          <p
            role={outcome.ok ? undefined : "alert"}
            className={cn("text-sm leading-relaxed", outcome.ok ? "text-ink-mid" : "text-rose")}
            data-ceremony="outcome"
          >
            {outcome.ok
              ? `Granted ${RUNG_LABEL[outcome.rung]}.`
              : bindingRefusal
                ? `Refused: ${outcome.reason} — its owner resets this dispatcher's row in Fleet access on that machine.`
                : `Refused: ${outcome.reason}`}
          </p>
        )}
      </div>
    </Modal>
  );
}
