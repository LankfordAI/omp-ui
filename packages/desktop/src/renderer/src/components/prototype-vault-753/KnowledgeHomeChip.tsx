// PROTOTYPE (#753): throwaway.
// Per-project knowledge home: repo docs, a vault, or both. Two placements: a
// "Knowledge" tab body in Project settings, or a chip line under the project
// path in that dialog's header. Styled like the scope chips in
// settings/SubagentModelsSection.tsx.
import type { ProjectRecord } from "@omp-ui/core/types";
import { cn } from "../../lib/cn";
import { useStore } from "../../store";
import { Label } from "../ui";
import { setKnowledgeHome, usePrototype753, usePrototypeData, vaultName, type ProtoHomeKind } from "./state";

const NO_VAULT_TITLE = "Add a vault in Settings first";

/** Same look as settings/rows.tsx FIELD, one notch smaller to sit beside the chips. */
const SELECT =
  "h-6 min-w-0 max-w-[12rem] rounded-md border border-line bg-raised px-1.5 text-[11px] text-ink " +
  "transition-colors duration-150 focus:border-line-strong focus:outline-none";

const LINK = "text-[11px] text-ink-mid underline underline-offset-2 hover:text-ink";

function HomeChoice({ project }: { project: ProjectRecord }) {
  const proto = usePrototype753();
  const { vaults, defaultVaultId, knowledgeHome } = usePrototypeData();
  const openSettings = useStore((s) => s.openSettings);
  const home = knowledgeHome[project.path] ?? null;
  const noVault = vaults.length === 0;
  const onlyVault = vaults.length === 1 ? vaults[0]! : null;
  // vaultId null means the default write vault; a removed vault falls back to it too.
  const pickedVaultId =
    home?.vaultId != null && vaults.some((v) => v.id === home.vaultId) ? home.vaultId : defaultVaultId;

  const choices: { kind: ProtoHomeKind; label: string }[] = [
    { kind: "repo", label: "Repo docs" },
    { kind: "vault", label: onlyVault !== null ? `Vault: ${vaultName(onlyVault.path)}` : "Vault" },
    { kind: "both", label: "Both" },
  ];

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="flex items-center gap-1" role="radiogroup" aria-label="Knowledge home">
        {choices.map(({ kind, label }) => {
          const disabled = kind !== "repo" && noVault;
          const checked = home?.kind === kind;
          return (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={disabled}
              title={disabled ? NO_VAULT_TITLE : undefined}
              onClick={() =>
                setKnowledgeHome(project.path, { kind, vaultId: kind === "repo" ? null : (home?.vaultId ?? null) })
              }
              className={cn(
                "rounded-md px-2 py-0.5 text-[11px] transition-colors",
                checked
                  ? "bg-raised text-ink"
                  : "text-ink-faint hover:text-ink-mid disabled:pointer-events-none disabled:opacity-35",
              )}
            >
              {label}
            </button>
          );
        })}
      </span>
      {vaults.length >= 2 && (home?.kind === "vault" || home?.kind === "both") && (
        <select
          aria-label="Vault"
          value={pickedVaultId ?? ""}
          onChange={(event) => {
            if (home === null) return;
            const id = event.target.value;
            setKnowledgeHome(project.path, { kind: home.kind, vaultId: id === defaultVaultId ? null : id });
          }}
          className={SELECT}
        >
          {vaults.map((v) => (
            <option key={v.id} value={v.id}>
              {vaultName(v.path)}
            </option>
          ))}
        </select>
      )}
      {noVault && (
        <button
          type="button"
          className={LINK}
          onClick={() => openSettings(proto.reg === "page" ? "vaults" : "memory")}
        >
          Open Settings
        </button>
      )}
      {home === null ? (
        <span className="text-[11px] text-ink-faint">Not set. The routing default applies.</span>
      ) : (
        <button type="button" className={LINK} onClick={() => setKnowledgeHome(project.path, null)}>
          Clear
        </button>
      )}
    </span>
  );
}

/** Tab body for the "Knowledge" Project settings tab (chip variant "tab"). */
export function KnowledgeHomeSection({ project }: { project: ProjectRecord }) {
  return (
    <section aria-labelledby="project-settings-knowledge" className="px-4 py-4">
      <h3 id="project-settings-knowledge" className="mb-3 font-display text-sm font-semibold text-ink">
        Knowledge home
      </h3>
      <KnowledgeHomeChip project={project} placement="tab" />
      <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
        Where the agent files decisions and lessons for this project.
      </p>
    </section>
  );
}

export function KnowledgeHomeChip({
  project,
  placement,
}: {
  project: ProjectRecord;
  placement: "tab" | "header";
}) {
  const proto = usePrototype753();
  if (!proto.active) return null;
  if (placement === "tab") return <HomeChoice project={project} />;
  if (proto.chip !== "header") return null;
  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <Label>Knowledge home</Label>
      <HomeChoice project={project} />
    </div>
  );
}
