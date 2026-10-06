// Version 1. Ordered, non-global patterns: return only the shape id, never a match.
const VAULT_SECRET_SHAPES = [
  ["openai-key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{22,}/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
] as const;

export function scanSecrets(text: string): string | null {
  for (const [id, pattern] of VAULT_SECRET_SHAPES) {
    if (pattern.test(text)) return id;
  }
  return null;
}
