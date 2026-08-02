import type { ModelInfo } from "./rpc-types";

/**
 * Pure filter: given a tab ("favorites" or a provider name), return models
 * that belong to that tab. When tab is "favorites", only returns models whose
 * `provider/id` key is in the favorites Set. Orphaned favorites (key present
 * but model no longer in availableModels) are silently dropped.
 */
export function filterModelsForTab(
  models: ModelInfo[],
  tab: string,
  favorites: Set<string>,
): ModelInfo[] {
  if (tab === "favorites") {
    return models.filter((m) => favorites.has(`${m.provider}/${m.id}`));
  }
  return models.filter((m) => m.provider === tab);
}
