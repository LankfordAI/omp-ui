import { useEffect, useRef, useState, type ReactNode } from "react";
import { obsidianOpenUri } from "@omp-ui/core/vault-shared";
import { desktopPaneMedia } from "../backend";
import { copyFallback } from "../lib/clipboard";
import { useT } from "../lib/i18n";
import { IS_ELECTRON } from "../lib/platform";
import { findOwner, useStore } from "../store";
import { Button, ICON_STROKE, IconButton } from "./ui";

function ExternalGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0" {...ICON_STROKE}>
      <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
    </svg>
  );
}

function useObsidianAction(vaultName: string, file: string | null, mode: "open" | "copy") {
  const openVault = useStore((s) => s.openVault);
  const [copy, setCopy] = useState<{ state: "idle" | "copied" | "failed"; uri: string }>({ state: "idle", uri: "" });
  const timer = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  const settle = (copied: boolean, uri: string): void => {
    if (!mounted.current) return;
    window.clearTimeout(timer.current);
    setCopy({ state: copied ? "copied" : "failed", uri });
    if (copied) timer.current = window.setTimeout(() => setCopy({ state: "idle", uri: "" }), 2000);
  };

  const fallback = (uri: string): void => {
    if (!mounted.current) return;
    const focused = document.activeElement;
    const copied = copyFallback(uri);
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    settle(copied, uri);
  };

  const activate = (): void => {
    if (mode === "open") {
      void openVault(vaultName, file);
      return;
    }
    const uri = obsidianOpenUri({ vault: vaultName }, file);
    if (typeof navigator.clipboard?.writeText !== "function") {
      fallback(uri);
      return;
    }
    void navigator.clipboard.writeText(uri).then(
      () => settle(true, uri),
      () => fallback(uri),
    );
  };

  return {
    activate,
    copied: mode === "copy" && copy.state === "copied",
    failedUri: mode === "copy" && copy.state === "failed" ? copy.uri : null,
  };
}

/**
 * "Open in Obsidian" (issue #764). Open mode needs the Electron shell's preload
 * transport — a shared Electron user agent alone misreads a viewer inside an
 * Electron browser pane (#782) — a local owner and an obsidian:// handler: it
 * sends the registry name and the vault-relative note to main, which resolves
 * both and builds the URI. Anything
 * else is copy mode: a basename-keyed obsidian:// link goes to the clipboard
 * for a machine that has this vault (#759), never opened here. When the
 * clipboard refuses, the link shows inline in a selectable mono line instead;
 * the icon-only face puts it in the button's label.
 */
export function OpenInObsidianButton({
  vaultName,
  file,
  tabId,
  uriHandler,
  iconOnly = false,
}: {
  vaultName: string;
  file: string | null;
  /** The tab whose transcript holds the button; a tab owned by a joined instance copies (issue #416). */
  tabId?: string;
  /** Whether an obsidian:// handler is registered; false falls back to copy. */
  uriHandler?: boolean;
  /** Icon-only face for dense rows (the rail's Vault notes). A refused clipboard
   *  puts the link in the button's label instead of an inline line, so the row
   *  never grows a second line. */
  iconOnly?: boolean;
}) {
  const t = useT();
  const local = useStore((s) => tabId === undefined || findOwner(s.state, tabId)?.instanceId == null);
  // An Electron-hosted browser viewer still has an Electron UA, but no preload transport (#782).
  const mode = IS_ELECTRON && desktopPaneMedia !== null && local && uriHandler !== false ? "open" : "copy";
  const { activate, copied, failedUri } = useObsidianAction(vaultName, file, mode);

  if (iconOnly) {
    const label = copied
      ? t("transcript.vault.linkCopied")
      : failedUri !== null
        ? failedUri
        : t("transcript.vault.openInObsidian");
    return (
      <span className="inline-flex shrink-0" onClick={(e) => e.stopPropagation()}>
        <IconButton label={label} onClick={activate} className={copied ? "text-signal" : undefined}>
          <ExternalGlyph />
        </IconButton>
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-0 shrink-0 flex-col items-end gap-1">
      {/* Button's onClick carries no event; the wrapper keeps the click out of an enclosing clickable row. */}
      <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
        <Button
          size="xs"
          tone={copied ? "signal" : "neutral"}
          title={mode === "copy" ? t("transcript.vault.copyTitle") : undefined}
          onClick={activate}
        >
          <ExternalGlyph />
          {copied ? t("transcript.vault.linkCopied") : t("transcript.vault.openInObsidian")}
        </Button>
      </span>
      {failedUri !== null && (
        <span data-selectable className="max-w-full select-all break-all font-mono text-[10px] text-ink-mid">
          {failedUri}
        </span>
      )}
    </span>
  );
}

/** Transcript links use their owning tab, never the currently selected tab. */
export function OpenInObsidianLink({
  vaultName,
  file,
  tabId,
  uriHandler,
  children,
}: {
  vaultName: string;
  file: string;
  tabId?: string;
  uriHandler?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const local = useStore((s) => tabId !== undefined && findOwner(s.state, tabId)?.instanceId === null);
  // An Electron-hosted browser viewer still has an Electron UA, but no preload transport (#782).
  const mode = IS_ELECTRON && desktopPaneMedia !== null && local && uriHandler !== false ? "open" : "copy";
  const { activate, copied, failedUri } = useObsidianAction(vaultName, file, mode);

  return (
    <span onClick={(e) => e.stopPropagation()}>
      <a
        role="link"
        tabIndex={0}
        title={t(mode === "open" ? "transcript.vault.openInObsidian" : "transcript.vault.copyTitle")}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.button === 0) activate();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            activate();
          }
        }}
        onAuxClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        className="cursor-pointer text-iris underline decoration-iris-dim underline-offset-2 hover:decoration-iris"
      >
        {children}
      </a>
      <span role="status" aria-live="polite" className="ml-1 text-[0.85em] text-ink-mid">
        {copied ? t("transcript.vault.linkCopied") : null}
      </span>
      {failedUri !== null && (
        <span data-selectable className="ml-1 max-w-full select-all break-all font-mono text-[0.85em] text-ink-mid">
          {failedUri}
        </span>
      )}
    </span>
  );
}
