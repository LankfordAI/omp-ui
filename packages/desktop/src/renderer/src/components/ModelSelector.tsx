import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { fuzzyBest } from "../lib/fuzzy";
import type { ModelInfo } from "../lib/rpc-types";
import { useStore } from "../store";
import { Button, Chevron, Chip, Dot, IconButton, Label, Modal } from "./ui";

/**
 * omp offers 414 models. A `<select>` cannot be navigated, so this is a
 * searchable palette: type to narrow, arrows to move, Enter to pick.
 */

/**
 * omp reports `cost` in USD per million tokens, so it is shown as-is. Two
 * significant figures is the most that ever distinguishes two models, and
 * trailing zeros just make the chip wider.
 */
function priceLabel(cost: ModelInfo["cost"]): string | null {
  const input = cost?.input;
  const output = cost?.output;
  if (typeof input !== "number" || typeof output !== "number") return null;
  if (input === 0 && output === 0) return "free";
  const money = (n: number) => `$${Number(n.toFixed(n < 1 ? 2 : n < 10 ? 1 : 0))}`;
  return `${money(input)}/${money(output)}`;
}

function windowLabel(window: number | undefined): string | null {
  if (typeof window !== "number" || window <= 0) return null;
  return window >= 1_000_000
    ? `${Math.round(window / 100_000) / 10}M`.replace(".0M", "M")
    : `${Math.round(window / 1000)}K`;
}

/** Stable empty array so the selector doesn't resubscribe on every store tick. */
const EMPTY: ModelInfo[] = [];

export function ModelSelector({ tabId, disabled }: { tabId: string; disabled?: boolean }) {
  const model = useStore((s) => s.rpc[tabId]?.model ?? null);
  const models = useStore((s) => s.rpc[tabId]?.availableModels ?? EMPTY);
  const setModel = useStore((s) => s.setModel);
  const cycleModel = useStore((s) => s.cycleModel);
  const [open, setOpen] = useState(false);

  // `get_available_models` can fail; the current model id is still worth showing.
  if (models.length === 0) {
    return (
      <Chip mono title={model?.id} tone="neutral">
        {model === null ? "no model" : model.id}
      </Chip>
    );
  }

  return (
    <>
      <div className="flex min-w-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="xs"
          disabled={disabled}
          title={model === null ? "pick a model" : `${model.provider}/${model.id}`}
          onClick={() => setOpen(true)}
          className="min-w-0 max-w-56"
        >
          <span className="truncate">{model === null ? "no model" : model.name || model.id}</span>
          <Chevron open={false} className="rotate-90 text-ink-faint" />
        </Button>
        <IconButton
          label="cycle model"
          onClick={() => {
            if (!disabled) void cycleModel(tabId);
          }}
          className={cn("size-5", disabled && "pointer-events-none opacity-35")}
        >
          <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.4} className="size-3.5">
            <path
              d="M2.5 6.5A5 5 0 0 1 12 5m1.5 4.5A5 5 0 0 1 4 11"
              stroke="currentColor"
              strokeLinecap="round"
            />
            <path
              d="M12 2.5V5H9.5M4 13.5V11h2.5"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </IconButton>
      </div>
      {open && (
        <ModelPalette
          models={models}
          current={model}
          onClose={() => setOpen(false)}
          onPick={(picked) => {
            setOpen(false);
            void setModel(tabId, picked);
          }}
        />
      )}
    </>
  );
}

/** Rendering 414 rows costs more than it informs; the palette pages by search. */
const VISIBLE_LIMIT = 120;

function ModelPalette({
  models,
  current,
  onPick,
  onClose,
}: {
  models: ModelInfo[];
  current: ModelInfo | null;
  onPick(model: ModelInfo): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const activeRow = useRef<HTMLButtonElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    search.current?.focus();
  }, []);

  const { shown, matched } = useMemo(() => {
    const scored: { model: ModelInfo; score: number }[] = [];
    for (const model of models) {
      const best = fuzzyBest(query, [
        { text: model.name, weight: 1 },
        { text: model.id, weight: 0.95 },
        { text: model.provider, weight: 0.6 },
      ]);
      if (best === null) continue;
      // With no query every score ties, so the model in use leads the list.
      const isCurrent =
        current !== null && model.id === current.id && model.provider === current.provider;
      scored.push({ model, score: best.score + (isCurrent ? 0.5 : 0) });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.model.provider.localeCompare(b.model.provider) ||
        a.model.name.localeCompare(b.model.name),
    );
    return { shown: scored.slice(0, VISIBLE_LIMIT).map((s) => s.model), matched: scored.length };
  }, [models, query, current]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    activeRow.current?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const active = shown.length === 0 ? 0 : Math.min(index, shown.length - 1);

  return (
    <Modal onClose={onClose} width="w-[34rem]">
      <div className="flex max-h-[70vh] flex-col">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.4} className="size-4 text-ink-faint">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeLinecap="round" />
          </svg>
          <input
            ref={search}
            value={query}
            placeholder={`search ${models.length} models…`}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
                e.preventDefault();
                if (shown.length > 0) setIndex((active + 1) % shown.length);
              } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
                e.preventDefault();
                if (shown.length > 0) setIndex((active - 1 + shown.length) % shown.length);
              } else if (e.key === "Enter") {
                e.preventDefault();
                const picked = shown[active];
                if (picked !== undefined) onPick(picked);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 flex-1 bg-transparent font-sans text-sm outline-none placeholder:text-ink-faint"
          />
          <Label>
            {matched === models.length ? models.length : `${matched}/${models.length}`}
            {shown.length < matched && ` · top ${shown.length}`}
          </Label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {shown.length === 0 && (
            <p className="px-3 py-3 text-xs text-ink-dim">nothing matches that search</p>
          )}
          {shown.map((model, i) => {
            const isCurrent = current !== null && model.id === current.id && model.provider === current.provider;
            const price = priceLabel(model.cost);
            const window = windowLabel(model.contextWindow);
            return (
              <button
                key={`${model.provider}/${model.id}`}
                type="button"
                ref={i === active ? activeRow : null}
                onMouseEnter={() => setIndex(i)}
                onClick={() => onPick(model)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left",
                  i === active ? "bg-hover" : isCurrent ? "bg-raised" : "hover:bg-raised",
                )}
              >
                <span className="grid w-2 shrink-0 place-items-center">
                  {isCurrent && <Dot tone="signal" title="current model" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-sm text-ink">{model.name}</span>
                  <span className="block truncate font-mono text-[10px] text-ink-faint">
                    {model.provider}/{model.id}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {model.reasoning === true && <Chip tone="iris">reasoning</Chip>}
                  {model.input?.includes("image") === true && <Chip tone="signal">vision</Chip>}
                  {window !== null && (
                    <Chip mono title={`${model.contextWindow} token context window`}>
                      {window}
                    </Chip>
                  )}
                  {price !== null && (
                    <Chip mono title="USD per million tokens (input/output)">
                      {price}
                    </Chip>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[10px] text-ink-faint">
          <span>↑↓ move</span>
          <span>enter pick</span>
          <span>esc close</span>
          <span className="flex-1" />
          <span>prices are USD per Mtok</span>
        </div>
      </div>
    </Modal>
  );
}
