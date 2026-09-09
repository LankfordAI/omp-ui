import {
  TAB_ROUTED_NOTIFIES,
  TAB_ROUTED_REQUESTS,
  type ChannelTable,
  type SpawnRequest,
} from "@omp-ui/core";

export { TAB_ROUTED_NOTIFIES, TAB_ROUTED_REQUESTS };

/** The routing half of RemoteInstanceManager; named so the table never depends on the class. */
export interface TabRouteTarget {
  request(instanceId: string, channel: string, args: unknown[]): Promise<unknown>;
  notify(instanceId: string, channel: string, args: unknown[]): void;
  forwardViewed(clientId: string, tabId: string | null): void;
}

type Handler = (...args: unknown[]) => unknown;
type Handlers = Record<string, Handler>;

/**
 * Wraps a ChannelTable so every tab-scoped channel reaches the instance that owns the tab
 * (issue #416). Args arrive already decoded by dispatch, so `args[0]` is the tabId for every
 * channel in the two sets; `session:spawn` carries it inside the request for a resume and is
 * always local for a new session. `tab:viewed` runs locally and is then mirrored to the
 * owning instance. Everything else is passed through untouched.
 */
export function routeByTab(
  table: ChannelTable,
  owner: (tabId: string) => string | null,
  remote: TabRouteTarget,
): ChannelTable {
  const request: Handlers = { ...(table.request as unknown as Handlers) };
  const notify: Handlers = { ...(table.notify as unknown as Handlers) };

  for (const channel of TAB_ROUTED_REQUESTS) {
    const local = request[channel];
    if (!local) continue;
    request[channel] = (...args) => {
      const instance = typeof args[0] === "string" ? owner(args[0]) : null;
      return instance === null ? local(...args) : remote.request(instance, channel, args);
    };
  }
  for (const channel of TAB_ROUTED_NOTIFIES) {
    const local = notify[channel];
    if (!local) continue;
    notify[channel] = (...args) => {
      const instance = typeof args[0] === "string" ? owner(args[0]) : null;
      if (instance === null) local(...args);
      else remote.notify(instance, channel, args);
    };
  }

  const spawn = request["session:spawn"];
  if (spawn) {
    request["session:spawn"] = (...args) => {
      const req = args[0] as SpawnRequest;
      const instance = req.origin === "resume" ? owner(req.resumeTabId) : null;
      return instance === null ? spawn(...args) : remote.request(instance, "session:spawn", args);
    };
  }

  const viewed = notify["tab:viewed"];
  if (viewed) {
    notify["tab:viewed"] = (...args) => {
      viewed(...args);
      remote.forwardViewed(args[0] as string, args[1] as string | null);
    };
  }

  return {
    request: request as unknown as ChannelTable["request"],
    notify: notify as unknown as ChannelTable["notify"],
  };
}
