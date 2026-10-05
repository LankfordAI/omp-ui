// PROTOTYPE (#753): throwaway.
// The "notes touched this session" surfaces: a HUD button with a popover list
// (plus its compact-sheet twin), the list body the inspector rail wraps, and
// an in-flow transcript notice. All derive from the vault-write cards.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../../store";
import { Chip, IconButton, Label } from "../ui";
import { scrollToCard, useTouchedNotes, vaultUri, type TouchedNote } from "./fixtures";
import { ActionChip, NoteGlyph, OpenInObsidian } from "./shared";
import { usePrototype753, usePrototypeData } from "./state";

const PANEL_WIDTH = 288; // w-72
const EDGE = 8;

export function useNotesTouchedCount(tabId: string): number {
  return useTouchedNotes(tabId).length;
}

function NoteRow({
  tabId,
  note,
  showVault,
  onJump,
}: {
  tabId: string;
  note: TouchedNote;
  showVault: boolean;
  onJump?: () => void;
}) {
  return (
    <li className="flex min-w-0 items-center gap-1.5">
      <NoteGlyph className="text-ink-dim" />
      <button
        type="button"
        title={note.path}
        className="min-w-0 flex-1 cursor-pointer truncate text-left text-xs text-ink hover:underline hover:decoration-dotted hover:underline-offset-2"
        onClick={() => {
          onJump?.();
          scrollToCard(tabId, note.itemId);
        }}
      >
        {note.title}
      </button>
      <ActionChip action={note.action} />
      {showVault && <Chip mono>{note.vault}</Chip>}
      <OpenInObsidian uri={vaultUri(note.vaultId, note.path)} iconOnly />
    </li>
  );
}

/** The list body: every surface but the notice shares it. */
export function NotesTouchedList({ tabId, onJump }: { tabId: string; onJump?: () => void }) {
  const notes = useTouchedNotes(tabId);
  const { vaults } = usePrototypeData();
  if (notes.length === 0) return <p className="text-[11px] text-ink-faint">No vault notes yet</p>;
  return (
    <ul className="space-y-1">
      {notes.map((note) => (
        <NoteRow key={`${note.vaultId}:${note.path}`} tabId={tabId} note={note} showVault={vaults.length > 1} onJump={onJump} />
      ))}
    </ul>
  );
}

/** HUD variant: a note button with a neutral count badge and a portaled popover. */
export function NotesTouchedHudButton({ tabId }: { tabId: string }) {
  const proto = usePrototype753();
  const count = useNotesTouchedCount(tabId);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const shown = proto.active && proto.touched === "hud";

  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const maxRight = Math.max(EDGE, window.innerWidth - PANEL_WIDTH - EDGE);
      const right = Math.min(Math.max(EDGE, window.innerWidth - rect.right), maxRight);
      setPos({ top: rect.bottom + 6, right });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (anchor.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);

  if (!shown) return null;
  return (
    <>
      <span ref={anchor} className="relative shrink-0">
        <IconButton label="Vault notes touched this session" pressed={open} onClick={() => setOpen((v) => !v)}>
          <NoteGlyph />
        </IconButton>
        {count > 0 && (
          <span className="pointer-events-none absolute -right-1.5 -top-1 min-w-3 rounded-full border border-line bg-raised px-0.5 text-center font-mono text-[9px] leading-3 text-ink-mid">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </span>
      {open &&
        pos !== null &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label="Vault notes"
            style={{ position: "fixed", top: pos.top, right: pos.right, maxHeight: `calc(100dvh - ${pos.top + EDGE}px)` }}
            className="glass-overlay z-[55] w-72 overflow-y-auto rounded-lg border border-line-strong p-2.5 shadow-lg"
          >
            <div className="mb-1.5 flex items-center gap-2">
              <Label className="min-w-0 flex-1 truncate">Vault notes</Label>
              {count > 0 && <Chip mono>{count}</Chip>}
            </div>
            <NotesTouchedList tabId={tabId} onJump={() => setOpen(false)} />
          </div>,
          document.body,
        )}
    </>
  );
}

/** HUD variant on the compact shell: a section in the session-actions sheet. */
export function NotesTouchedSheetSection({ tabId }: { tabId: string }) {
  const proto = usePrototype753();
  const count = useNotesTouchedCount(tabId);
  const closeCompactSurface = useStore((s) => s.closeCompactSurface);
  if (!proto.active || proto.touched !== "hud") return null;
  return (
    <div className="space-y-2 rounded-lg border border-line bg-raised/60 p-3">
      <div className="flex items-center justify-between gap-3">
        <Label>Vault notes</Label>
        <Chip mono>{count}</Chip>
      </div>
      <NotesTouchedList tabId={tabId} onJump={closeCompactSurface} />
    </div>
  );
}

/** Notice variant: one in-flow transcript line naming each note. */
export function NotesTouchedNotice({ tabId }: { tabId?: string }) {
  const id = tabId ?? "";
  const notes = useTouchedNotes(id);
  if (notes.length === 0) return null;
  const vaults = new Set(notes.map((note) => note.vaultId));
  const noun = notes.length === 1 ? "note" : "notes";
  const lead =
    vaults.size === 1
      ? `${notes.length} ${noun} in ${notes[0]!.vault}:`
      : `${notes.length} ${noun} in ${vaults.size} vaults:`;
  return (
    <div className="animate-rise flex justify-center">
      <div className="flex max-w-[80%] items-start gap-1.5 rounded-2xl border border-line bg-raised px-2.5 py-1 text-xs text-ink-mid">
        <NoteGlyph className="mt-px text-ink-dim" />
        <span className="min-w-0 break-words">
          {lead}{" "}
          {notes.map((note, index) => (
            <span key={`${note.vaultId}:${note.path}`}>
              {index > 0 && ", "}
              <button
                type="button"
                title={note.path}
                className="cursor-pointer text-left underline decoration-dotted underline-offset-2 hover:text-ink"
                onClick={() => scrollToCard(id, note.itemId)}
              >
                {note.title}
              </button>
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
