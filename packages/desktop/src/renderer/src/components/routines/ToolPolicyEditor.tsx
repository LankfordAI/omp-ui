import { useEffect, useMemo, useState } from "react";
import {
  ROUTINE_CLI_BYPASS_TOOLS,
  compileRoutineToolPolicy,
  type RoutineCatalogSnapshot,
  type RoutineCatalogTool,
  type RoutineToolPolicy,
} from "@omp-ui/core/routine";
import { cn } from "../../lib/cn";
import { useT, type MessageKey } from "../../lib/i18n";
import { FIELD } from "../settings/rows";
import { Button, Chevron, Chip, Dot, IconSearch, Label } from "../ui";

interface ToolGroup {
  group: string;
  label: string;
  tools: RoutineCatalogTool[];
}

interface SourceSummary {
  group: string;
  label: string;
  allowCount: number;
  totalCount: number;
  stale: boolean;
}

/** Which rows the decision chips narrow the list to; "all" is unfiltered. */
type DecisionView = "all" | "allow" | "deny" | "ask";

const DECISION_VIEWS = ["all", "allow", "deny", "ask"] as const;

const DECISION_VIEW_LABEL: Record<DecisionView, MessageKey> = {
  all: "routines.policy.viewAll",
  allow: "routines.policy.viewAllowed",
  deny: "routines.policy.viewDenied",
  ask: "routines.policy.viewAsk",
};

/** MCP servers first (alphabetical), then the vault, then omp's built-ins, then missing. */
function groupRank(group: string): number {
  if (group.startsWith("mcp:")) return 0;
  if (group === "vault") return 1;
  if (group === "missing") return 3;
  return 2;
}

