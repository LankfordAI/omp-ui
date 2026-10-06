import { useCallback, type ReactNode } from "react";
import type { ObsidianNoteTarget } from "@omp-ui/core/vault-shared";
import { ObsidianNoteLinkContext } from "./Markdown";
import { OpenInObsidianLink } from "./OpenInObsidianButton";

/** The whole tab shares its owner, including inspector panes and portals. */
export function MarkdownVaultProvider({ tabId, children }: { tabId: string; children: ReactNode }) {
  const renderLink = useCallback((target: ObsidianNoteTarget, label: ReactNode) => (
    <OpenInObsidianLink vaultName={target.vaultName} file={target.file} tabId={tabId}>
      {label}
    </OpenInObsidianLink>
  ), [tabId]);

  return <ObsidianNoteLinkContext.Provider value={renderLink}>{children}</ObsidianNoteLinkContext.Provider>;
}
