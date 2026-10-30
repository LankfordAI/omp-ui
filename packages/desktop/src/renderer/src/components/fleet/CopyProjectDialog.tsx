import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  LOCAL_MACHINE_KEY,
  fleetRungAtLeast,
  type FleetMachine,
  type ProjectCopyPreview,
  type ProjectCopySkipReason,
} from "@omp-ui/core/fleet";
import { backend } from "../../backend";
import { useT, type MessageKey } from "../../lib/i18n";
import { useLoad } from "../../lib/load";
import { useStore } from "../../store";
import { Button, Chip, ConfirmDialog, Switch } from "../ui";

const SKIP_LABEL: Record<ProjectCopySkipReason, MessageKey> = {
  "too-large": "copyproject.skip.tooLarge",
  "over-total": "copyproject.skip.overTotal",
  "too-many": "copyproject.skip.tooMany",
  "provider-key": "copyproject.skip.providerKey",
  symlink: "copyproject.skip.symlink",
  "folder-too-large": "copyproject.skip.folderTooLarge",
  unreadable: "copyproject.skip.unreadable",
};

/** Why a member cannot take a copy, or null when it can. */
function memberBlock(machine: FleetMachine): MessageKey | null {
  if (machine.status !== "ready") return "copyproject.member.notReady";
  if (machine.grantRung !== null && !fleetRungAtLeast(machine.grantRung, "manage")) return "copyproject.member.needsManage";
  if (machine.report?.projectRoots?.length === 0) return "copyproject.member.noRoots";
  return null;
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
  const t = useT();
  const close = useStore((s) => s.closeCopyProjectDialog);
  const stageLifecycleConfirmation = useStore((s) => s.stageLifecycleConfirmation);
  const readMachines = useCallback(() => backend.fleetMachines(), []);
  const { load: machinesLoad } = useLoad(readMachines);
  const [withFiles, setWithFiles] = useState(false);
  const readPreview = useCallback(() => backend.fleetProjectCopyPreview(projectCwd), [projectCwd]);
  const { load: previewLoad } = useLoad<ProjectCopyPreview>(readPreview);
  const [picked, setPicked] = useState<string | null>(null);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(() => new Set());

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
    membersBody = <p className="text-xs text-ink-faint">{t("copyproject.members.loading")}</p>;
  } else if (machinesLoad.status === "error") {
    membersBody = <p className="text-xs text-rose">{machinesLoad.message}</p>;
  } else if (members.length === 0) {
    membersBody = <p className="text-xs text-ink-faint">{t("copyproject.members.none")}</p>;
  } else {
    membersBody = (
      <ul className="space-y-1.5" role="radiogroup" aria-label={t("copyproject.members.label")}>
        {members.map((machine) => {
          const block = memberBlock(machine);
          const roots = machine.report?.projectRoots ?? null;
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
                  <span className="block truncate font-mono text-[10px] text-ink-faint">
                    {block !== null
                      ? t(block)
                      : roots === null
                        ? t("copyproject.member.rootsUnknown")
                        : t("copyproject.member.roots", { roots: roots.join(", ") })}
                  </span>
                </span>
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
      filesBody = <p className="text-xs text-ink-faint">{t("copyproject.files.loading")}</p>;
    } else if (previewLoad.status === "error") {
      filesBody = <p className="text-xs text-rose">{previewLoad.message}</p>;
    } else if (preview !== null) {
      filesBody = (
        <div className="space-y-2">
          {preview.files.length === 0 ? (
            <p className="text-xs text-ink-faint">{t("copyproject.files.none")}</p>
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
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{file.path}</span>
                    <span className="shrink-0 text-[10px] text-ink-faint">{formatBytes(file.bytes)}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {preview.skipped.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] text-ink-dim">{t("copyproject.files.skipped")}</p>
              <ul className="max-h-32 space-y-0.5 overflow-y-auto">
                {preview.skipped.map((skip) => (
                  <li key={skip.path} className="flex items-center gap-2 px-1 text-[11px] text-ink-faint">
                    <span className="min-w-0 flex-1 truncate font-mono">{skip.path}</span>
                    <Chip tone={skip.reason === "provider-key" ? "rose" : "neutral"}>
                      {t(SKIP_LABEL[skip.reason], { env: skip.envName ?? "" })}
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
    preview === null ? null : preview.remote === "none" ? "copyproject.remote.none" : preview.remote === "ssh" ? "copyproject.remote.ssh" : null;

  return (
    <ConfirmDialog
      kicker={t("fleet.header.title")}
      title={t("copyproject.title", { name })}
      tone="copper"
      onClose={close}
      width="w-[32rem]"
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            {t("dialog.migrate.cancel")}
          </Button>
          <Button
            variant="solid"
            tone="copper"
            initialFocus
            disabled={target === null || (withFiles && previewLoad.status !== "loaded") || preview?.remote === "none"}
            onClick={submit}
          >
            {t("copyproject.continue")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-dim">{t("copyproject.intro")}</p>
        {membersBody}
        <div className="flex items-center gap-2.5 border-t border-line pt-3">
          <Switch on={withFiles} onChange={setWithFiles} label={t("copyproject.files.toggle")} />
          <span className="text-xs text-ink-mid">{t("copyproject.files.toggle")}</span>
        </div>
        {withFiles && <p className="text-[11px] text-ink-faint">{t("copyproject.files.hint")}</p>}
        {filesBody}
        {remoteNote !== null && <p className="text-[11px] text-copper">{t(remoteNote)}</p>}
      </div>
    </ConfirmDialog>
  );
}
