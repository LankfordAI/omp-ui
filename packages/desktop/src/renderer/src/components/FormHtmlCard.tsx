import { useEffect, useMemo, useRef, useState } from "react";
import type { FormDialogField, FormDialogSelection } from "@omp-ui/core/form-dialog";
import { formDialogResponse } from "@omp-ui/core/form-dialog";
import { parseFormHtml } from "../lib/form-dialog-html";
import type { ParsedFormField } from "../lib/form-dialog-html";
import { cn } from "../lib/cn";
import { field } from "../lib/fields";
import { Button } from "./ui";

/**
 * The whole-HTML-form dialog (issue #1271): one card carrying the complete
 * `<form>` a `method: "form"` frame ships — omp 19.1's answer for the `ask`
 * tool and for extension `ui.formDialog` calls. Controls render as native
 * rows, opened at the model's own defaults (`checked`, `selected`, prefilled
 * text) exactly like a browser opening that markup; Submit answers `{ data }`
 * keyed by control name exactly as an HTML form submits (core's
 * {@link formDialogResponse} builds the wire shape), and every other path
 * out — Escape, Skip & send, cancel — answers `{cancelled}`, which omp
 * settles as a cancelled ask.
 */

/** A choice row counts as answered once a box is checked or Other has text. */
function isFilled(field: FormDialogField, selection: FormDialogSelection | undefined): boolean {
  if (selection === undefined) return false;
  if (field.kind === "text") return true;
  return (selection.values?.length ?? 0) > 0 || (selection.other?.trim() ?? "") !== "";
}

/** The form opened the way a browser opens it: every default answer in. */
function initialSelections(fields: readonly ParsedFormField[]): Record<string, FormDialogSelection> {
  const seeded: Record<string, FormDialogSelection> = {};
  for (const row of fields) {
    if (row.kind === "text") {
      seeded[row.field.name] = { text: row.value };
      continue;
    }
    const checked = row.options.filter(o => o.checked && !o.disabled).map(o => o.value);
    if (checked.length > 0) seeded[row.field.name] = { values: checked };
  }
  return seeded;
}

export function FormHtmlCard({
  frame,
  onAnswer,
}: {
  frame: unknown;
  /** Sends the wire response for this frame (data or cancelled). */
  onAnswer: (response: Record<string, unknown>) => void;
}) {
  const parsed = useMemo(() => parseFormHtml(field(frame, "html")), [frame]);
  const [selections, setSelections] = useState<Record<string, FormDialogSelection>>(() =>
    initialSelections(parsed.fields),
  );
  const body = useRef<HTMLDivElement | null>(null);

  // Focus lands on the form's first control when it opens; the card only
  // mounts with a form frame at the queue head, so mount IS the open.
  useEffect(() => {
    body.current?.querySelector<HTMLElement>("input:not([disabled]), textarea")?.focus({ preventScroll: true });
  }, []);

  const dismiss = (): void => {
    onAnswer({ cancelled: true });
  };

  function toggleChoice(fieldKey: string, multi: boolean, value: string): void {
    setSelections(prev => {
      const current = prev[fieldKey]?.values ?? [];
      const next = multi
        ? current.includes(value)
          ? current.filter(v => v !== value)
          : [...current, value]
        : [value];
      return { ...prev, [fieldKey]: { ...prev[fieldKey], values: next } };
    });
  }

  function setOther(fieldKey: string, text: string): void {
    setSelections(prev => ({ ...prev, [fieldKey]: { ...prev[fieldKey], other: text } }));
  }

  function setText(fieldKey: string, text: string): void {
    setSelections(prev => ({ ...prev, [fieldKey]: { text } }));
  }

  const anyAnswered = parsed.fields.some(f => isFilled(f.field, selections[f.field.name]));
  const submit = (): void => {
    onAnswer(formDialogResponse(parsed.fields.map(f => f.field), selections));
  };

  if (parsed.fields.length === 0) {
    // A form with no answerable control: still a blocking request omp waits
    // on, so it stays dismissible rather than disappearing.
    return (
      <div className="space-y-2">
        {parsed.intro !== "" && (
          <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-mid">{parsed.intro}</p>
        )}
        <p className="rounded-md border border-line p-3 text-xs text-ink-dim">This form carries no answerable controls.</p>
        <div className="flex justify-end">
          <Button onClick={dismiss}>cancel</Button>
        </div>
      </div>
    );
  }

  const rows = parsed.fields.map((row: ParsedFormField) => {
    if (row.kind === "choice") {
      const selection = selections[row.field.name];
      const checked = new Set(selection?.values ?? []);
      return (
        <fieldset key={`c:${row.field.name}:${row.field.optionValues.join("\u0000")}`} className="space-y-1">
          <legend className="mb-1 text-xs font-medium text-ink">{row.label}</legend>
          {row.options.map((option, index) => (
            <label
              key={`${option.value}:${index}`}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink",
                checked.has(option.value) ? "border border-line bg-void" : "border border-transparent hover:bg-void/60",
                option.disabled && "cursor-not-allowed opacity-50",
              )}
            >
              <input
                type={row.field.multi ? "checkbox" : "radio"}
                name={row.field.name}
                value={option.value}
                disabled={option.disabled}
                checked={checked.has(option.value)}
                onChange={() => toggleChoice(row.field.name, row.field.multi, option.value)}
              />
              <span className="min-w-0 break-words">{option.label}</span>
            </label>
          ))}
          {row.field.other && (
            <input
              type="text"
              className="w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-ink"
              placeholder="Other (type your own)"
              value={selection?.other ?? ""}
              onChange={e => setOther(row.field.name, e.target.value)}
            />
          )}
        </fieldset>
      );
    }
    const selection = selections[row.field.name];
    const textValue = selection?.text ?? row.value;
    const control = row.multiline ? (
      <textarea
        rows={row.rows}
        className="w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-ink"
        placeholder={row.placeholder}
        value={textValue}
        onChange={e => setText(row.field.name, e.target.value)}
      />
    ) : (
      <input
        type="text"
        className="w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-ink"
        placeholder={row.placeholder}
        value={textValue}
        onChange={e => setText(row.field.name, e.target.value)}
      />
    );
    return (
      <label key={`t:${row.field.name}`} className="block space-y-1">
        <span className="text-xs font-medium text-ink">{row.label}</span>
        {control}
      </label>
    );
  });

  return (
    <div className="space-y-3" ref={body}>
      {parsed.intro !== "" && (
        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-mid">{parsed.intro}</p>
      )}
      {rows}
      <div className="flex items-center justify-between pt-1">
        <span className="text-xs text-ink-faint">Esc cancels</span>
        <div className="flex gap-2">
          <Button onClick={dismiss}>cancel</Button>
          <Button variant="solid" tone="signal" disabled={!anyAnswered} onClick={submit}>
            submit
          </Button>
        </div>
      </div>
    </div>
  );
}

