/** Renderer-safe diagnostics from omp web_search results. Never a success verdict. */
export interface WebSearchProviderFailure {
  provider: string;
  label: string;
  reason: string;
  status?: number;
}

/** Missing or foreign metadata has no decoration; malformed entries are ignored. */
export function parseWebSearchFailures(details: unknown): WebSearchProviderFailure[] | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const failures = (details as Record<string, unknown>).failures;
  if (!Array.isArray(failures)) return undefined;
  const parsed: WebSearchProviderFailure[] = [];
  for (const entry of failures) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const { provider, label, reason, status } = entry as Record<string, unknown>;
    if (typeof provider !== "string" || !provider.trim() ||
        typeof label !== "string" || !label.trim() ||
        typeof reason !== "string" || !reason.trim()) continue;
    if (status !== undefined && (typeof status !== "number" || !Number.isInteger(status) || status < 0)) continue;
    const failure: WebSearchProviderFailure = {
      provider,
      label,
      reason: reason.replace(/\s+/g, " ").trim().slice(0, 240),
    };
    if (typeof status === "number") failure.status = status;
    parsed.push(failure);
  }
  return parsed.length > 0 ? parsed : undefined;
}
