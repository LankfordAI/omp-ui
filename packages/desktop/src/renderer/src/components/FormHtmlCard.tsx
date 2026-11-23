import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormDialogSelection } from "@omp-ui/core/form-dialog";
import {
  formDialogResponse,
  formFieldKey,
  validateFormDialog,
} from "@omp-ui/core/form-dialog";
import {
  parseFormHtml,
  spansPlainText,
  type FormSpan,
  type ParsedFormBlock,
  type ParsedFormField,
  type ParsedFormSection,
} from "../lib/form-dialog-html";
import { cn } from "../lib/cn";
import { field } from "../lib/fields";
import { Button } from "./ui";

/**
 * The whole-HTML-form dialog (issue #1271): one card carrying the complete
 * `<form>` a `method: "form"` frame ships — omp 19.1's answer for the `ask`
 * tool and for extension `ui.formDialog` calls.
 *
 * All untrusted HTML is parsed inertly by {@link parseFormHtml} into safe
 * structured sections, context blocks, and native controls (never inserted as
 * raw HTML). Controls open at the model's defaults (`checked`, `selected`,
 * prefilled text), validate constraints before sending (omp rejects invalid
 * `data` without a retry round), and submit `{ data }` built by core's
 * {@link formDialogResponse}. Escape, Skip & send, and Cancel send
 * `{ cancelled: true }`.
 */

/** HTML `<input type>` values rendered natively; everything else falls back to `text`. */
const SUPPORTED_INPUT_TYPES: Record<string, true> = {
  text: true,
  number: true,
  range: true,
  email: true,
  url: true,
  date: true,
  time: true,
  "datetime-local": true,
  tel: true,
  search: true,
  password: true,
};

/** The form opened the way a browser opens it: every default answer in. */
function initialSelections(fields: readonly ParsedFormField[]): Record<string, FormDialogSelection> {
  const seeded: Record<string, FormDialogSelection> = {};
  for (const row of fields) {
    const key = formFieldKey(row.field);
    if (row.kind === "text") {
      seeded[key] = { text: row.value };
      continue;
    }
    const checked = row.options.filter(o => o.checked && !o.disabled).map(o => o.value);
    if (checked.length > 0) {
      seeded[key] = { values: row.field.multi ? checked : [checked[0]!] };
    }
  }
  return seeded;
}

function renderSpans(spans: readonly FormSpan[]): React.ReactNode {
  return spans.map((span, idx) => {
    const parts = span.text.split("\n");
    const content = parts.map((part, pIdx) => (
      <Fragment key={pIdx}>
        {pIdx > 0 && <br />}
        {part}
      </Fragment>
    ));
    if (span.style === "code") {
      return (
        <code key={idx} className="rounded bg-void px-1 py-px font-mono text-[0.9em] text-ink">
          {content}
        </code>
      );
    }
    if (span.style === "strong") {
      return (
        <strong key={idx} className="font-semibold text-ink">
          {content}
        </strong>
      );
    }
    if (span.style === "em") {
      return <em key={idx}>{content}</em>;
    }
    return <Fragment key={idx}>{content}</Fragment>;
  });
}

