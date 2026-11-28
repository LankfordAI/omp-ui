import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  LOCAL_MACHINE_KEY,
  fleetRungAtLeast,
  type FleetMachine,
  type ProjectCopyPreview,
  type ProjectCopySkipReason,
} from "@omp-ui/core/fleet";
import { backend } from "../../backend";
import { useLoad } from "../../lib/load";
import { useStore } from "../../store";
import { Button, Chip, ConfirmDialog, Switch } from "../ui";

function skipLabel(reason: ProjectCopySkipReason, envName?: string | null): string {
  switch (reason) {
    case "too-large": return "over 1 MB";
    case "over-total": return "over the 8 MB total";
    case "too-many": return "over 500 files";
    case "provider-key": return `names ${envName ?? ""}`;
    case "symlink": return "symlink";
    case "folder-too-large": return "folder over 50 files";
    case "unreadable": return "unreadable";
  }
}

/** Why a member cannot take a copy, or null when it can. */
function memberBlock(machine: FleetMachine): string | null {
  if (machine.status !== "ready") return "not connected";
  // A timed-out probe is an unknown, not a refusal (issue #1398): the row is
  // ineligible with its own copy instead of a surprising "needs Manage".
  if (machine.grantRung === null) return "access unknown — that machine did not answer the access probe; Reconnect or Refresh state on its settings row";
  if (!fleetRungAtLeast(machine.grantRung, "manage")) return "needs the Manage projects rung on that machine";
  if (machine.report?.projectRoots?.length === 0) return "declares no fleet project roots";
  return null;
}

