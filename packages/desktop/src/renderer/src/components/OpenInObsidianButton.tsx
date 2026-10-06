import { useEffect, useRef, useState } from "react";
import { obsidianOpenUri } from "@omp-ui/core/vault-shared";
import { copyFallback } from "../lib/clipboard";
import { useT } from "../lib/i18n";
import { IS_ELECTRON } from "../lib/platform";
import { findOwner, useStore } from "../store";
import { Button, ICON_STROKE } from "./ui";

function ExternalGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0" {...ICON_STROKE}>
      <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
    </svg>
  );
}

/**
 * "Open in Obsidian" (issue #764). Open mode needs the Electron shell, a local
 * owner and an obsidian:// handler: it sends the registry name and the
 * vault-relative note to main, which resolves both and builds the URI. Anything
 * else is copy mode: a basename-keyed obsidian:// link goes to the clipboard
 * for a machine that has this vault (#759), never opened here. When the
 * clipboard refuses, the link shows inline in a selectable mono line instead.
 */
export function OpenInObsidianButton({
  vaultName,
  file,
  tabId,
  uriHandler,
}: {
  vaultName: string;
  file: string | null;
  /** The tab whose transcript holds the button; a tab owned by a joined instance copies (issue #416). */
  tabId?: string;
  /** Whether an obsidian:// handler is registered; false falls back to copy. */
  uriHandler?: boolean;
}) {
  const t = useT();
  const openVault = useStore((s) => s.openVault);
  const local = useStore((s) => tabId === undefined || findOwner(s.state, tabId)?.instanceId == null);
  const mode = IS_ELECTRON && local && uriHandler !== false ? "open" : "copy";

  const [copy, setCopy] = useState<{ state: "idle" | "copied" | "failed"; uri: string }>({ state: "idle", uri: "" });
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const settle = (copied: boolean, uri: string): void => {
    window.clearTimeout(timer.current);
    setCopy({ state: copied ? "copied" : "failed", uri });
    if (copied) timer.current = window.setTimeout(() => setCopy({ state: "idle", uri: "" }), 2000);
  };

  const onClick = (): void => {
    if (mode === "open") {
      void openVault(vaultName, file);
      return;
    }
    const uri = obsidianOpenUri({ vault: vaultName }, file);
    if (typeof navigator.clipboard?.writeText !== "function") {
      settle(copyFallback(uri), uri);
      return;
    }
    void navigator.clipboard.writeText(uri).then(
      () => settle(true, uri),
      () => settle(copyFallback(uri), uri),
    );
  };

  const copied = mode === "copy" && copy.state === "copied";
  return (
    <span className="inline-flex min-w-0 shrink-0 flex-col items-end gap-1">
      {/* Button's onClick carries no event; the wrapper keeps the click out of an enclosing clickable row. */}
      <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
        <Button
          size="xs"
          tone={copied ? "signal" : "neutral"}
          title={mode === "copy" ? t("transcript.vault.copyTitle") : undefined}
          onClick={onClick}
        >
          <ExternalGlyph />
          {copied ? t("transcript.vault.linkCopied") : t("transcript.vault.openInObsidian")}
        </Button>
      </span>
      {mode === "copy" && copy.state === "failed" && (
        <span data-selectable className="max-w-full select-all break-all font-mono text-[10px] text-ink-mid">
          {copy.uri}
        </span>
      )}
    </span>
  );
}
