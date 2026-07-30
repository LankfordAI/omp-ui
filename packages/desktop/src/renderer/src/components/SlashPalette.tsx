import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";
import { cn } from "../lib/cn";
import { fuzzyBest, highlightRuns } from "../lib/fuzzy";
import type { SlashCommandInfo } from "../lib/rpc-types";
import { Chip, Label, type Tone } from "./ui";

/**
 * Inline command palette above the composer. omp exposes 49 commands with
 * descriptions, argument hints and subcommand trees; a bare text field
 * discovers none of them.
 *
 * The palette owns filtering *and* the selection cursor, and the composer's
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

/** Structured cursor: which command, and which of its subcommands (if any). */
interface Cursor {
  cmd: number;
  sub: number | null;
}

export function SlashPalette({
  commands,
  query,
  onPick,
  onClose,
  ref,
}: {
  commands: SlashCommandInfo[];
  /** Text after the leading `/`, args included — only the first word filters. */
  query: string;
  onPick(command: SlashCommandInfo, subcommand?: { name: string; usage?: string }): void;
  onClose(): void;
  ref?: Ref<SlashPaletteHandle>;
}) {
  const [cursor, setCursor] = useState<Cursor>({ cmd: 0, sub: null });
  const activeRow = useRef<HTMLButtonElement | null>(null);

  // Only the command word filters: once the user starts typing an argument the
  // list should hold still rather than empty out.
  const needle = query.split(/\s/, 1)[0];

  const groups = useMemo(() => {
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
  }, [commands, needle]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // A changed query invalidates the cursor rather than shifting it.
  useEffect(() => {
    setCursor({ cmd: 0, sub: null });
  }, [needle]);

  const active: Cursor = {
    cmd: flat.length === 0 ? 0 : Math.min(cursor.cmd, flat.length - 1),
    sub: cursor.sub,
  };
  const activeSubs = flat[active.cmd]?.command.subcommands ?? [];

  useImperativeHandle(
    ref,
    () => ({
      handleKey(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
          return true;
        }
        const picked = flat[active.cmd];
        if (picked === undefined) return false;
        const subs = picked.command.subcommands ?? [];

        if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
          e.preventDefault();
          // Descend into the expanded subcommands before moving on.
          setCursor(
            active.sub === null
              ? subs.length > 0
                ? { cmd: active.cmd, sub: 0 }
                : { cmd: (active.cmd + 1) % flat.length, sub: null }
              : active.sub + 1 < subs.length
                ? { cmd: active.cmd, sub: active.sub + 1 }
                : { cmd: (active.cmd + 1) % flat.length, sub: null },
          );
          return true;
        }
        if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
          e.preventDefault();
          setCursor(
            active.sub === null
              ? { cmd: (active.cmd - 1 + flat.length) % flat.length, sub: null }
              : active.sub === 0
                ? { cmd: active.cmd, sub: null }
                : { cmd: active.cmd, sub: active.sub - 1 },
          );
          return true;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          onPick(picked.command, active.sub === null ? undefined : subs[active.sub]);
          return true;
        }
        return false;
      },
    }),
    [flat, active.cmd, active.sub, onPick, onClose],
  );

  useEffect(() => {
    activeRow.current?.scrollIntoView({ block: "nearest" });
  }, [active.cmd, active.sub]);

  const shell =
    "animate-rise edge-lit absolute inset-x-0 bottom-full z-20 mb-2 rounded-lg border border-line-strong bg-overlay";

  if (flat.length === 0) {
    return (
      <div className={cn(shell, "px-3 py-2.5")}>
        <p className="text-xs text-ink-dim">
          no command matches <span className="font-mono text-ink-mid">/{needle}</span>
        </p>
      </div>
    );
  }

  let row = -1;
  return (
    <div className={cn(shell, "max-h-72 overflow-y-auto py-1")}>
      {groups.map((group) => (
        <div key={group.label}>
          <div className="px-3 pb-1 pt-1.5">
            <Label>{group.label}</Label>
          </div>
          {group.items.map((item) => {
            row += 1;
            const self = row;
            const onSelf = self === active.cmd;
            const parentActive = onSelf && active.sub === null;
            const source = item.command.source;
            return (
              <div key={item.command.name}>
                <button
                  type="button"
                  ref={parentActive ? activeRow : null}
                  // Keep the caret in the textarea: a blur would tear the palette down.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setCursor({ cmd: self, sub: null })}
                  onClick={() => onPick(item.command)}
                  className={cn(
                    "flex w-full items-baseline gap-2 px-3 py-1 text-left",
                    parentActive ? "bg-hover" : "hover:bg-raised",
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
                {onSelf &&
                  activeSubs.map((sub, i) => {
                    const subActive = active.sub === i;
                    return (
                      <button
                        key={sub.name}
                        type="button"
                        ref={subActive ? activeRow : null}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setCursor({ cmd: self, sub: i })}
                        onClick={() => onPick(item.command, sub)}
                        className={cn(
                          "flex w-full items-baseline gap-2 py-0.5 pl-8 pr-3 text-left",
                          subActive ? "bg-hover" : "hover:bg-raised",
                        )}
                      >
                        <span className="shrink-0 font-mono text-[11px] text-ink-mid">
                          /{item.command.name} {sub.name}
                        </span>
                        {/* `usage` is the subcommand's own argument hint, e.g. "<name>". */}
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
                  })}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
