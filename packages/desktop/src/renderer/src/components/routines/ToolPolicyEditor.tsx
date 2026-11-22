import { useMemo, useState } from "react";
import {
  ROUTINE_CLI_BYPASS_TOOLS,
  compileRoutineToolPolicy,
  type RoutineCatalogSnapshot,
  type RoutineCatalogTool,
  type RoutineToolPolicy,
} from "@omp-ui/core/routine";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import { FIELD } from "../settings/rows";
import { Button, Chip, Panel } from "../ui";

interface ToolGroup {
  group: string;
  label: string;
  tools: RoutineCatalogTool[];
}

/** MCP servers first (alphabetical), then the vault, then omp's built-ins (spec §11.1). */
function groupRank(group: string): number {
  if (group.startsWith("mcp:")) return 0;
  return group === "vault" ? 1 : 2;
}

/**
 * The Tool policy allowlist (ADR-0100, prototype #1249 variant A): a checked
 * row runs unattended, an unchecked row waits on an Approval card, and the
 * per-row Deny toggle removes the tool outright. Rows come from the live
 * catalog of the destination project; a policy key the catalog no longer
 * lists keeps its row with a "No longer present" chip so nothing is dropped
 * silently. `reviewed` is false for an unsaved routine: nothing can have been
 * added after a review that never happened.
 */
