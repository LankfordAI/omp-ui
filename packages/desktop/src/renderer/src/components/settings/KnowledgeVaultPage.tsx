import { useCallback, useState } from "react";
import type { VaultDetection, VaultRegistry, VaultRegistryEntry } from "@omp-ui/core/types";
import { backend, displayMessage } from "../../backend";
import { cn } from "../../lib/cn";
import { useLoad, type Load } from "../../lib/load";
import { useStore } from "../../store";
import { DirectoryPicker } from "../DirectoryPicker";
import { OpenInObsidianButton } from "../OpenInObsidianButton";
import { Button, Chip, ChoiceCapsule, Empty, Label, Panel, Switch, type Tone } from "../ui";
import { CommitField, Row } from "./rows";
import { VaultImportDialog } from "./VaultImportDialog";

/**
 * The "Knowledge vault" Settings page (issue #764): what this machine's
 * Obsidian install exposes, the Vault registry rows, and the add / import
 * actions. Every write goes through a `vault:*` channel on the local backend
 * (on a web client, the host's — #759); the page re-reads detection whenever
 * the registry broadcast changes it.
 */

const EMPTY_REGISTRY: VaultRegistry = { vaults: [], defaultWriteVault: null };

export function KnowledgeVaultPage() {
  const registry = useStore((s) => s.state?.vaultRegistry) ?? EMPTY_REGISTRY;
  const voice = useStore((s) => s.state?.vaultNoteVoice) ?? "user";
  const setVaultNoteVoice = useStore((s) => s.setVaultNoteVoice);
  const addVault = useStore((s) => s.addVault);
  const [dialog, setDialog] = useState<"picker" | "import" | null>(null);
  // Keyed on the registry's content, not its identity: every BackendState
  // broadcast carries a fresh object, and only a registry change can move a
  // row's status or an entry's "added" chip.
  const registryKey = JSON.stringify(registry);
  const read = useCallback(() => backend.detectVaults(), [registryKey]);
  const { load } = useLoad(read);
  const detection = load.status === "loaded" ? load.value : null;

  const close = (): void => setDialog(null);
  const importDisabled = detection === null || detection.obsidianList.length === 0;

  const actions = (
    <>
      <Button size="xs" onClick={() => setDialog("picker")}>
        Add vault…
      </Button>
      <Button
        size="xs"
        disabled={importDisabled}
        title={importDisabled ? "Obsidian's vault list was not found on this machine." : undefined}
        onClick={() => setDialog("import")}
      >
        Import from Obsidian…
      </Button>
    </>
  );

  return (
    <div className="space-y-3 px-4 py-3">
      <div>
        <h3 className="text-base font-semibold text-ink">Knowledge vault</h3>
        <p className="mt-0.5 text-sm text-ink-faint">Obsidian vaults omp-ui may read. The agent writes only inside each vault's home folder.</p>
      </div>

      <DetectionPanel load={load} />

      {registry.vaults.length === 0 ? (
        <Panel>
          <Empty
            title="No vault yet"
            action={<div className="flex flex-wrap items-center justify-center gap-2">{actions}</div>}
          />
        </Panel>
      ) : (
        <>
          <div role="radiogroup" aria-label="Default write vault" className="space-y-2">
            {registry.vaults.map((entry) => (
              <VaultRow
                key={entry.name}
                entry={entry}
                isDefault={entry.name === registry.defaultWriteVault}
                row={detection?.rows[entry.name] ?? null}
                uriHandler={detection?.uriHandler}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
          <Row title="Note voice" hint="Whose voice the agent uses when it writes vault note bodies. Applies to sessions started afterwards.">
            <ChoiceCapsule
              label="Note voice"
              value={voice}
              options={[
                { value: "user", label: "On my behalf" },
                { value: "assistant", label: "As the assistant" },
              ]}
              onChange={(v) => void setVaultNoteVoice(v)}
              optionClassName="tab-label px-2"
            />
          </Row>
        </>
      )}

      {dialog === "picker" && (
        <DirectoryPicker
          mode="vault"
          instanceId={null}
          banner={null}
          onClose={close}
          onSubmit={async (path) => {
            await addVault(path);
            close();
          }}
        />
      )}
      {dialog === "import" && detection !== null && (
        <VaultImportDialog entries={detection.obsidianList} onClose={close} />
      )}
    </div>
  );
}

interface DetectionRow {
  label: string;
  /** Null while detection is in flight: the value cell stays empty. */
  chip: { text: string; tone: Tone } | null;
  /** Wrapping mono detail beside the value (the obsidian.json path). */
  detail?: string;
  hint?: string;
}

function DetectionPanel({ load }: { load: Load<VaultDetection> }) {
  const d = load.status === "loaded" ? load.value : null;
  const rows: DetectionRow[] = [
    {
      label: "Obsidian app",
      chip:
        d === null
          ? null
          : d.obsidianListFile !== null
            ? { text: "found", tone: "signal" }
            : { text: "not found", tone: "copper" },
      detail: d?.obsidianListFile ?? undefined,
    },
    {
      label: "Vault list",
      chip:
        d === null
          ? null
          : d.obsidianListFile !== null
            ? { text: "read", tone: "signal" }
            : { text: "none", tone: "neutral" },
    },
    {
      label: "Command line",
      chip:
        d === null
          ? null
          : d.cliRegistered
            ? { text: "registered", tone: "signal" }
            : { text: "not registered", tone: "neutral" },
      hint:
        d === null
          ? undefined
          : d.cliRegistered
            ? "Optional. omp-ui works without it."
            : `${"Turn on Settings, General, Command line interface in Obsidian."} ${"Optional. omp-ui works without it."}`,
    },
    {
      label: "obsidian:// links",
      chip:
        d === null
          ? null
          : d.uriHandler
            ? { text: "handled", tone: "signal" }
            : { text: "no handler", tone: "copper" },
    },
  ];

  return (
    <Panel className="px-3 py-2.5">
      <Label>Detected on this machine</Label>
      {load.status === "error" ? (
        <p className="mt-2 text-xs text-rose">{load.message}</p>
      ) : (
        <dl className="mt-2 space-y-1.5">
          {rows.map((row) => (
            <div key={row.label}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <dt className="w-32 shrink-0 text-xs text-ink-dim">{row.label}</dt>
                <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink">
                  {row.detail !== undefined && (
                    <span className="min-w-0 break-all font-mono text-xs text-ink-mid">{row.detail}</span>
                  )}
                  {row.chip !== null && (
                    <Chip tone={row.chip.tone} className="ml-auto">
                      {row.chip.text}
                    </Chip>
                  )}
                </dd>
              </div>
              {row.hint !== undefined && <p className="mt-0.5 text-sm text-ink-faint">{row.hint}</p>}
            </div>
          ))}
        </dl>
      )}
      <p className="mt-2 text-xs text-ink-faint">omp's own vault:// protocol stays off in omp-ui sessions, so every vault write goes through the home folder boundary.</p>
    </Panel>
  );
}

function VaultRow({
  entry,
  isDefault,
  row,
  uriHandler,
}: {
  entry: VaultRegistryEntry;
  isDefault: boolean;
  row: VaultDetection["rows"][string] | null;
  uriHandler: boolean | undefined;
}) {
  const removeVault = useStore((s) => s.removeVault);
  const setDefaultWriteVault = useStore((s) => s.setDefaultWriteVault);
  const setVaultHomeFolder = useStore((s) => s.setVaultHomeFolder);
  const setVaultWritesOutsideHome = useStore((s) => s.setVaultWritesOutsideHome);
  const [error, setError] = useState<string | null>(null);

  return (
    <Panel className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-ink">{entry.name}</span>
        <span className="min-w-0 break-all font-mono text-xs text-ink-dim">{entry.path}</span>
        <span className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">
          <OpenInObsidianButton vaultName={entry.name} file={null} uriHandler={uriHandler} />
          <Button size="xs" variant="ghost" tone="rose" onClick={() => void removeVault(entry.name)}>
            Remove
          </Button>
        </span>
      </div>

      {row !== null && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            {row.status === "no-obsidian-dir" && (
              <Chip tone="copper" mono>
                no .obsidian/
              </Chip>
            )}
            {row.status === "missing" && <Chip tone="rose">folder missing</Chip>}
            {row.status === "refused-root" && <Chip tone="rose">folder not allowed</Chip>}
            {row.inObsidianList ? (
              <Chip>in Obsidian's list</Chip>
            ) : (
              <Chip tone="copper">not in Obsidian's list</Chip>
            )}
          </div>
          {row.status === "no-obsidian-dir" && (
            <p className="mt-1 text-sm text-ink-faint">Open this folder in Obsidian once to make it a vault.</p>
          )}
          {row.status === "refused-root" && (
            <p className="mt-1 text-sm text-ink-faint">omp-ui never uses your home folder, the filesystem root, or an omp or omp-ui data folder as a vault.</p>
          )}
        </>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-mid">
          <input
            type="radio"
            name="knowledge-vault-default"
            checked={isDefault}
            onChange={() => void setDefaultWriteVault(entry.name)}
            className="size-3.5 accent-current"
          />
          Default write vault
        </label>
        <label className="flex min-w-0 flex-1 basis-56 items-center gap-2 text-xs text-ink-mid">
          <span className="shrink-0">Home folder</span>
          <CommitField
            current={entry.homeFolder}
            kind="text"
            label="Home folder"
            disabled={false}
            className={cn("w-full flex-1 font-mono", error !== null && "border-rose-dim")}
            onCommit={(raw) => {
              setError(null);
              void setVaultHomeFolder(entry.name, raw).catch((err: unknown) => setError(displayMessage(err)));
            }}
          />
        </label>
      </div>
      {error !== null && (
        <p role="alert" className="mt-2 rounded-md border border-rose-dim/50 bg-rose-wash px-3 py-2 text-xs text-rose">
          {error}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <Switch
          on={entry.allowWritesOutsideHome}
          onChange={(next) => void setVaultWritesOutsideHome(entry.name, next)}
          label="Allow writes outside the home folder"
        />
        <span className="text-xs text-ink-mid">Allow writes outside the home folder</span>
      </div>
      <p className="mt-1 text-sm text-ink-faint">The agent may append to and edit notes anywhere in this vault. New notes still go in the home folder.</p>
    </Panel>
  );
}
