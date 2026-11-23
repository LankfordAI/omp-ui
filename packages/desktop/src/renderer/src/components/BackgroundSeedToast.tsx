import { useCallback } from "react";
import { findRecord, useStore } from "../store";
import { Button, UpdateCard } from "./ui";

/**
 * A background launch whose first prompt never went out (issue #982). The
 * warn notice sits on the new tab, which the user is not looking at — this
 * toast says so where they are and opens the session. Same corner stack as
 * the settle toast (App.tsx positions it); it stays until dismissed.
 */
export function BackgroundSeedToast() {
  const tabId = useStore((s) => s.backgroundSeedFailedTabId);
  const title = useStore((s) => (tabId === null ? undefined : findRecord(s.state, tabId)?.title));
  const focusTab = useStore((s) => s.focusTab);
  const dismiss = useStore((s) => s.dismissBackgroundSeedToast);
  const onDismiss = useCallback(() => dismiss(), [dismiss]);
  if (tabId === null) return null;
  return (
    <UpdateCard key={tabId} dismissLabel="dismiss" onDismiss={onDismiss}>
      <div role="alert" className="min-w-0">
        <p className="text-sm font-medium text-ink">
          {`${title ?? "A new session"} started in the background, but its first prompt was not sent.`}
        </p>
        <div className="mt-2">
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              focusTab(tabId);
              dismiss();
            }}
          >
            Open session
          </Button>
        </div>
      </div>
    </UpdateCard>
  );
}