/** True when the block is the rung refusal, so the row offers Request access. */
function isRungBlock(machine: FleetMachine): boolean {
  return machine.status === "ready" && machine.grantRung !== null && !fleetRungAtLeast(machine.grantRung, "manage");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Copy project to… (issue #992), launched from a project page in the Project
 * quick-open for one of this computer's checkouts. Like the Provider key
 * rollout picker, this only picks: Continue stages a lifecycle confirmation
 * that names the member, the file count, and the join transport. The member
 * clones the repository's https remote into one of its declared project roots
 * and registers it. The opt-in switch (off by default) lists this checkout's
 * gitignored files for confirmation; only their names leave this dialog —
 * main reads the bytes at confirm time and sends them main-to-main.
 */
export function CopyProjectDialog({ projectCwd, name }: { projectCwd: string; name: string }) {
  const close = useStore((s) => s.closeCopyProjectDialog);
  const stageLifecycleConfirmation = useStore((s) => s.stageLifecycleConfirmation);
  const openGrantCeremony = useStore((s) => s.openGrantCeremony);
  const grantCeremony = useStore((s) => s.grantCeremony);
  const readMachines = useCallback(() => backend.fleetMachines(), []);
  const { load: machinesLoad, retry: reloadMachines } = useLoad(readMachines);
  const [withFiles, setWithFiles] = useState(false);
  const readPreview = useCallback(() => backend.fleetProjectCopyPreview(projectCwd), [projectCwd]);
  const { load: previewLoad } = useLoad<ProjectCopyPreview>(readPreview);
  const [picked, setPicked] = useState<string | null>(null);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(() => new Set());
  // A granted ceremony unlocks the member in place: re-read the machine list
  // once the modal closes (issue #1398).
  const wasCeremonyOpen = useRef(false);
  useEffect(() => {
    if (grantCeremony !== null) {
      wasCeremonyOpen.current = true;
    } else if (wasCeremonyOpen.current) {
      wasCeremonyOpen.current = false;
      if (machinesLoad.status === "loaded") reloadMachines();
    }
  }, [grantCeremony, machinesLoad.status, reloadMachines]);

  const members = useMemo(
    () => (machinesLoad.status === "loaded" ? machinesLoad.value.filter((m) => m.key !== LOCAL_MACHINE_KEY) : []),
    [machinesLoad],
  );
  const eligible = members.filter((m) => memberBlock(m) === null);
  const target = members.find((m) => m.key === picked && memberBlock(m) === null) ?? eligible[0] ?? null;
  const preview = previewLoad.status === "loaded" ? previewLoad.value : null;
  const files = withFiles && preview !== null ? preview.files.map((f) => f.path).filter((p) => !unchecked.has(p)) : [];

  const toggle = (rel: string, checked: boolean): void => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(rel);
      else next.add(rel);
      return next;
    });
  };

  const submit = (): void => {
    if (target === null || target.nickname === null) return;
    const encrypted = (useStore.getState().state?.remoteInstances.find((i) => i.id === target.key)?.url ?? "").startsWith(
      "https:",
    );
    // Staging the gate closes this picker; the confirmation carries the decision.
    close();
    stageLifecycleConfirmation({
      kind: "copy-project",
      instanceId: target.key,
      targetLabel: target.nickname,
      projectCwd,
      projectName: name,
      files,
      encrypted,
    });
  };

  let membersBody: ReactNode;
  if (machinesLoad.status === "idle" || machinesLoad.status === "loading") {
    membersBody = <p className="text-xs text-ink-faint">Reading fleet members…</p>;
  } else if (machinesLoad.status === "error") {
    membersBody = <p className="text-xs text-rose">{machinesLoad.message}</p>;
  } else if (members.length === 0) {
    membersBody = <p className="text-xs text-ink-faint">No joined remote instance can receive a copy.</p>;
  } else {
    membersBody = (
      <ul className="space-y-1.5" role="radiogroup" aria-label="Fleet member">
        {members.map((machine) => {
          const block = memberBlock(machine);
          const roots = machine.report?.projectRoots ?? null;
          const rungBlocked = isRungBlock(machine);
          return (
            <li key={machine.key}>
              <label
                className={
                  block === null
                    ? "flex cursor-pointer items-center gap-2.5 rounded-md border border-line bg-raised px-3 py-2 text-xs text-ink-mid transition-colors hover:border-line-strong hover:text-ink"
                    : "flex items-center gap-2.5 rounded-md border border-line px-3 py-2 text-xs text-ink-faint opacity-70"
                }
              >
                <input
                  type="radio"
                  name="copy-project-member"
                  checked={target?.key === machine.key}
                  disabled={block !== null}
                  onChange={() => setPicked(machine.key)}
                  className="size-3.5 accent-current"
                  data-machine={machine.key}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink">{machine.nickname ?? machine.key}</span>
                  <span className="block truncate font-mono text-xs text-ink-faint">
                    {block !== null
                      ? block
                      : roots === null
                        ? "project roots not reported"
                        : `into ${roots.join(", ")}`}
                  </span>
                </span>
                {/* The rung refusal gets its way in (issue #1398): opening the
                    ceremony keeps this dialog open; a grant re-reads the list. */}
                {rungBlocked && (
                  <Button
                    size="xs"
                    variant="ghost"
                    data-request-access={machine.key}
                    onClick={() =>
                      openGrantCeremony(machine.key, machine.nickname ?? machine.key, "manage")
                    }
                  >
                    Request access…
                  </Button>
                )}
              </label>
            </li>
          );
        })}
      </ul>
    );
  }

  let filesBody: ReactNode = null;
  if (withFiles) {
    if (previewLoad.status === "idle" || previewLoad.status === "loading") {
      filesBody = <p className="text-xs text-ink-faint">Reading this checkout's gitignored files…</p>;
    } else if (previewLoad.status === "error") {
      filesBody = <p className="text-xs text-rose">{previewLoad.message}</p>;
    } else if (preview !== null) {
      filesBody = (
        <div className="space-y-2">
          {preview.files.length === 0 ? (
            <p className="text-xs text-ink-faint">This checkout has no gitignored file to copy.</p>
          ) : (
            <ul className="max-h-48 space-y-1 overflow-y-auto">
              {preview.files.map((file) => (
                <li key={file.path}>
                  <label className="flex cursor-pointer items-center gap-2.5 px-1 text-xs text-ink-mid hover:text-ink">
                    <input
                      type="checkbox"
                      checked={!unchecked.has(file.path)}
                      onChange={(event) => toggle(file.path, event.target.checked)}
                      className="size-3.5 accent-current"
                      data-file={file.path}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
                    <span className="shrink-0 text-xs text-ink-faint">{formatBytes(file.bytes)}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {preview.skipped.length > 0 && (
            <div>
              <p className="mb-1 text-xs text-ink-dim">Not copied</p>
              <ul className="max-h-32 space-y-0.5 overflow-y-auto">
                {preview.skipped.map((skip) => (
                  <li key={skip.path} className="flex items-center gap-2 px-1 text-xs text-ink-faint">
                    <span className="min-w-0 flex-1 truncate font-mono">{skip.path}</span>
                    <Chip tone={skip.reason === "provider-key" ? "rose" : "neutral"}>
                      {skipLabel(skip.reason, skip.envName)}
                    </Chip>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      );
    }
  }

  // The route note: a member clones with no credential of its own (ADR-0064).
  const remoteNote =
    preview === null
      ? null
      : preview.remote === "none"
        ? "This checkout has no web remote to clone. Ask an agent to provision the machine over its own ssh instead."
        : preview.remote === "ssh"
          ? "This checkout reaches its remote over SSH. The machine clones over HTTPS without credentials, so a private repository fails; ask an agent to provision it over its own ssh instead."
          : null;

  return (
    <ConfirmDialog
      kicker="fleet"
      title={`Copy ${name} to another machine`}
      tone="copper"
      onClose={close}
      width="w-[32rem]"
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="solid"
            tone="copper"
            initialFocus
            disabled={target === null || (withFiles && previewLoad.status !== "loaded") || preview?.remote === "none"}
            onClick={submit}
          >
            Continue
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-dim">The machine you pick clones this repository from its remote into one of its fleet project roots and registers it there.</p>
        {membersBody}
        <div className="flex items-center gap-2.5 border-t border-line pt-3">
          <Switch on={withFiles} onChange={setWithFiles} label="Also copy gitignored files" />
          <span className="text-xs text-ink-mid">Also copy gitignored files</span>
        </div>
        {withFiles && <p className="text-xs text-ink-faint">Files up to 1 MB each, 8 MB in total. Files that name a Provider key are never copied; roll keys out from the Fleet view instead.</p>}
        {filesBody}
        {remoteNote !== null && <p className="text-xs text-copper">{remoteNote}</p>}
      </div>
    </ConfirmDialog>
  );
}
