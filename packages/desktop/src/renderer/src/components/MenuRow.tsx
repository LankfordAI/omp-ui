import type { ReactNode } from "react";

/**
 * The composer's one menu-row convention (the `+` menu and the steer
 * split's routes, issue #939): a glyph column, a label, a right-aligned
 * hint. Disabled rows keep pointer events so their `title` explains why.
 */
export function MenuRow({
  glyph,
  label,
  hint,
  title,
  disabled,
  onClick,
}: {
  glyph?: ReactNode;
  label: string;
  hint?: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-2 rounded px-1.5 py-1 text-left text-[11px] text-ink-mid hover:bg-hover hover:text-ink disabled:text-ink-dim disabled:hover:bg-transparent"
    >
      {glyph !== undefined && <span className="grid w-3.5 shrink-0 place-items-center">{glyph}</span>}
      <span className="min-w-0 truncate">{label}</span>
      {hint !== undefined && <span className="ml-auto shrink-0 pl-2 font-mono text-[10px] text-ink-faint">{hint}</span>}
    </button>
  );
}
