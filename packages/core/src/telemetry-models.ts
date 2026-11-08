import { OAUTH_PROVIDER_SPECS, PROVIDER_KEY_SPECS } from "./provider-catalog";
import publicCatalog from "./telemetry-public-models.json";

// This bundled, generated snapshot is the only model authority: never consult an
// installed OMP catalog or a live/user-defined endpoint. Provenance and retrieval
// date live beside the sorted identifiers in telemetry-public-models.json.
let publicModels: Set<string> | undefined;
let publicProviders: Set<string> | undefined;
const OTHER = "custom/other";

/** Exact public membership only: deployment suffixes and custom routes stay local. */
export function telemetryModelDimensions(provider: string, model: string): { provider: string; model: string } {
  publicModels ??= new Set<string>(publicCatalog.models);
  publicProviders ??= new Set<string>([
    ...publicCatalog.providers,
    ...PROVIDER_KEY_SPECS.filter((spec) => spec.group === "models").map((spec) => spec.id),
    ...OAUTH_PROVIDER_SPECS.map((spec) => spec.providerId),
    // OMP's subscription route is evidenced by stats-store.ts's xAI pricing rule.
    "xai-oauth",
  ]);
  if (!publicProviders.has(provider)) return { provider: OTHER, model: OTHER };
  return { provider, model: publicModels.has(model) ? model : OTHER };
}
