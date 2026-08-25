/** The narrow HTTP surface used by JSON and checksum requests. */
export interface FetchLike {
  (url: string, init?: { signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

/**
 * Streaming fetch surface for large assets. The optional headers/body keep
 * small arrayBuffer-only test doubles structurally compatible.
 */
export interface DownloadFetchLike {
  (url: string, init?: { signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    headers?: { get(name: string): string | null };
    body?: {
      getReader(): {
        read(): Promise<{ done: boolean; value?: Uint8Array }>;
      };
    } | null;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

/** The process's global fetch, narrowed to the JSON/checksum surface. */
export const defaultFetch: FetchLike = fetch as unknown as FetchLike;

/** The process's global fetch, narrowed to the streaming download surface. */
export const defaultDownloadFetch: DownloadFetchLike = fetch as unknown as DownloadFetchLike;
