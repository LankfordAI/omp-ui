import { useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { repositoryMembers, type CheckoutEntry } from "../lib/repository-members";
import { useDismissal } from "../lib/use-dismissal";
import { findInstance, findOwner, useStore } from "../store";
import { ICON_STROKE } from "./ui";

/**
 * The composer's machine chip (issue #936): on an unprompted native session
 * whose repository has checkouts on 2+ machines, names the session's machine
 * and lists the other members. Picking one hands it to the composer, which
 * owns the move (moveUnpromptedSession). Neutral chrome only — signal mint is
 * reserved for liveness (ADR-0004).
 */
export function MachineChip({
  tabId,
  disabled,
  onPick,
}: {
  tabId: string;
  disabled: boolean;
  /** Called with the picked member; the composer owns the move. */
  onPick: (member: CheckoutEntry) => void;
}) {
  const t = useT();
  const state = useStore((s) => s.state);
  const owner = useMemo(() => findOwner(state, tabId), [state, tabId]);
  const instanceId = owner?.instanceId ?? null;
  const projectCwd = owner?.record.projectCwd ?? null;
  const members = useMemo(
    () => (projectCwd === null ? [] : repositoryMembers(state, instanceId, projectCwd)),
    [state, instanceId, projectCwd],
  );
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useDismissal({
    open,
    refs: rootRef,
    onClose: () => setOpen(false),
    onEscape: () => setOpen(false),
    restoreFocus: () => triggerRef.current?.focus(),
  });

  if (members.length < 2) return null;

  const nicknames = new Map((state?.remoteInstances ?? []).map((i) => [i.id, i.nickname]));
  const local = t("quickopen.host.local");

  return (
    <span ref={rootRef} className="relative flex min-w-0">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-label={t("composer.machine.label")}
        title={t("composer.machine.title")}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md border border-line px-1.5 font-mono text-[10px] leading-4 text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:text-ink-dim"
      >
        <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
          <rect x="2" y="3" width="12" height="8" rx="1" {...ICON_STROKE} />
          <path d="M6 13.5h4M8 11v2.5" {...ICON_STROKE} />
        </svg>
        <span className="min-w-0 max-w-32 truncate">
          {instanceId === null ? local : (nicknames.get(instanceId) ?? instanceId)}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t("composer.machine.label")}
          className="animate-rise edge-lit absolute bottom-full left-0 z-20 mb-1 flex w-60 flex-col rounded-md border border-line-strong bg-overlay p-1"
        >
          {members.map((m) => {
            const current = m.instanceId === instanceId && m.projectCwd === projectCwd;
            const unreachable = m.instanceId !== null && findInstance(state, m.instanceId)?.status !== "joined";
            // The path disambiguates a remote checkout or a same-machine twin.
            const showPath =
              m.instanceId !== null || members.filter((o) => o.instanceId === m.instanceId).length > 1;
            return (
              <button
                key={`${m.instanceId ?? "local"}\u0000${m.projectCwd}`}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                disabled={unreachable}
                title={unreachable ? t("composer.machine.unreachable") : m.projectCwd}
                onClick={() => {
                  setOpen(false);
                  if (!current) onPick(m);
                }}
                className={cn(
                  "flex flex-col rounded px-1.5 py-0.5 text-left font-mono text-[11px] hover:bg-hover",
                  // No pointer-events-none: the disabled row carries its hint
                  // as a tooltip, which hover must still reach.
                  "disabled:text-ink-dim disabled:hover:bg-transparent",
                  current ? "text-iris" : "text-ink-mid",
                )}
              >
                <span className="truncate">
                  {m.instanceId === null ? local : (nicknames.get(m.instanceId) ?? m.instanceId)}
                </span>
                {showPath && <span className="truncate text-[10px] text-ink-faint">{m.projectCwd}</span>}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
