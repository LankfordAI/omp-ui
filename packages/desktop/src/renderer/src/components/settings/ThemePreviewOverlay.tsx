import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ThemeGateFailure } from "@omp-ui/core/theme";
import { AndroidBackOwner } from "../../lib/android-back";
import { useT } from "../../lib/i18n";
import type { Theme } from "../../lib/themes";
import { Button, useOverlay } from "../ui";
import { GateFailureList } from "./ThemeEditor";
import { ThemeSpecimen } from "./ThemeSpecimen";

/**
 * The theme preview (CONTEXT.md): a full-screen mockup of the app painted in
 * one theme. It never calls setThemePreview, so the real app is never
 * repainted and the editor's single preview slot cannot leak. Mount it from
 * the ThemeWall root, never inside a card: React events bubble through
 * portals, and a card's main button would apply the theme.
 */
export function ThemePreviewOverlay({
  theme,
  title,
  chips,
  notes,
  failures,
  actions,
  onClose,
}: {
  theme: Theme;
  title: string;
  /** Scheme and kind chips, in the current theme's paint. */
  chips: ReactNode;
  notes: readonly string[];
  failures: readonly ThemeGateFailure[];
  /** Install / Update / Use buttons, built by ThemeWall. */
  actions: ReactNode;
  onClose: () => void;
}) {
  const t = useT();
  // Pushes onto the shared overlay stack: Escape and Android Back close only
  // this layer (the Settings modal's handler sees it is not top-of-stack),
  // Tab is trapped here, and focus returns to the Preview button.
  const { root, backOwner } = useOverlay(true, onClose);
  return createPortal(
    <AndroidBackOwner.Provider value={backOwner}>
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="fixed inset-0 z-[80] flex flex-col bg-void"
      >
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-overlay px-4 py-2 text-sm">
          <h2 className="font-semibold text-ink">{title}</h2>
          {chips}
          {notes.map((note) => (
            <span key={note} className="text-ink-dim">
              {note}
            </span>
          ))}
          <span className="flex-1" />
          {actions}
          <Button initialFocus title="Esc" onClick={onClose}>
            {t("settings.appearance.previewClose")}
          </Button>
        </header>
        {failures.length > 0 && (
          <div className="shrink-0 border-b border-line bg-overlay px-4 py-2 text-sm text-rose">
            <GateFailureList failures={failures} />
          </div>
        )}
        <div className="min-h-0 flex-1">
          <ThemeSpecimen theme={theme} variant="full" />
        </div>
      </div>
    </AndroidBackOwner.Provider>,
    document.body,
  );
}