export function FormHtmlCard({
  frame,
  onAnswer,
}: {
  frame: unknown;
  /** Sends the wire response for this frame (data or cancelled). */
  onAnswer: (response: Record<string, unknown>) => void;
}) {
  const scopeId = useId();
  const parsed = useMemo(() => parseFormHtml(field(frame, "html")), [frame]);
  const [selections, setSelections] = useState<Record<string, FormDialogSelection>>(() =>
    initialSelections(parsed.fields),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const body = useRef<HTMLFormElement | null>(null);

  // Focus lands on the form's first control when it opens; the card only
  // mounts with a form frame at the queue head, so mount IS the open.
  useEffect(() => {
    body.current
      ?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled])")
      ?.focus({ preventScroll: true });
  }, []);

  const dismiss = (): void => {
    onAnswer({ cancelled: true });
  };

  function clearError(fieldKey: string): void {
    setErrors(prev => {
      if (!Object.prototype.hasOwnProperty.call(prev, fieldKey)) return prev;
      const next = { ...prev };
      delete next[fieldKey];
      return next;
    });
  }
  function toggleChoice(fieldKey: string, multi: boolean, value: string): void {
    clearError(fieldKey);
    setSelections(prev => {
      const current = prev[fieldKey]?.values ?? [];
      if (multi) {
        const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
        return { ...prev, [fieldKey]: { ...prev[fieldKey], values: next } };
      }
      // Single-select choice clears any typed "Other" so the picked option wins clearly.
      return { ...prev, [fieldKey]: { values: [value], other: "" } };
    });
  }

  function setOther(fieldKey: string, multi: boolean, text: string): void {
    clearError(fieldKey);
    setSelections(prev => ({
      ...prev,
      [fieldKey]: multi
        ? { ...prev[fieldKey], other: text }
        : {
            values: text.trim() !== "" ? [] : (prev[fieldKey]?.values ?? []),
            other: text,
          },
    }));
  }

  function setText(fieldKey: string, text: string): void {
    clearError(fieldKey);
    setSelections(prev => ({ ...prev, [fieldKey]: { text } }));
  }

  const submit = (): void => {
    const wireFields = parsed.fields.map(f => f.field);
    const found = validateFormDialog(wireFields, selections);
    const invalidKeys = Object.keys(found);
    if (invalidKeys.length > 0) {
      setErrors(found);
      const firstKey = invalidKeys[0]!;
      const container = Array.from(body.current?.querySelectorAll<HTMLElement>("[data-form-field]") ?? []).find(
        el => el.dataset.formField === firstKey,
      );
      container
        ?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled])")
        ?.focus({ preventScroll: true });
      return;
    }
    onAnswer(formDialogResponse(wireFields, selections));
  };
  function renderField(row: ParsedFormField, sectionTitle: string, hasPriorText: boolean): React.ReactNode {
    const key = formFieldKey(row.field);
    const error = errors[key];
    if (row.kind === "choice") {
      const selection = selections[key];
      const checked = new Set(selection?.values ?? []);
      if (row.field.select && !row.field.multi) {
        const currentValue = selection?.values?.[0] ?? "";
        return (
          <label key={key} data-form-field={key} className="block space-y-1">
            <span className="text-xs font-medium text-ink">
              {row.label}
              {row.field.required && <span className="ml-0.5 text-rose">*</span>}
            </span>
            <select
              value={currentValue}
              aria-invalid={error !== undefined || undefined}
              onChange={e => toggleChoice(key, false, e.target.value)}
              className={cn(
                "w-full rounded-md border bg-void px-2 py-1.5 text-sm text-ink outline-none focus:border-signal-dim",
                error !== undefined ? "border-rose" : "border-line",
              )}
            >
              {row.options.map((option, index) => (
                <option key={`${option.value}:${index}`} value={option.value} disabled={option.disabled}>
                  {option.label}
                </option>
              ))}
            </select>
            {error !== undefined && (
              <p role="alert" className="text-xs text-rose">
                {error}
              </p>
            )}
          </label>
        );
      }

      // Radio/checkbox groups inherit their question from the section legend or
      // preceding text block; fall back to a readable name only when neither exists.
      const fallbackLegend =
        row.label || (sectionTitle === "" && !hasPriorText ? row.field.name.replace(/[_-]+/g, " ").trim() : "");
      const radioGroupName = `${scopeId}:${key}`;
      return (
        <fieldset key={key} data-form-field={key} className="space-y-1">
          {fallbackLegend !== "" && (
            <legend className="mb-1 text-xs font-medium text-ink">
              {fallbackLegend}
              {row.field.required && <span className="ml-0.5 text-rose">*</span>}
            </legend>
          )}
          {row.options.map((option, index) => {
            const isChecked = !option.disabled && checked.has(option.value);
            return (
              <label
                key={`${option.value}:${index}`}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm text-ink",
                  isChecked ? "border-signal-dim bg-signal-wash" : "border-transparent hover:bg-hover",
                  option.disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <input
                  type={row.field.multi ? "checkbox" : "radio"}
                  name={row.field.multi ? undefined : radioGroupName}
                  value={option.value}
                  disabled={option.disabled}
                  checked={isChecked}
                  onChange={() => toggleChoice(key, row.field.multi, option.value)}
                />
                <span className="min-w-0 break-words">{option.label}</span>
              </label>
            );
          })}
          {row.field.other && (
            <input
              type="text"
              aria-label={`Other (${fallbackLegend || sectionTitle || row.field.name})`}
              aria-invalid={error !== undefined || undefined}
              className={cn(
                "mt-1 w-full rounded-md border bg-void px-2 py-1.5 text-sm text-ink outline-none focus:border-signal-dim",
                error !== undefined ? "border-rose" : "border-line",
              )}
              placeholder="Other (type your own)"
              value={selection?.other ?? ""}
              onChange={e => setOther(key, row.field.multi, e.target.value)}
            />
          )}
          {error !== undefined && (
            <p role="alert" className="text-xs text-rose">
              {error}
            </p>
          )}
        </fieldset>
      );
    }

    const selection = selections[key];
    const textValue = selection?.text ?? row.value;
    const rawType = row.field.type ?? "text";
    const inputType = SUPPORTED_INPUT_TYPES[rawType] === true ? rawType : "text";
    const control = row.multiline ? (
      <textarea
        rows={row.rows}
        aria-invalid={error !== undefined || undefined}
        className={cn(
          "w-full resize-y rounded-md border bg-void px-2 py-1.5 text-sm text-ink outline-none focus:border-signal-dim",
          error !== undefined ? "border-rose" : "border-line",
        )}
        placeholder={row.placeholder}
        value={textValue}
        onChange={e => setText(key, e.target.value)}
      />
    ) : (
      <div className={cn(inputType === "range" && "flex items-center gap-2")}>
        <input
          type={inputType}
          min={row.field.min}
          max={row.field.max}
          step={row.step}
          aria-invalid={error !== undefined || undefined}
          className={cn(
            inputType === "range"
              ? "flex-1 accent-signal"
              : "w-full rounded-md border bg-void px-2 py-1.5 text-sm text-ink outline-none focus:border-signal-dim",
            inputType !== "range" && (error !== undefined ? "border-rose" : "border-line"),
          )}
          placeholder={row.placeholder}
          value={textValue}
          onChange={e => setText(key, e.target.value)}
        />
        {inputType === "range" && (
          <span className="shrink-0 font-mono text-xs tabular-nums text-ink-mid">{textValue}</span>
        )}
      </div>
    );
    return (
      <label key={key} data-form-field={key} className="block space-y-1">
        <span className="text-xs font-medium text-ink">
          {row.label}
          {row.field.required && <span className="ml-0.5 text-rose">*</span>}
        </span>
        {control}
        {error !== undefined && (
          <p role="alert" className="text-xs text-rose">
            {error}
          </p>
        )}
      </label>
    );
  }

  function renderBlock(
    block: ParsedFormBlock,
    blockIndex: number,
    sectionTitle: string,
    hasPriorText: boolean,
  ): React.ReactNode {
    switch (block.kind) {
      case "text":
        return block.heading ? (
          <h3 key={blockIndex} className="text-xs font-semibold leading-snug text-ink">
            {renderSpans(block.spans)}
          </h3>
        ) : (
          <p key={blockIndex} className="whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-mid">
            {renderSpans(block.spans)}
          </p>
        );
      case "list": {
        const ListTag = block.ordered ? "ol" : "ul";
        return (
          <ListTag
            key={blockIndex}
            className={cn(
              "space-y-0.5 pl-4 text-xs leading-relaxed text-ink-mid",
              block.ordered ? "list-decimal" : "list-disc",
            )}
          >
            {block.items.map((item, idx) => (
              <li key={idx} className="break-words">
                {renderSpans(item)}
              </li>
            ))}
          </ListTag>
        );
      }
      case "pre":
        return (
          <pre
            key={blockIndex}
            className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-line bg-void px-2.5 py-2 font-mono text-xs text-ink"
          >
            {block.text}
          </pre>
        );
      case "table": {
        const headRows = block.rows.slice(0, block.headerRows);
        const bodyRows = block.rows.slice(block.headerRows);
        return (
          <div key={blockIndex} className="overflow-x-auto rounded-md border border-line">
            <table className="w-full border-collapse text-left text-xs">
              {headRows.length > 0 && (
                <thead className="bg-void text-ink">
                  {headRows.map((row, rIdx) => (
                    <tr key={rIdx} className="border-b border-line">
                      {row.map((cell, cIdx) => (
                        <th key={cIdx} className="px-2 py-1.5 font-medium">
                          {renderSpans(cell)}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
              )}
              {bodyRows.length > 0 && (
                <tbody className="divide-y divide-line text-ink-mid">
                  {bodyRows.map((row, rIdx) => (
                    <tr key={rIdx}>
                      {row.map((cell, cIdx) => (
                        <td key={cIdx} className="px-2 py-1.5">
                          {renderSpans(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </div>
        );
      }
      case "image":
        if (block.safeDataSrc !== null) {
          return (
            <img
              key={blockIndex}
              src={block.safeDataSrc}
              alt={block.alt}
              className="max-h-48 max-w-full rounded-md border border-line object-contain"
            />
          );
        }
        return block.alt !== "" ? (
          <p
            key={blockIndex}
            className="rounded-md border border-line bg-void px-2.5 py-1.5 text-xs text-ink-dim"
          >
            {`[Image: ${block.alt}]`}
          </p>
        ) : null;
      case "field":
        return renderField(block.field, sectionTitle, hasPriorText);
    }
  }

  function renderSection(section: ParsedFormSection, sectionIndex: number): React.ReactNode {
    const titleText = spansPlainText(section.title).trim();
    const blocks = section.blocks.map((block, bIdx) => {
      const prev = bIdx > 0 ? section.blocks[bIdx - 1] : undefined;
      const hasPriorText = prev?.kind === "text";
      return renderBlock(block, bIdx, titleText, hasPriorText);
    });
    if (section.fieldset) {
      return (
        <fieldset key={sectionIndex} className="space-y-2 rounded-lg border border-line px-2.5 py-2">
          {section.title.length > 0 && (
            <legend className="px-1 text-xs font-medium text-ink">{renderSpans(section.title)}</legend>
          )}
          {blocks}
        </fieldset>
      );
    }
    return (
      <div key={sectionIndex} className="space-y-2">
        {blocks}
      </div>
    );
  }

  if (parsed.fields.length === 0) {
    // A form with no answerable control: still a blocking request omp waits
    // on, so it stays dismissible rather than disappearing.
    return (
      <div
        className="space-y-2"
        onKeyDown={e => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            e.nativeEvent.stopPropagation();
            dismiss();
          }
        }}
      >
        {parsed.sections.map((section, idx) => renderSection(section, idx))}
        <p className="rounded-md border border-line p-3 text-xs text-ink-dim">
          This form carries no answerable controls.
        </p>
        <div className="flex justify-end">
          <Button onClick={dismiss}>cancel</Button>
        </div>
      </div>
    );
  }

  return (
    <form
      ref={body}
      noValidate
      className="space-y-3"
      onSubmit={e => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={e => {
        // ExtensionDialogHost's window listener ignores events originating inside
        // inputs/textareas so the composer keeps Escape; handle Escape here for
        // all controls inside the form card and stop native bubbling so the
        // window listener cannot double-cancel.
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          e.nativeEvent.stopPropagation();
          dismiss();
        }
      }}
    >
      {parsed.sections.map((section, idx) => renderSection(section, idx))}
      <div className="flex items-center justify-between pt-1">
        <span className="text-xs text-ink-faint">Esc cancels</span>
        <div className="flex gap-2">
          <Button variant="ghost" size="xs" onClick={dismiss}>
            cancel
          </Button>
          <Button type="submit" variant="solid" tone="signal" size="xs">
            submit
          </Button>
        </div>
      </div>
    </form>
  );
}
