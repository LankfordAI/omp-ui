import { useT } from "../../lib/i18n";
import { findInstance, findOwner, useStore } from "../../store";
import { Button, Panel } from "../ui";

/** User-controlled offer to open a loopback tool-result URL in the browser pane (#543). */
export function BrowserPaneOffer({ tabId }: { tabId: string }) {
  const t = useT();
  const offers = useStore((state) => state.rpc[tabId]?.browserPane.offers ?? []);
  const instanceDown = useStore((state) => {
    const instanceId = findOwner(state.state, tabId)?.instanceId ?? null;
    return instanceId !== null && findInstance(state.state, instanceId)?.status !== "joined";
  });
  const accept = useStore((state) => state.acceptBrowserPaneOffer);
  const decline = useStore((state) => state.declineBrowserPaneOffer);
  if (offers.length === 0) return null;

  return (
    <div className="px-3 pt-2">
      <Panel tone="neutral" className="animate-rise space-y-1.5 px-2.5 py-2">
        <p className="text-[11px] leading-snug text-ink-mid">{t("browser.offer.text")}</p>
        {offers.slice(0, 3).map((url) => (
          <div key={url} className="flex min-w-0 items-center gap-2">
            <span data-selectable className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">
              {url}
            </span>
            <Button size="xs" disabled={instanceDown} onClick={() => accept(tabId, url)}>
              {t("browser.offer.open")}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => decline(tabId, url)}>
              {t("browser.offer.dismiss")}
            </Button>
          </div>
        ))}
      </Panel>
    </div>
  );
}
