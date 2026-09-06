import { useImperativeHandle, useMemo, type KeyboardEvent, type Ref } from "react";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";
import { fuzzyBest, highlightRuns } from "../lib/fuzzy";
import type { SlashCommandInfo } from "../lib/rpc-types";
import type { SlashCompletion, Subcommand } from "../lib/slash-completion";
import { Chip, Label, type Tone } from "./ui";
import { PaletteList, usePaletteNav } from "./palette";

/**
 * Inline command palette above the composer. omp exposes 49 commands with
 * descriptions, argument hints and subcommand trees; a bare text field
 * discovers none of them.
 *
 * Two stages, decided upstream by lib/slash-completion.ts: while the command
 * word is being typed the palette fuzzy-searches the roster, grouped by
 * source with each command's subcommands nested under it; once whitespace
 * follows the word, only that one command's subcommands are listed, filtered
 * by everything typed after the word. The composer mounts no palette at all
 * when there is nothing to offer, so Enter and Escape fall through to it.
 *
 * The palette owns stage-one filtering *and* the selection cursor, and the composer's
 * textarea forwards its keydown through `handleKey`, so focus never leaves the
 * input. That is the only coherent split: a palette that took focus would
 * break mid-word filtering, and a cursor owned upstream would have to
 * re-derive this component's grouping and subcommand expansion.
 */

export interface SlashPaletteHandle {
  /** Consumes navigation keys. Returns true when the palette handled the key. */
  handleKey(e: KeyboardEvent): boolean;
}

/** Non-builtin commands are chipped so their provenance is legible. */
const SOURCE_TONE: Record<string, Tone> = {
  skill: "iris",
  extension: "copper",
  custom: "neutral",
  file: "neutral",
};

interface Scored {
  command: SlashCommandInfo;
  score: number;
  /** Indices of `command.name` the query consumed, for emphasis. */
  hits: number[];
}

interface Navigable {
  command: SlashCommandInfo;
  subcommand?: Subcommand;
  /** Stage one: indices of `command.name` the needle consumed; stage two: of `subcommand.name`. */
  hits: number[];
}

