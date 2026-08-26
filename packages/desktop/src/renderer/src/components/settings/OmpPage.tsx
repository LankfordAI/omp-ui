import type { OmpSettingEntry, OmpSettingValue } from "@omp-ui/core/types";
import {
  OMP_MODEL_ROLE_IDS,
  OMP_MODEL_ROLES_KEY,
  OMP_SETTING_GROUPS,
} from "@omp-ui/core/omp-settings-keys";
import { useStore } from "../../store";
import { Button, Empty, Label } from "../ui";
import { CommitField, Row, SettingControl, layerBadge } from "./rows";
import { OMP_MISSING, type FooterContext, type Load } from "./types";

export function OmpPage({
  load,
  projectCwd,
  pendingKey,
  writeError,
  commit,
  retry,
}: {
  load: Load;
  projectCwd: string | null;
  pendingKey: string | null;
  writeError: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
  retry: () => void;
}) {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const openMcpManager = useStore((s) => s.openMcpManager);
  const openSettings = useStore((s) => s.openSettings);
  const closeSettings = useStore((s) => s.closeSettings);

  if (load.status === "loading") {
    return (
      <Empty
        title="Reading omp configuration…"
        hint="Values, layers, and enum members come from omp's own config CLI."
      />
    );
  }

  // readOmpSettings itself never rejects — snapshot.error carries omp's own
  // failure — but the IPC hop still can, so both land in the same treatment.
  const failure =
    load.status === "error"
      ? load.message
      : load.snapshot.error !== null
        ? load.snapshot.error
        : null;
  // The `status` check rides along so the destructure below narrows: an error
  // load carries no snapshot, and a loaded one can still report `error`.
  if (failure !== null || load.status !== "loaded") {
    const missing = failure === OMP_MISSING;
    return (
      <Empty
        title="Could not read omp's configuration"
        hint={
          missing
            ? "omp is not installed, so there is nothing to configure yet."
            : (failure ?? undefined)
        }
        action={
          <div className="flex items-center gap-2">
            <Button size="xs" onClick={retry}>
              retry
            </Button>
            {missing && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => openSettings("updates")}
              >
                install omp from the Updates page
              </Button>
            )}
          </div>
        }
      />
    );
  }

  const { snapshot } = load;
  const byKey = new Map<string, OmpSettingEntry>(
    snapshot.entries.map((e) => [e.key, e]),
  );
  const rolesEntry = byKey.get(OMP_MODEL_ROLES_KEY);
  const rolesRecord: Record<string, unknown> =
    rolesEntry !== undefined &&
    typeof rolesEntry.value === "object" &&
    rolesEntry.value !== null &&
    !Array.isArray(rolesEntry.value)
      ? rolesEntry.value
      : {};

  const commitRole = (role: string, raw: string): void => {
    const next = raw.trim();
    // `omp config set modelRoles` is REPLACE-not-merge: a partial post would
    // delete every sibling role, so the WHOLE merged record goes out, with the
    // role's key omitted when cleared (blank = unset).
    const merged: Record<string, unknown> = { ...rolesRecord };
    if (next === "") delete merged[role];
    else merged[role] = next;
    commit(OMP_MODEL_ROLES_KEY, merged);
  };


  const tab =
    activeTabId === null
      ? undefined
      : tabs.find((t) => t.tabId === activeTabId);
  const mcpReady = tab !== undefined && tab.projectCwd !== "";

  return (
    <div className="pb-1.5">
      {projectCwd === null && (
        <p className="px-4 pt-3 text-[11px] text-ink-faint">
          No session focused — showing omp&apos;s global configuration.
        </p>
      )}
      {writeError !== null && (
        <p className="mx-4 mt-3 rounded-md border border-rose-dim/50 bg-rose-wash px-3 py-2 text-xs text-rose">
          {writeError}
        </p>
      )}

      {rolesEntry !== undefined && (
        <section className="px-4 pt-3">
          <div className="flex items-center gap-2">
            <Label>Model roles</Label>
            {layerBadge(rolesEntry.layer)}
          </div>
          {rolesEntry.description !== "" && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
              {rolesEntry.description}
            </p>
          )}
          <div className="mt-1.5 divide-y divide-line-soft">
            {OMP_MODEL_ROLE_IDS.map((role) => (
              <div key={role} className="flex items-center gap-3 py-1.5">
                <span className="w-20 shrink-0 font-mono text-[11px] text-ink-mid">
                  {role}
                </span>
                <CommitField
                  current={
                    typeof rolesRecord[role] === "string"
                      ? (rolesRecord[role] as string)
                      : ""
                  }
                  kind="text"
                  label={`model role ${role}`}
                  placeholder="model[:level] — blank = unset"
                  disabled={pendingKey === OMP_MODEL_ROLES_KEY}
                  className="flex-1"
                  onCommit={(raw) => commitRole(role, raw)}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {OMP_SETTING_GROUPS.map((group) => {
        const entries = group.keys
          .map((key) => byKey.get(key))
          .filter((e): e is OmpSettingEntry => e !== undefined);
        // A future omp may drop a whole group; an empty section is noise.
        if (entries.length === 0) return null;
        return (
          <section key={group.title} className="px-4 pt-3">
            <Label>{group.title}</Label>
            {group.description !== undefined && (
              <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
                {group.description}
              </p>
            )}
            <div className="mt-1 divide-y divide-line-soft">
              {entries.map((entry) => (
                <Row
                  key={entry.key}
                  title={entry.key}
                  hint={entry.description}
                  badge={layerBadge(entry.layer)}
                >
                  <SettingControl
                    entry={entry}
                    pendingKey={pendingKey}
                    commit={commit}
                  />
                </Row>
              ))}
            </div>
          </section>
        );
      })}

      <div className="mt-1 flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <p className="text-[11px] text-ink-faint">
          MCP servers resolve per project from native and translated tool configs (issue #36);
          the global list applies to every project.
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            disabled={!mcpReady}
            title={mcpReady ? undefined : "focus a session tab first — the manager pins to it"}
            onClick={() => {
              if (tab === undefined) return;
              // One modal at a time: stacked Escape listeners would close both.
              closeSettings();
              openMcpManager(tab.projectCwd, tab.tabId);
            }}
          >
            MCP servers…
          </Button>
          <Button size="xs" onClick={() => { closeSettings(); openMcpManager(null); }}>
            Global MCP servers…
          </Button>
        </div>
      </div>
    </div>
  );
}

export function OmpFooter({ agentDir, anyLive }: FooterContext) {
  // Load-bearing per ADR-0005: where writes land, which layer wins, and when
  // they take effect. omp regenerates its YAML on write, so hand-written
  // comments in config.yml do not survive an edit from here.
  return (
    <p>
      Writes go to omp&apos;s global config (
      <span className="font-mono">{agentDir ?? "…"}/config.yml</span>); a
      project&apos;s <span className="font-mono">.omp/config.yml</span> still
      wins and is shown as <span className="font-mono">project</span>. omp
      binds model roles and the advisor at process start — changes take effect
      on the next session spawn.
      {anyLive && " Restart a session from its MCP panel to apply now."} omp
      regenerates its YAML on write, so comments in config.yml are dropped.
    </p>
  );
}
