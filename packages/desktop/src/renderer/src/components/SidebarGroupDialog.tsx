import { useEffect, useId, useState, type FormEvent } from "react";
import {
  normalizeSidebarGroupName,
  SIDEBAR_GROUP_NAME_MAX_LENGTH,
} from "@omp-ui/core/sidebar-groups";
import type { ProjectRecord, SidebarGroup } from "@omp-ui/core/types";
import { displayMessage } from "../backend";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { useStore } from "../store";
import type { SidebarGroupDialogRequest } from "../store/types";
import { FIELD } from "./settings/rows";
import { Button, Modal } from "./ui";

const radioRowClass =
  "flex cursor-pointer items-center gap-2.5 rounded-md border border-line bg-raised px-3 py-2 text-xs text-ink-mid transition-colors hover:border-line-strong hover:text-ink has-[:checked]:border-line-strong has-[:checked]:text-ink";

/** The dialog's subject, resolved from live backend state. */
type Subject =
  | { kind: "create" }
  | { kind: "rename"; group: SidebarGroup }
  | { kind: "move"; project: ProjectRecord; currentGroupId: string | null };

/** Move-mode radio choice: an existing group (null = No group) or New group…. */
type Choice = { kind: "existing"; groupId: string | null } | { kind: "new" };

function resolveSubject(
  request: SidebarGroupDialogRequest | null,
  groups: readonly SidebarGroup[],
  projects: readonly ProjectRecord[] | undefined,
): Subject | null {
  if (request === null) return null;
  if (request.kind === "create") return { kind: "create" };
  if (request.kind === "rename") {
    const group = groups.find((g) => g.id === request.groupId);
    return group === undefined ? null : { kind: "rename", group };
  }
  const project = projects?.find((p) => p.path === request.projectPath);
  if (project === undefined) return null;
  const currentGroupId = groups.find((g) => g.projectPaths.includes(project.path))?.id ?? null;
  return { kind: "move", project, currentGroupId };
}

const EMPTY_GROUPS: readonly SidebarGroup[] = Object.freeze([]);

/**
 * Create, rename, or move-into a sidebar group (issue #745; CONTEXT.md
 * "Sidebar group"). The subject is re-derived from live state on every
 * render, so a group or project removed elsewhere while this is open closes
 * the dialog instead of saving against a ghost. Only this computer's own
 * projects are ever grouped.
 */
export function SidebarGroupDialog() {
  const request = useStore((s) => s.sidebarGroupDialog);
  const groups = useStore((s) => s.state?.sidebarGroups ?? EMPTY_GROUPS);
  const projects = useStore((s) => s.state?.projects);
  const close = useStore((s) => s.closeSidebarGroupDialog);
  const subject = resolveSubject(
    request,
    groups,
    projects?.map((p) => p.project),
  );
  const missing = request !== null && subject === null;

  useEffect(() => {
    if (missing) close();
  }, [missing, close]);

  if (request === null || subject === null) return null;
  return <SidebarGroupForm subject={subject} groups={groups} onClose={close} />;
}

function SidebarGroupForm({
  subject,
  groups,
  onClose,
}: {
  subject: Subject;
  groups: readonly SidebarGroup[];
  onClose: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const radioName = useId();
  const createSidebarGroup = useStore((s) => s.createSidebarGroup);
  const renameSidebarGroup = useStore((s) => s.renameSidebarGroup);
  const setProjectSidebarGroup = useStore((s) => s.setProjectSidebarGroup);
  const [name, setName] = useState(subject.kind === "rename" ? subject.group.name : "");
  const [choice, setChoice] = useState<Choice>({
    kind: "existing",
    groupId: subject.kind === "move" ? subject.currentGroupId : null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsName = subject.kind !== "move" || choice.kind === "new";
  const normalized = normalizeSidebarGroupName(name);
  const unchanged =
    subject.kind === "move" &&
    choice.kind === "existing" &&
    choice.groupId === subject.currentGroupId;
  const canSave = !busy && !(needsName && normalized === null) && !unchanged;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      if (subject.kind === "create") {
        await createSidebarGroup(normalized!, null);
      } else if (subject.kind === "rename") {
        await renameSidebarGroup(subject.group.id, normalized!);
      } else if (choice.kind === "new") {
        await createSidebarGroup(normalized!, subject.project.path);
      } else {
        await setProjectSidebarGroup(subject.project.path, choice.groupId);
      }
      onClose();
    } catch (err) {
      setError(displayMessage(err));
      setBusy(false);
    }
  };

  const title =
    subject.kind === "create"
      ? t("dialog.group.createTitle")
      : subject.kind === "rename"
        ? t("dialog.group.renameTitle")
        : t("dialog.group.moveTitle", { name: subject.project.name });

  const nameInput = (
    <input
      type="text"
      aria-label={t("dialog.group.name")}
      maxLength={SIDEBAR_GROUP_NAME_MAX_LENGTH}
      className={cn(FIELD, "w-full")}
      value={name}
      spellCheck={false}
      disabled={busy}
      autoFocus
      onChange={(event) => setName(event.target.value)}
    />
  );

  const radio = (key: string, label: string, checked: boolean, next: Choice) => (
    <label key={key} className={radioRowClass}>
      <input
        type="radio"
        name={radioName}
        className="size-3.5 accent-current"
        checked={checked}
        disabled={busy}
        onChange={() => setChoice(next)}
      />
      <span className="min-w-0 truncate">{label}</span>
    </label>
  );

  return (
    <Modal onClose={onClose} labelledBy={titleId} width="w-[26rem]" mobile="dialog">
      <form onSubmit={(event) => void submit(event)}>
        <div className="border-b border-line px-5 pb-4 pt-5">
          <h2 id={titleId} className="font-display text-lg font-semibold tracking-tight text-ink">
            {title}
          </h2>
        </div>
        <div className="space-y-2 px-5 py-4">
          {subject.kind === "move" ? (
            <div role="radiogroup" aria-labelledby={titleId} className="space-y-2">
              {radio(
                "none",
                t("dialog.group.none"),
                choice.kind === "existing" && choice.groupId === null,
                { kind: "existing", groupId: null },
              )}
              {groups.map((group) =>
                radio(
                  group.id,
                  group.name,
                  choice.kind === "existing" && choice.groupId === group.id,
                  { kind: "existing", groupId: group.id },
                ),
              )}
              {radio("new", t("dialog.group.newOption"), choice.kind === "new", { kind: "new" })}
              {choice.kind === "new" && nameInput}
            </div>
          ) : (
            nameInput
          )}
          {error !== null && (
            <p role="alert" className="text-xs leading-relaxed text-rose">
              {error}
            </p>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("dialog.group.cancel")}
          </Button>
          <Button size="sm" variant="solid" type="submit" disabled={!canSave}>
            {t("dialog.group.save")}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