export function ToolPolicyEditor({
  policy,
  catalog,
  catalogError,
  reviewed,
  disabled,
  onChange,
}: {
  policy: RoutineToolPolicy;
  catalog: RoutineCatalogSnapshot | null;
  catalogError: string | null;
  reviewed: boolean;
  disabled: boolean;
  onChange: (next: RoutineToolPolicy) => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const [showYaml, setShowYaml] = useState(false);
  const allow = useMemo(() => new Set(policy.allow), [policy.allow]);
  const deny = useMemo(() => new Set(policy.deny), [policy.deny]);
  const reviewedSet = useMemo(() => new Set(policy.reviewedCatalog), [policy.reviewedCatalog]);
  const compiled = useMemo(
    () => (catalog === null ? null : compileRoutineToolPolicy(policy, catalog)),
    [policy, catalog],
  );

  const groups = useMemo<ToolGroup[]>(() => {
    const tools = [...(catalog?.tools ?? [])];
    const known = new Set(tools.map((tool) => tool.key));
    for (const key of [...policy.allow, ...policy.deny]) {
      if (known.has(key)) continue;
      known.add(key);
      tools.push({ key, source: "builtin", group: "missing", groupLabel: t("routines.policy.missing"), description: "" });
    }
    const q = filter.trim().toLowerCase();
    const map = new Map<string, ToolGroup>();
    for (const tool of tools) {
      if (q !== "" && !tool.key.toLowerCase().includes(q) && !tool.groupLabel.toLowerCase().includes(q)) continue;
      const entry = map.get(tool.group) ?? { group: tool.group, label: tool.groupLabel, tools: [] };
      entry.tools.push(tool);
      map.set(tool.group, entry);
    }
    return [...map.values()].sort(
      (a, b) => groupRank(a.group) - groupRank(b.group) || a.label.localeCompare(b.label),
    );
  }, [catalog, policy.allow, policy.deny, filter, t]);

  const setDecision = (key: string, decision: "allow" | "ask" | "deny"): void => {
    const nextAllow = policy.allow.filter((k) => k !== key);
    const nextDeny = policy.deny.filter((k) => k !== key);
    if (decision === "allow") nextAllow.push(key);
    if (decision === "deny") nextDeny.push(key);
    onChange({ ...policy, allow: nextAllow, deny: nextDeny });
  };

  const addedLater = (tool: RoutineCatalogTool): boolean =>
    reviewed && tool.group !== "missing" && !reviewedSet.has(tool.key) && !allow.has(tool.key);
  const cliBypass = policy.allow.some((key) => ROUTINE_CLI_BYPASS_TOOLS.has(key));
  const staleServers = catalog?.staleServers ?? [];

  return (
    <div className="space-y-2.5" data-tool-policy>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-raised px-3 py-2">
        <p className="min-w-0 text-xs text-ink-mid">
          {t("routines.policy.summary", { allow: policy.allow.length, deny: policy.deny.length })}
        </p>
        <Button size="xs" variant="ghost" disabled={compiled === null} onClick={() => setShowYaml((v) => !v)}>
          {showYaml ? t("routines.policy.hideYaml") : t("routines.policy.inspectYaml")}
        </Button>
      </div>
      {showYaml && compiled !== null && (
        <pre
          data-selectable
          data-overlay-yaml
          className="max-h-64 overflow-auto rounded-md border border-line bg-sunken px-3 py-2 font-mono text-xs leading-relaxed text-ink-mid"
        >
          {compiled.overlayYamlPreview}
        </pre>
      )}
      {cliBypass && (
        <p role="note" className="rounded-md border border-copper-dim bg-copper-wash px-3 py-2 text-xs leading-relaxed text-copper">
          {t("routines.policy.cliBypassWarning")}
        </p>
      )}
      {staleServers.length > 0 && (
        <p role="note" className="text-xs leading-relaxed text-copper">
          {t("routines.policy.staleCatalog")} <span className="font-mono">{staleServers.join(", ")}</span>
        </p>
      )}
      {(catalogError ?? catalog?.enumerationError ?? null) !== null && (
        <p role="alert" className="text-xs leading-relaxed text-rose">
          {catalogError ?? catalog?.enumerationError}
        </p>
      )}
      {catalog === null && catalogError === null && (
        <p className="text-xs text-ink-faint">{t("routines.policy.loading")}</p>
      )}
      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={t("routines.policy.filter")}
        aria-label={t("routines.policy.filter")}
        className={cn(FIELD, "w-full")}
      />
      {groups.map(({ group, label, tools }) => (
        <Panel key={group} className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3 py-1.5">
            <span className="min-w-0 truncate text-xs font-semibold text-ink">{label}</span>
            <span className="text-xs tabular-nums text-ink-faint">
              {tools.filter((tool) => allow.has(tool.key)).length}/{tools.length}
            </span>
            {group.startsWith("mcp:") && staleServers.includes(label) && <Chip tone="copper">{t("routines.policy.stale")}</Chip>}
          </div>
          <ul className="divide-y divide-line-soft">
            {tools.map((tool) => {
              const allowed = allow.has(tool.key);
              const denied = deny.has(tool.key);
              const later = addedLater(tool);
              return (
                <li
                  key={tool.key}
                  data-tool-row={tool.key}
                  className={cn("flex items-start gap-2.5 px-3 py-2 text-xs", later && "bg-copper-wash/40")}
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      checked={allowed}
                      disabled={disabled}
                      aria-label={tool.key}
                      onChange={(e) => setDecision(tool.key, e.target.checked ? "allow" : "ask")}
                      className="mt-0.5 accent-[var(--color-signal)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="break-all font-mono font-medium text-ink">{tool.key}</span>
                        {later && <Chip tone="copper">{t("routines.policy.addedLater")}</Chip>}
                        {tool.group === "missing" && <Chip tone="neutral">{t("routines.policy.missing")}</Chip>}
                        {denied ? (
                          <Chip tone="rose">{t("routines.policy.deny")}</Chip>
                        ) : allowed ? null : (
                          <span className="text-ink-faint">{t("routines.policy.ask")}</span>
                        )}
                      </span>
                      {tool.description !== "" && (
                        <span className="mt-0.5 line-clamp-2 block text-ink-faint">{tool.description}</span>
                      )}
                    </span>
                  </label>
                  <Button
                    size="xs"
                    tone="rose"
                    selected={denied}
                    disabled={disabled}
                    title={t("routines.policy.denyHint")}
                    onClick={() => setDecision(tool.key, denied ? "ask" : "deny")}
                  >
                    {t("routines.policy.deny")}
                  </Button>
                </li>
              );
            })}
          </ul>
        </Panel>
      ))}
    </div>
  );
}
