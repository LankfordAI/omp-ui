// PROTOTYPE (#753): throwaway.
// The global vault registry: a Settings page ("page") or a section under
// Memory ("memory"). One body serves both: detection block, vault rows, and
// the add / import actions.
import { useEffect, useState } from "react";
import { backendFor } from "../../backend";
import { cn } from "../../lib/cn";
import { FIELD } from "../settings/rows";
import { Button, Chip, Empty, Label, Panel } from "../ui";
import { DETECTION, listEntryFor, vaultRootUri } from "./fixtures";
import { ImportVaultsDialog } from "./ImportVaultsDialog";
import { OpenInObsidian } from "./shared";
import {
  removeVault,
  setDefaultVault,
  setHomeFolder,
  usePrototype753,
  usePrototypeData,
  vaultName,
  type ProtoVault,
} from "./state";
import { VaultPathPicker } from "./VaultPathPicker";

export function VaultRegistryPage() {
  return (
    <div className="space-y-3 px-4 py-3">
      <RegistryBody />
    </div>
  );
}

export function VaultRegistryMemorySection() {
  const proto = usePrototype753();
  if (!proto.active || proto.reg !== "memory") return null;
  return (
    <div className="space-y-3 border-t border-line px-4 pb-3 pt-3">
      <RegistryBody />
    </div>
  );
}

function RegistryBody() {
  const proto = usePrototype753();
  const { vaults, defaultVaultId } = usePrototypeData();
  const [dialog, setDialog] = useState<"picker" | "import" | null>(null);
  const appFound = DETECTION[proto.det].appFound;

  const actions = (
    <>
      <Button size="xs" onClick={() => setDialog("picker")}>
        Add vault…
      </Button>
      <Button
        size="xs"
        disabled={!appFound}
        title={appFound ? undefined : "Obsidian not found on this machine."}
        onClick={() => setDialog("import")}
      >
        Import from Obsidian…
      </Button>
    </>
  );

  return (
    <>
      <div>
        <h3 className="font-display text-sm font-semibold text-ink">Knowledge vault</h3>
        <p className="mt-0.5 text-[11px] text-ink-faint">
          Obsidian vaults omp-ui may read. The agent writes only inside each vault's home folder.
        </p>
      </div>

      <DetectionBlock />

      {vaults.length === 0 ? (
        <Panel>
          <Empty
            title="No vault yet"
            action={<div className="flex flex-wrap items-center justify-center gap-2">{actions}</div>}
          />
        </Panel>
      ) : (
        <>
          <div role="radiogroup" aria-label="Default write vault" className="space-y-2">
            {vaults.map((v) => (
              <VaultRow key={v.id} vault={v} isDefault={v.id === defaultVaultId} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </>
      )}

      {dialog === "picker" && <VaultPathPicker onClose={() => setDialog(null)} />}
      {dialog === "import" && <ImportVaultsDialog onClose={() => setDialog(null)} />}
    </>
  );
}

function DetectionBlock() {
  const proto = usePrototype753();
  return (
    <Panel className="px-3 py-2.5">
      <Label>Detected on this machine</Label>
      <dl className="mt-2 space-y-1.5">
        {DETECTION[proto.det].rows.map((row) => (
          <div key={row.label}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <dt className="w-32 shrink-0 text-[11px] text-ink-dim">{row.label}</dt>
              <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink">
                <span className="min-w-0 truncate">
                  {row.value}
                  {row.detail !== undefined && (
                    <span className="ml-1.5 font-mono text-[11px] text-ink-mid" title={row.detail}>
                      {row.detail}
                    </span>
                  )}
                </span>
                <Chip tone={row.tone} className="ml-auto">
                  {row.chip}
                </Chip>
              </dd>
            </div>
            {row.hint !== undefined && <p className="mt-0.5 text-[10px] text-ink-faint">{row.hint}</p>}
          </div>
        ))}
      </dl>
    </Panel>
  );
}

type FolderStatus = "checking" | "found" | "absent" | "missing";

function VaultRow({ vault, isDefault }: { vault: ProtoVault; isDefault: boolean }) {
  const proto = usePrototype753();
  const [status, setStatus] = useState<FolderStatus>("checking");
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A non-trailing ".obsidian" leaf lists the vault folder filtered to that
  // hidden name; "missing" means the vault folder itself is gone.
  useEffect(() => {
    let live = true;
    setStatus("checking");
    void backendFor(null)
      .browseDirectories(`${vault.path}/.obsidian`)
      .then((r) => {
        if (!live) return;
        if (r.error === null && r.entries.some((e) => e.name === ".obsidian")) setStatus("found");
        else setStatus(r.error === "missing" ? "missing" : "absent");
      });
    return () => {
      live = false;
    };
  }, [vault.path]);

  const entry = listEntryFor(DETECTION[proto.det], vault.path);
  const name = vaultName(vault.path);

  const commitHome = (): void => {
    if (draft === null) return;
    const message = setHomeFolder(vault.id, draft);
    setError(message);
    // Valid: drop the draft so the field shows the normalized stored value.
    if (message === null) setDraft(null);
  };

  return (
    <Panel className="px-3 py-2.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="truncate text-xs font-semibold text-ink">{name}</p>
          <p className="truncate font-mono text-[11px] text-ink-dim" title={vault.path}>
            {vault.path}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <OpenInObsidian uri={vaultRootUri(entry?.id ?? vault.obsidianId, vault.path)} />
          <Button size="xs" variant="ghost" tone="rose" onClick={() => removeVault(vault.id)}>
            Remove
          </Button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {status === "checking" && <Chip>checking…</Chip>}
        {status === "found" && (
          <Chip tone="signal" mono>
            .obsidian/ found
          </Chip>
        )}
        {status === "absent" && (
          <Chip tone="copper" mono>
            no .obsidian/
          </Chip>
        )}
        {status === "missing" && <Chip tone="rose">folder missing</Chip>}
        {entry !== undefined ? <Chip>in Obsidian's list</Chip> : <Chip tone="copper">not in Obsidian's list</Chip>}
      </div>
      {status === "absent" && (
        <p className="mt-1 text-[11px] text-ink-faint">Open this folder in Obsidian once to make it a vault.</p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-mid">
          <input
            type="radio"
            name="p753-default-vault"
            checked={isDefault}
            onChange={() => setDefaultVault(vault.id)}
            className="size-3.5 accent-current"
          />
          Default write vault
        </label>
        <label className="flex min-w-0 flex-1 basis-56 items-center gap-2 text-[11px] text-ink-mid">
          <span className="shrink-0">Home folder</span>
          <input
            type="text"
            value={draft ?? vault.homeFolder}
            spellCheck={false}
            aria-invalid={error !== null}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitHome}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitHome();
              }
            }}
            className={cn(FIELD, "w-full flex-1 font-mono", error !== null && "border-rose-dim")}
          />
        </label>
      </div>
      {error !== null && (
        <p role="alert" className="mt-2 rounded-md border border-rose-dim/50 bg-rose-wash px-3 py-2 text-xs text-rose">
          {error}
        </p>
      )}
    </Panel>
  );
}
