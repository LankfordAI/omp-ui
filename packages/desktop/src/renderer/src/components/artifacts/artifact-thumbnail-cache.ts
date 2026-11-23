const MAX_CACHE_ENTRIES = 128;

/**
 * Bounded LRU cache mapping exact payload SHA-256 hashes to `data:<mime>;base64,...` URLs.
 * Cleared whenever the artifact library is disabled so no cached pixels linger in memory.
 */
const cache = new Map<string, string>();

export function getCachedThumbnail(hash: string): string | null {
  const hit = cache.get(hash);
  if (hit === undefined) return null;
  cache.delete(hash);
  cache.set(hash, hit);
  return hit;
}

export function setCachedThumbnail(hash: string, dataUrl: string): void {
  if (cache.has(hash)) cache.delete(hash);
  cache.set(hash, dataUrl);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function clearThumbnailCache(): void {
  cache.clear();
}
