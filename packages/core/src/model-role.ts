// Pure model-role parsing, zero runtime imports — the renderer imports this
// via the @omp-ui/core/model-role subpath (see packages/core/package.json).

/** A `modelRoles.<role>` value: the model plus omp's `:<level>` suffix if present. */
export interface ModelRole {
  /** `provider/model` with any `:<level>` suffix stripped. */
  model: string;
  /** omp's thinking-level suffix (`high`, `low`, …), when the value carried one. */
  level?: string;
}

/**
 * Splits omp's role selector into model and thinking level. The model id itself
 * may contain colons (OpenRouter's `model:exacto`), and omp's own resolver
 * strips suffixes from the right — so only a final segment that looks like a
 * bare level word is treated as one.
 */
const LEVEL_RE = /^[a-z]+$/;

export function parseModelRole(value: string): ModelRole | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const colon = trimmed.lastIndexOf(":");
  // A colon at the very start or end names no model — take the whole string.
  if (colon > 0 && colon < trimmed.length - 1) {
    const tail = trimmed.slice(colon + 1);
    // `anthropic/claude:high` splits; `openai/gpt:exacto-2` does not (digits).
    if (LEVEL_RE.test(tail)) return { model: trimmed.slice(0, colon), level: tail };
  }
  return { model: trimmed };
}

/** Re-joins a role back into omp's `model[:level]` selector form. */
export function formatModelRole(role: ModelRole): string {
  return role.level === undefined ? role.model : `${role.model}:${role.level}`;
}
