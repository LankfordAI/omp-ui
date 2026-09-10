/**
 * The opaque witness that exactly one process owns a data root (issue #442
 * §10.1; #450). Minted only by `claimAuthority` — which publishes `host.lock`
 * — and, for Release P's Electron main, `claimLegacyElectronAuthority`, both
 * in `@omp-ui/host`. `Registry.load` and the resume seam demand one, so a
 * store reached without a claimed lock is a type error rather than a
 * boot-sequence convention. Core defines the shape and never mints it.
 */
export interface AuthorityToken {
  /** The canonical root the token covers; every store it unlocks lives under it. */
  readonly dataRoot: string;
  /** Strictly increasing across claims of one data root; stale names carry it. */
  readonly incarnation: number;
}