export function SlashPalette({
  commands,
  completion,
  onPick,
  onClose,
  ref,
}: {
  commands: SlashCommandInfo[];
  /** What to list. Never null: the composer mounts no palette when there is nothing to offer. */
  completion: SlashCompletion;
  onPick(command: SlashCommandInfo, subcommand?: Subcommand): void;
  onClose(): void;
  ref?: Ref<SlashPaletteHandle>;
}) {
  const t = useT();
  const needle = completion.needle;
  const searching = completion.stage === "command";

  const groups = useMemo((): { label: string; items: Scored[] }[] => {
    if (!searching) return [];
    const builtin: Scored[] = [];
    const other: Scored[] = [];
    for (const command of commands) {
      const best = fuzzyBest(needle, [
        { text: command.name, weight: 1 },
        ...(command.aliases ?? []).map((a) => ({ text: a, weight: 0.9, report: false })),
        { text: command.description, weight: 0.3, report: false },
      ]);
      if (best === null) continue;
      const hit = { command, score: best.score, hits: best.hits };
      (command.source === undefined || command.source === "builtin" ? builtin : other).push(hit);
    }
    for (const list of [builtin, other]) {
      list.sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name));
    }
    // With 33 builtins, a better-matching skill command must not be buried
    // below them — whichever group holds the single best hit leads.
    const topBuiltin = builtin.length > 0 ? builtin[0].score : -Infinity;
    const topOther = other.length > 0 ? other[0].score : -Infinity;
    const ordered =
      topOther > topBuiltin
        ? [
            { label: "extensions", items: other },
            { label: "builtin", items: builtin },
          ]
        : [
            { label: "builtin", items: builtin },
            { label: "extensions", items: other },
          ];
    return ordered.filter((g) => g.items.length > 0);
  }, [commands, needle, searching]);

  const groupedRows = useMemo(
    () => groups.map((group) => ({
      ...group,
      items: group.items.flatMap<Navigable>((item) => [
        { command: item.command, hits: item.hits },
        ...(item.command.subcommands ?? []).map((subcommand) => ({
          command: item.command,
          subcommand,
          hits: item.hits,
        })),
      ]),
    })),
    [groups],
  );
  const rows = useMemo<Navigable[]>(
    () =>
      completion.stage === "subcommand"
        ? completion.matches.map((match) => ({
            command: completion.command,
            subcommand: match.subcommand,
            hits: match.hits,
          }))
        : groupedRows.flatMap((group) => group.items),
    [completion, groupedRows],
  );
  const { active, setActive, activeRef, handleKey } = usePaletteNav({
    items: rows,
    resetKey: needle,
    acceptTab: true,
    onPick: (item) => onPick(item.command, item.subcommand),
    onClose,
  });

  useImperativeHandle(ref, () => ({ handleKey }), [handleKey]);

  const shell =
    "animate-rise edge-lit absolute inset-x-0 bottom-full z-20 mb-2 rounded-lg border border-line-strong bg-overlay";

  const list = cn(shell, "max-h-[min(18rem,calc(var(--app-viewport-height,100dvh)*0.45))] py-1");

  if (completion.stage === "subcommand") {
    const { command, matches } = completion;
    const hint = command.input?.hint;
    return (
      <PaletteList className={list}>
        {/* The stage header names what is being completed; the parent's own hint
            says a free-form argument is welcome too (`/goal [objective]`). */}
        <div className="flex items-baseline gap-2 px-3 pb-1 pt-1.5">
          <Label>{`/${command.name}`}</Label>
          {hint !== undefined && hint !== "" && (
            <span className="font-mono text-[10px] text-ink-faint">{hint}</span>
          )}
        </div>
        {matches.map(({ subcommand: sub, hits }, self) => {
          const isActive = self === active;
          return (
            <button
              key={sub.name}
              type="button"
              aria-label={`/${command.name} ${sub.name}: ${sub.description}`}
              ref={isActive ? activeRef : null}
              // Keep the caret in the textarea: a blur would tear the palette down.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(self)}
              onClick={() => onPick(command, sub)}
              className={cn(
                "flex w-full items-baseline gap-2 px-3 py-1 text-left",
                isActive ? "bg-hover" : "hover:bg-raised",
              )}
            >
              <span className="shrink-0 font-mono text-xs text-ink">
                <span className="text-ink-dim">{`/${command.name} `}</span>
                {highlightRuns(sub.name, hits).map((part, i) => (
                  <span key={i} className={part.hit ? "text-signal" : undefined}>
                    {part.text}
                  </span>
                ))}
              </span>
              {sub.usage !== undefined && sub.usage !== "" && (
                <span className="shrink-0 font-mono text-[10px] text-ink-faint">{sub.usage}</span>
              )}
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink-dim">{sub.description}</span>
            </button>
          );
        })}
      </PaletteList>
    );
  }

  if (rows.length === 0) {
    return (
      <div className={cn(shell, "px-3 py-2.5")}>
        <p className="text-xs text-ink-dim">
          {t("composer.slash.noMatch")} <span className="font-mono text-ink-mid">/{needle}</span>
        </p>
      </div>
    );
  }

  let row = -1;
  return (
    <PaletteList className={list}>
      {groupedRows.map((group) => (
        <div key={group.label}>
          <div className="px-3 pb-1 pt-1.5">
            <Label>{group.label === "extensions" ? t("composer.slash.extensions") : t("composer.slash.builtin")}</Label>
          </div>
          {group.items.map((item) => {
            row += 1;
            const self = row;
            const isActive = self === active;
            const sub = item.subcommand;
            if (sub !== undefined) {
              return (
                <button
                  key={`${item.command.name}:${sub.name}`}
                  type="button"
                  aria-label={`/${item.command.name} ${sub.name}: ${sub.description}`}
                  ref={isActive ? activeRef : null}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(self)}
                  onClick={() => onPick(item.command, sub)}
                  className={cn(
                    "flex w-full items-baseline gap-2 py-0.5 pl-8 pr-3 text-left",
                    isActive ? "bg-hover" : "hover:bg-raised",
                  )}
                >
                  <span className="shrink-0 font-mono text-[11px] text-ink-mid">
                    /{item.command.name} {sub.name}
                  </span>
                  {sub.usage !== undefined && sub.usage !== "" && (
                    <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                      {sub.usage}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
                    {sub.description}
                  </span>
                </button>
              );
            }

            const source = item.command.source;
            return (
              <button
                key={item.command.name}
                type="button"
                aria-label={`/${item.command.name}: ${item.command.description}`}
                ref={isActive ? activeRef : null}
                // Keep the caret in the textarea: a blur would tear the palette down.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(self)}
                onClick={() => onPick(item.command)}
                className={cn(
                  "flex w-full items-baseline gap-2 px-3 py-1 text-left",
                  isActive ? "bg-hover" : "hover:bg-raised",
                )}
              >
                <span className="shrink-0 font-mono text-xs text-ink">
                  /
                  {highlightRuns(item.command.name, item.hits).map((part, i) => (
                    <span key={i} className={part.hit ? "text-signal" : undefined}>
                      {part.text}
                    </span>
                  ))}
                </span>
                {item.command.input?.hint && (
                  <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                    {item.command.input.hint}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-[11px] text-ink-dim">
                  {item.command.description}
                </span>
                {source !== undefined && source !== "builtin" && (
                  <Chip tone={SOURCE_TONE[source] ?? "neutral"}>{source}</Chip>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </PaletteList>
  );
}
