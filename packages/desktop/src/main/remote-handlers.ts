import {
  CH,
  type Registry,
  type RemoteBind,
  type RemoteState,
  type RequestHandlers,
} from "@omp-ui/core";
import { hashRemotePassword, mintRemoteToken, validateRemotePassword } from "@omp-ui/server";
import type { BreadcrumbSink } from "./breadcrumbs";

type RemoteHandlerChannels =
  | typeof CH.getRemoteState
  | typeof CH.setRemoteEnabled
  | typeof CH.setRemoteBind
  | typeof CH.setRemotePort
  | typeof CH.regenerateRemoteToken
  | typeof CH.setRemotePassword
  | typeof CH.clearRemotePassword;

interface RemoteHandlerDependencies {
  registry: Registry;
  getState: () => RemoteState;
  apply: () => Promise<void>;
  restart: () => Promise<void>;
  breadcrumbs: BreadcrumbSink;
}

export function registerRemoteHandlers(
  deps: RemoteHandlerDependencies,
): Pick<RequestHandlers, RemoteHandlerChannels> {
  return {
    [CH.getRemoteState]: () => deps.getState(),
    [CH.setRemoteEnabled]: async (on: boolean) => {
      deps.registry.setSetting("remoteEnabled", on);
      deps.breadcrumbs.record("remote-enable", { detail: on ? "on" : "off" });
      await deps.apply();
    },
    [CH.setRemoteBind]: async (bind: RemoteBind) => {
      deps.registry.setSetting("remoteBind", bind);
      await deps.apply();
    },
    [CH.setRemotePort]: async (port: number) => {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error("port must be a whole number between 1024 and 65535");
      }
      deps.registry.setSetting("remotePort", port);
      await deps.apply();
    },
    [CH.regenerateRemoteToken]: async () => {
      deps.registry.setSetting("remoteToken", mintRemoteToken());
      deps.breadcrumbs.record("remote-token-regenerate");
      await deps.restart();
    },
    [CH.setRemotePassword]: async (password: string) => {
      const problem = validateRemotePassword(password);
      if (problem !== null) throw new Error(problem);
      const { salt, hash } = hashRemotePassword(password);
      deps.registry.setSettings({ remotePasswordHash: hash, remotePasswordSalt: salt });
      await deps.apply();
    },
    [CH.clearRemotePassword]: async () => {
      deps.registry.setSettings({ remotePasswordHash: "", remotePasswordSalt: "" });
      await deps.apply();
    },
  };
}
