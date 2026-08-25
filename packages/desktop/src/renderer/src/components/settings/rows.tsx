import { useState, type ReactNode } from "react";
import type {
  OmpSettingEntry,
  OmpSettingLayer,
  OmpSettingValue,
} from "@omp-ui/core/types";
import { cn } from "../../lib/cn";
import { Chip, Switch } from "../ui";

export const FIELD =
  "h-7 min-w-0 rounded-md border border-line bg-raised px-2 text-xs text-ink " +
  "transition-colors duration-150 focus:border-line-strong focus:outline-none " +
  "disabled:pointer-events-none disabled:opacity-35";

export function Row({
  title,
  hint,
  badge,
  children,
  stacked,
}: {
  title: string;
  hint?: string;
  badge?: ReactNode;
  children: ReactNode;
  /** Full-width children below the title block, for controls too wide for the right column. */
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <div className="py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-ink">{title}</span>
          {badge}
        </div>
        {hint !== undefined && hint !== "" && (
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{hint}</p>
        )}
        <div className="mt-1.5">{children}</div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-ink">{title}</span>
          {badge}
        </div>
        {hint !== undefined && hint !== "" && (
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
            {hint}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

/** `default` stays unbadged — it is the quiet common case. */
export function layerBadge(layer: OmpSettingLayer): ReactNode {
  if (layer === "project") return <Chip tone="copper">project</Chip>;
  if (layer === "global") return <Chip>global</Chip>;
  return null;
}

/**
 * A text/number field committing on Enter or blur; Escape reverts to the
 * snapshot value. An unchanged draft commits nothing. Escape with no edit is
 * left to bubble so it still closes the modal; with one it reverts and stops.
 */
export function CommitField({
  current,
  kind,
  label,
  placeholder,
  disabled,
  className,
  onCommit,
}: {
  current: string;
  kind: "text" | "number";
  label: string;
  placeholder?: string;
  disabled: boolean;
  className?: string;
  onCommit: (raw: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (): void => {
    if (draft === null) return;
    setDraft(null);
    if (draft !== current) onCommit(draft);
  };

  return (
    <input
      type={kind}
      value={draft ?? current}
      aria-label={label}
      placeholder={placeholder}
      spellCheck={false}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape" && draft !== null) {
          e.preventDefault();
          e.stopPropagation();
          setDraft(null);
        }
      }}
      className={cn(FIELD, className)}
    />
  );
}

export function SettingControl({
  entry,
  pendingKey,
  commit,
}: {
  entry: OmpSettingEntry;
  pendingKey: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
}) {
  const pending = pendingKey === entry.key;

  const commitScalar = (raw: string): void => {
    if (entry.type === "number") {
      const value = Number(raw);
      // Empty or non-finite reverts: this surface does not expose config reset.
      if (raw.trim() === "" || !Number.isFinite(value)) return;
      commit(entry.key, value);
    } else {
      if (raw === "") return;
      commit(entry.key, raw);
    }
  };

  if (entry.type === "boolean") {
    return (
      <Switch
        on={entry.value === true}
        onChange={(next) => commit(entry.key, next)}
        label={entry.key}
        disabled={pending}
      />
    );
  }
  // A failed enum-member read (options null) is non-fatal upstream; the value
  // remains editable as free text for omp to validate on write.
  if (entry.type === "enum" && entry.options !== null) {
    const value = typeof entry.value === "string" ? entry.value : "";
    return (
      <select
        aria-label={entry.key}
        value={value}
        disabled={pending}
        onChange={(event) => commit(entry.key, event.target.value)}
        className={FIELD}
      >
        {value === "" && (
          <option value="" disabled>
            unset
          </option>
        )}
        {entry.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (
    entry.type === "number" ||
    entry.type === "string" ||
    entry.type === "enum"
  ) {
    return (
      <CommitField
        current={entry.value === undefined ? "" : String(entry.value)}
        kind={entry.type === "number" ? "number" : "text"}
        label={entry.key}
        disabled={pending}
        className={entry.type === "number" ? "w-24" : "w-44"}
        onCommit={commitScalar}
      />
    );
  }
  // Future array/record entries stay visible without guessing an editor.
  return (
    <span
      className="max-w-56 truncate font-mono text-[11px] text-ink-mid"
      title={entry.key}
    >
      {entry.value === undefined ? "—" : JSON.stringify(entry.value)}
    </span>
  );
}