/**
 * The Tool policy allowlist (ADR-0100, issue #1278): a checked row runs
 * unattended, an unchecked row waits on an Approval card, and the per-row Deny
 * toggle removes the tool outright. Rows come from the live catalog of the
 * destination project; a policy key the catalog no longer lists keeps its row
 * with a "No longer present" chip so nothing is dropped silently. `reviewed` is
 * false for an unsaved routine: nothing can have been added after a review that
 * never happened.
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
  const [decisionView, setDecisionView] = useState<DecisionView>("all");
  const [selectedSource, setSelectedSource] = useState<string>("all");
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedDescs, setExpandedDescs] = useState<ReadonlySet<string>>(() => new Set());
  const [showYaml, setShowYaml] = useState(false);

  const allow = useMemo(() => new Set(policy.allow), [policy.allow]);
  const deny = useMemo(() => new Set(policy.deny), [policy.deny]);
  const reviewedSet = useMemo(() => new Set(policy.reviewedCatalog), [policy.reviewedCatalog]);
  const staleServers = useMemo(() => catalog?.staleServers ?? [], [catalog?.staleServers]);
  const compiled = useMemo(
    () => (catalog === null ? null : compileRoutineToolPolicy(policy, catalog)),
    [policy, catalog],
  );

  const allTools = useMemo<RoutineCatalogTool[]>(() => {
    const tools = [...(catalog?.tools ?? [])];
    const known = new Set(tools.map((tool) => tool.key));
    for (const key of [...policy.allow, ...policy.deny]) {
      if (known.has(key)) continue;
      known.add(key);
      tools.push({
        key,
        source: "builtin",
        group: "missing",
        groupLabel: t("routines.policy.missing"),
        description: "",
      });
    }
    return tools;
  }, [catalog, policy.allow, policy.deny, t]);

  const sources = useMemo<SourceSummary[]>(() => {
    const map = new Map<string, SourceSummary>();
    for (const tool of allTools) {
      const existing = map.get(tool.group);
      const isAllowed = allow.has(tool.key);
      if (existing === undefined) {
        map.set(tool.group, {
          group: tool.group,
          label: tool.groupLabel,
          allowCount: isAllowed ? 1 : 0,
          totalCount: 1,
          stale: tool.group.startsWith("mcp:") && staleServers.includes(tool.groupLabel),
        });
      } else {
        existing.totalCount += 1;
        if (isAllowed) existing.allowCount += 1;
      }
    }
    return [...map.values()].sort(
      (a, b) => groupRank(a.group) - groupRank(b.group) || a.label.localeCompare(b.label),
    );
  }, [allTools, allow, staleServers]);

  // Reset source selection if the selected group disappears (e.g. project switched).
  useEffect(() => {
    if (selectedSource !== "all" && !sources.some((s) => s.group === selectedSource)) {
      setSelectedSource("all");
    }
  }, [selectedSource, sources]);

  const groups = useMemo<ToolGroup[]>(() => {
    const q = filter.trim().toLowerCase();
    const map = new Map<string, ToolGroup>();
    for (const tool of allTools) {
      if (selectedSource !== "all" && tool.group !== selectedSource) continue;
      if (q !== "" && !tool.key.toLowerCase().includes(q) && !tool.groupLabel.toLowerCase().includes(q)) continue;
      if (decisionView !== "all") {
        const decision = allow.has(tool.key) ? "allow" : deny.has(tool.key) ? "deny" : "ask";
        if (decision !== decisionView) continue;
      }
      const entry = map.get(tool.group) ?? { group: tool.group, label: tool.groupLabel, tools: [] };
      entry.tools.push(tool);
      map.set(tool.group, entry);
    }
    return [...map.values()].sort(
      (a, b) => groupRank(a.group) - groupRank(b.group) || a.label.localeCompare(b.label),
    );
  }, [allTools, selectedSource, filter, decisionView, allow, deny]);

  // Chip counts stay global — they answer "what is actually decided" and must
  // not drift while a source, text, or decision filter narrows the visible rows.
  const counts = useMemo(() => {
    let allowed = 0;
    let denied = 0;
    for (const tool of allTools) {
      if (allow.has(tool.key)) allowed += 1;
      else if (deny.has(tool.key)) denied += 1;
    }
    return { all: allTools.length, allowed, denied, ask: allTools.length - allowed - denied };
  }, [allTools, allow, deny]);

  const setDecision = (key: string, decision: "allow" | "ask" | "deny"): void => {
    const nextAllow = policy.allow.filter((k) => k !== key);
    const nextDeny = policy.deny.filter((k) => k !== key);
    if (decision === "allow") nextAllow.push(key);
    if (decision === "deny") nextDeny.push(key);
    onChange({ ...policy, allow: nextAllow, deny: nextDeny });
  };

  const toggleGroup = (group: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const toggleDesc = (key: string): void => {
    setExpandedDescs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const cliBypass = policy.allow.some((key) => ROUTINE_CLI_BYPASS_TOOLS.has(key));

  const renderToolRow = (tool: RoutineCatalogTool) => {
    const allowed = allow.has(tool.key);
    const denied = deny.has(tool.key);
    const later = reviewed && tool.group !== "missing" && !reviewedSet.has(tool.key) && !allowed;
    const expanded = expandedDescs.has(tool.key);
    return (
      <li
        key={tool.key}
        data-tool-row={tool.key}
        className={cn(
          "relative flex items-start gap-2.5 py-2.5 pr-3 pl-3.5 text-xs transition-colors",
          later ? "bg-copper-wash/35" : "hover:bg-hover/35",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-0 left-0 w-[2.5px]",
            allowed ? "bg-signal" : denied ? "bg-rose" : "bg-transparent",
          )}
        />
        <input
          type="checkbox"
          checked={allowed}
          disabled={disabled}
          aria-label={tool.key}
          onChange={(e) => setDecision(tool.key, e.target.checked ? "allow" : "ask")}
          className="mt-0.5 shrink-0 cursor-pointer accent-[var(--color-signal)]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={disabled}
              onClick={() => setDecision(tool.key, allowed ? "ask" : "allow")}
              className="break-words text-left font-mono font-medium text-ink hover:underline"
            >
              {tool.key}
            </button>
            {later && <Chip tone="copper">{t("routines.policy.addedLater")}</Chip>}
            {tool.group === "missing" && <Chip tone="neutral">{t("routines.policy.missing")}</Chip>}
            {denied ? (
              <Chip tone="rose">{t("routines.policy.deny")}</Chip>
            ) : allowed ? null : (
              <span className="text-ink-faint">{t("routines.policy.ask")}</span>
            )}
          </div>
          {tool.description !== "" && (
            <button
              type="button"
              onClick={() => toggleDesc(tool.key)}
              className={cn(
                "mt-0.5 block max-w-full text-left text-ink-faint hover:text-ink-mid",
                !expanded && "line-clamp-2",
              )}
            >
              {tool.description}
            </button>
          )}
        </div>
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
  };

  return (
    <div
      data-tool-policy
      className="@container studio-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl"
    >
      <div className="flex min-h-0 flex-1 flex-col @[40rem]:flex-row">
        {/* Sources directory rail (vertical on >=40rem, horizontal pill strip below) */}
        <aside
          aria-label={t("routines.policy.sources")}
          className="flex shrink-0 flex-col border-b border-line-soft bg-sunken/45 @[40rem]:w-52 @[40rem]:border-r @[40rem]:border-b-0"
        >
          <div className="hidden items-center justify-between border-b border-line-soft px-3 py-2 @[40rem]:flex">
            <Label>{t("routines.policy.sources")}</Label>
            <span className="font-mono text-xs tabular-nums text-ink-faint">{sources.length}</span>
          </div>
          <div className="flex gap-1 overflow-x-auto p-2 @[40rem]:min-h-0 @[40rem]:flex-1 @[40rem]:flex-col @[40rem]:overflow-y-auto @[40rem]:overflow-x-hidden">
            <button
              type="button"
              data-tool-source="all"
              aria-pressed={selectedSource === "all"}
              onClick={() => setSelectedSource("all")}
              className={cn(
                "flex shrink-0 items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors",
                selectedSource === "all"
                  ? "border-line-strong bg-raised font-medium text-ink"
                  : "border-transparent text-ink-mid hover:bg-hover/60 hover:text-ink",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <Dot tone={counts.allowed > 0 ? "signal" : "neutral"} />
                <span className="truncate">{t("routines.policy.allSources")}</span>
              </span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                {counts.allowed}/{counts.all}
              </span>
            </button>
            {sources.map((src) => {
              const active = selectedSource === src.group;
              const tone = src.stale ? "copper" : src.allowCount > 0 ? "signal" : "neutral";
              return (
                <button
                  key={src.group}
                  type="button"
                  data-tool-source={src.group}
                  aria-pressed={active}
                  onClick={() => setSelectedSource(src.group)}
                  className={cn(
                    "flex shrink-0 items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors",
                    active
                      ? "border-line-strong bg-raised font-medium text-ink"
                      : "border-transparent text-ink-mid hover:bg-hover/60 hover:text-ink",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Dot tone={tone} />
                    <span className="truncate">{src.label}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                    {src.allowCount}/{src.totalCount}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Right pane: pinned toolbar + banners + scrollable tool rows */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="shrink-0 space-y-2 border-b border-line-soft bg-raised/45 px-3.5 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-44 flex-1">
                <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-faint" />
                <input
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t("routines.policy.filter")}
                  aria-label={t("routines.policy.filter")}
                  className={cn(FIELD, "w-full pl-8")}
                />
              </div>
              <Button size="xs" variant="ghost" disabled={compiled === null} onClick={() => setShowYaml((v) => !v)}>
                {showYaml ? t("routines.policy.hideYaml") : t("routines.policy.inspectYaml")}
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5" data-decision-filter>
                {DECISION_VIEWS.map((view) => (
                  <Button
                    key={view}
                    size="xs"
                    selected={decisionView === view}
                    disabled={disabled}
                    onClick={() => setDecisionView(view)}
                  >
                    {t(DECISION_VIEW_LABEL[view])}
                    <span className="tabular-nums text-ink-faint">
                      {{ all: counts.all, allow: counts.allowed, deny: counts.denied, ask: counts.ask }[view]}
                    </span>
                  </Button>
                ))}
              </div>
              <p className="text-xs text-ink-faint">
                {t("routines.policy.summary", { allow: policy.allow.length, deny: policy.deny.length })}
              </p>
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3.5">
            {showYaml && compiled !== null && (
              <pre
                data-selectable
                data-overlay-yaml
                className="max-h-64 overflow-auto rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-xs leading-relaxed text-ink-mid"
              >
                {compiled.overlayYamlPreview}
              </pre>
            )}
            {cliBypass && (
              <p
                role="note"
                className="rounded-lg border border-copper-dim bg-copper-wash px-3 py-2 text-xs leading-relaxed text-copper"
              >
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

            {selectedSource === "all" ? (
              groups.map(({ group, label, tools }) => {
                const collapsed = collapsedGroups.has(group);
                const allowedInGroup = tools.filter((tool) => allow.has(tool.key)).length;
                return (
                  <section key={group} className="overflow-hidden rounded-lg border border-line-soft bg-raised/45">
                    <button
                      type="button"
                      aria-expanded={!collapsed}
                      onClick={() => toggleGroup(group)}
                      className="flex w-full flex-wrap items-center gap-2 border-b border-line-soft bg-raised/65 px-3 py-2 text-left transition-colors hover:bg-hover/45"
                    >
                      <Chevron open={!collapsed} className="text-ink-faint" />
                      <span className="min-w-0 truncate text-xs font-semibold text-ink">{label}</span>
                      <span className="font-mono text-xs tabular-nums text-ink-faint">
                        {allowedInGroup}/{tools.length}
                      </span>
                      {group.startsWith("mcp:") && staleServers.includes(label) && (
                        <Chip tone="copper">{t("routines.policy.stale")}</Chip>
                      )}
                    </button>
                    {!collapsed && <ul className="divide-y divide-line-soft">{tools.map(renderToolRow)}</ul>}
                  </section>
                );
              })
            ) : (
              groups.map(({ group, label, tools }) => (
                <section key={group} className="overflow-hidden rounded-lg border border-line-soft bg-raised/45">
                  <div className="flex flex-wrap items-center gap-2 border-b border-line-soft bg-raised/65 px-3 py-2">
                    <span className="min-w-0 truncate text-xs font-semibold text-ink">{label}</span>
                    <span className="font-mono text-xs tabular-nums text-ink-faint">
                      {tools.filter((tool) => allow.has(tool.key)).length}/{tools.length}
                    </span>
                    {group.startsWith("mcp:") && staleServers.includes(label) && (
                      <Chip tone="copper">{t("routines.policy.stale")}</Chip>
                    )}
                  </div>
                  <ul className="divide-y divide-line-soft">{tools.map(renderToolRow)}</ul>
                </section>
              ))
            )}

            {groups.length === 0 && catalog !== null && catalogError === null && (
              <p className="text-xs text-ink-faint" data-policy-empty>
                {t("routines.policy.noMatches")}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
