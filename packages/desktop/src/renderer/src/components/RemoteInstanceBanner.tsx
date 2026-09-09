import { useT } from "../lib/i18n";
import { findInstance, findOwner, useStore } from "../store";
import { Button, Dot, Panel } from "./ui";

/**
 * The tab-top notice for a session whose remote instance is not joined
 * (issue #416): the tab stays mounted with its last output, and this line says
 * why nothing new arrives. Unreachable means main is retrying on its own; a
 * rejected credential (or a version/self refusal) needs the user in Settings,
 * so those carry the button. Renders nothing for local tabs and joined ones.
 */
export function RemoteInstanceBanner({ tabId }: { tabId: string }) {
  const t = useT();
  const instance = useStore((s) => {
    const owner = findOwner(s.state, tabId);
    return owner?.instanceId == null ? undefined : findInstance(s.state, owner.instanceId);
  });
  const openSettings = useStore((s) => s.openSettings);
  if (instance === undefined || instance.status === "joined") return null;
  const reconnecting = instance.status === "unreachable" || instance.status === "connecting";
  return (
    <div className="px-3 pt-2">
      <Panel tone={reconnecting ? "neutral" : "rose"} className="animate-rise flex items-center gap-2 px-2.5 py-2">
        <Dot tone={reconnecting ? "neutral" : "rose"} pulse={reconnecting} />
        <p className="min-w-0 flex-1 text-[11px] leading-snug text-ink-mid">
          {reconnecting
            ? t("remoteinstances.banner.unreachable", { nickname: instance.nickname })
            : t("remoteinstances.banner.needsSignIn", { nickname: instance.nickname })}
        </p>
        {!reconnecting && (
          <Button size="xs" variant="ghost" onClick={() => openSettings("remote-instances")}>
            {t("remoteinstances.banner.openSettings")}
          </Button>
        )}
      </Panel>
    </div>
  );
}
