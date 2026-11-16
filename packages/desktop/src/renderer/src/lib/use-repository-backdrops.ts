import { useEffect, useReducer, useRef } from "react";
import type { ThemeBackdropMime } from "@omp-ui/core/theme-backdrop";
import type {
  RepositoryThemeBackdropResult,
  RepositoryThemeInstallRequest,
} from "@omp-ui/core/theme-repository-format";
import { displayMessage } from "../backend";
import { backdropAssetFromBytes, releaseBackdropAsset, type BackdropAsset } from "./backdrop";
import { base64ToBytes } from "./clipboard-image";

export type RepositoryBackdrop =
  | { status: "loading" }
  | { status: "ready"; asset: BackdropAsset; mime: ThemeBackdropMime; blur: number }
  | { status: "error"; message: string };

/** Ready assets kept at once; past this the least recently requested one is released. */
const READY_MAX = 8;

/**
 * Repository theme backdrops fetched on Preview (#1182, ADR-0096 §12), by
 * entry blob SHA. Assets live until the wall unmounts or are evicted; an error
 * is retried on the next request.
 */
export function useRepositoryBackdrops(
  load: (request: RepositoryThemeInstallRequest) => Promise<RepositoryThemeBackdropResult>,
): {
  get(blob: string): RepositoryBackdrop | undefined;
  request(request: RepositoryThemeInstallRequest, blob: string): void;
} {
  const entries = useRef(new Map<string, RepositoryBackdrop>());
  const mounted = useRef(false);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    mounted.current = true;
    const map = entries.current;
    return () => {
      mounted.current = false;
      for (const entry of map.values()) if (entry.status === "ready") releaseBackdropAsset(entry.asset);
      map.clear();
    };
  }, []);

  const settle = (blob: string, next: RepositoryBackdrop): void => {
    const map = entries.current;
    map.delete(blob);
    map.set(blob, next);
    const ready = [...map].filter(([, entry]) => entry.status === "ready");
    while (ready.length > READY_MAX) {
      const [oldest, entry] = ready.shift()!;
      if (entry.status === "ready") releaseBackdropAsset(entry.asset);
      map.delete(oldest);
    }
    rerender();
  };

  return {
    get: (blob) => entries.current.get(blob),
    request: (request, blob) => {
      const map = entries.current;
      const current = map.get(blob);
      if (current !== undefined && current.status !== "error") {
        // Most recently requested last, so eviction never takes the one on screen.
        map.delete(blob);
        map.set(blob, current);
        return;
      }
      map.set(blob, { status: "loading" });
      rerender();
      load(request).then(
        (result) => {
          if (!mounted.current) return;
          if (!result.ok) {
            settle(blob, { status: "error", message: result.message });
            return;
          }
          const { mime, data, blur } = result.backdrop;
          settle(blob, { status: "ready", asset: backdropAssetFromBytes(base64ToBytes(data), mime), mime, blur });
        },
        (err: unknown) => {
          if (mounted.current) settle(blob, { status: "error", message: displayMessage(err) });
        },
      );
    },
  };
}
