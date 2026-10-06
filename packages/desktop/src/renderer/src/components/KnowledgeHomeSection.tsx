import { useCallback, useMemo } from "react";
import type { KnowledgeHome, KnowledgeHomeKind, ProjectRecord } from "@omp-ui/core/types";
import { cn } from "../lib/cn";
import { useT, type MessageKey } from "../lib/i18n";
import { useLoad } from "../lib/load";
import { useStore } from "../store";
import { FIELD } from "./settings/rows";
import { Button } from "./ui";

const KINDS: { kind: KnowledgeHomeKind; labelKey: MessageKey }[] = [
  { kind: "docs", labelKey: "project.settings.knowledgeDocs" },
  { kind: "vault", labelKey: "project.settings.knowledgeVault" },
  { kind: "both", labelKey: "project.settings.knowledgeBoth" },
];

const ROSE_LINE = "rounded-md border border-rose-dim/50 bg-rose-wash px-3 py-2 text-xs text-rose";

/**
 * The project's Knowledge home (issue #766): where the agent files decisions
 * and lessons — repo docs, a vault, or both. Stored in omp-ui's registry
 * (`ProjectRecord.knowledgeHome`); null means the routing default decides at
 * spawn. A vault pin is optional — absent, the vault follows the Default write
 * vault. Vault names come from this host's registry, or for a joined project
 * from the owning instance over `vault:names`. Writes never build a vault key
 * holding undefined: the backend codec rejects it.
 */
export function KnowledgeHomeSection({ project, instanceId }: { project: ProjectRecord; instanceId: string | null }) {
  const t = useT();
  const setProjectKnowledgeHome = useStore((s) => s.setProjectKnowledgeHome);
  const openSettings = useStore((s) => s.openSettings);
  const vaultNames = useStore((s) => s.vaultNames);
  // Select the stable registry object; a freshly mapped array would re-render forever.
  const registry = useStore((s) => s.state?.vaultRegistry);
  const localNames = useMemo(() => registry?.vaults.map((v) => v.name) ?? [], [registry]);
  const read = useCallback(() => vaultNames(instanceId), [instanceId, vaultNames]);
  const { load } = useLoad(instanceId === null ? null : read);

  const names: string[] | null =
    instanceId === null ? localNames : load.status === "loaded" ? load.value : null;
  const current = project.knowledgeHome;
  // The pinned name when it no longer matches a registered vault, else null.
  const brokenPin =
    current?.vault !== undefined && names !== null && !names.includes(current.vault) ? current.vault : null;
  const noVault = names !== null && names.length === 0;
  const vaultDisabled = names === null || noVault;

  const write = (next: KnowledgeHome | null): void => {
    void setProjectKnowledgeHome(project.path, next, instanceId);
  };

  const pickKind = (kind: KnowledgeHomeKind): void => {
    if (kind === current?.home) return;
    write(current?.vault === undefined ? { home: kind } : { home: kind, vault: current.vault });
  };

  const pickVault = (value: string): void => {
    if (current === null) return;
    write(value === "" ? { home: current.home } : { home: current.home, vault: value });
  };

  return (
    <section aria-labelledby="project-settings-knowledge" className="px-4 py-4">
      <h3 id="project-settings-knowledge" className="mb-1 font-display text-sm font-semibold text-ink">
        {t("project.settings.knowledgeHome")}
      </h3>
      <p className="text-[11px] leading-relaxed text-ink-faint">{t("project.settings.knowledgeHint")}</p>

      {load.status === "error" && <p className={cn("mt-2", ROSE_LINE)}>{load.message}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span
          role="radiogroup"
          aria-label={t("project.settings.knowledgeHome")}
          className="flex flex-wrap items-center gap-1"
        >
          {KINDS.map(({ kind, labelKey }) => {
            const checked = current?.home === kind;
            const needsVault = kind !== "docs";
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={needsVault ? vaultDisabled : undefined}
                title={needsVault && noVault ? t("project.settings.knowledgeNeedsVault") : undefined}
                onClick={() => pickKind(kind)}
                className={cn(
                  "rounded-md px-2 py-0.5 text-[11px] transition-colors",
                  checked
                    ? "bg-raised text-ink"
                    : "text-ink-faint hover:text-ink-mid disabled:cursor-not-allowed disabled:opacity-35",
                )}
              >
                {kind === "vault" && names?.length === 1
                  ? t("project.settings.knowledgeVaultNamed", { name: names[0]! })
                  : t(labelKey)}
              </button>
            );
          })}
        </span>
        {current !== null && (
          <Button size="xs" variant="ghost" onClick={() => write(null)}>
            {t("project.settings.knowledgeClear")}
          </Button>
        )}
      </div>

      {current === null && <p className="mt-2 text-[11px] text-ink-dim">{t("project.settings.knowledgeNotSet")}</p>}

      {names !== null && (names.length >= 2 || brokenPin !== null) && (
        <select
          aria-label={t("project.settings.knowledgeHome")}
          className={cn(FIELD, "mt-2")}
          disabled={current === null}
          value={current?.vault ?? ""}
          onChange={(event) => pickVault(event.target.value)}
        >
          {brokenPin !== null && (
            <option value={brokenPin} disabled>
              {brokenPin}
            </option>
          )}
          <option value="">{t("project.settings.knowledgeFollowDefault")}</option>
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      )}

      {brokenPin !== null && (
        <p className={cn("mt-2", ROSE_LINE)}>{t("project.settings.knowledgeBroken", { name: brokenPin })}</p>
      )}

      {noVault && instanceId === null && (
        <Button size="xs" variant="ghost" className="mt-2" onClick={() => openSettings("knowledge-vault")}>
          {t("project.settings.knowledgeOpenSettings")}
        </Button>
      )}
    </section>
  );
}
