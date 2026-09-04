// Zero-import on purpose: the renderer bundles this file to label and group the
// providers page, exactly like omp-settings-keys.ts. Node-only logic (reading,
// decrypting, and resolving the values) lives in provider-keys.ts.
//
// The list is transcribed from omp's own `--help` environment table (v18.1.0),
// which is the authority on which variable name authenticates which provider.
// Only credentials a user can paste as a single opaque string are here:
// AWS_PROFILE, GOOGLE_CLOUD_PROJECT, and GOOGLE_APPLICATION_CREDENTIALS are a
// profile name, a project id, and a file path, so a "paste your key" field
// would be the wrong shape for them and they are deliberately absent.

/** Which section of the providers page a credential belongs to. */
export type ProviderKeyGroup = "models" | "search";

export interface ProviderKeySpec {
  /** omp's own provider id where one exists, else a stable slug for this row. */
  id: string;
  label: string;
  group: ProviderKeyGroup;
  /** The environment variable omp reads for this credential. */
  env: string;
  /**
   * Other variables that authenticate the same provider. Read (so an existing
   * one is reported rather than shown as unset) but never written — a value
   * typed into the page always lands on {@link ProviderKeySpec.env}.
   */
  alsoRead?: readonly string[];
  /** Where to get the key, shown as the field's hint. */
  hint?: string;
}

export const PROVIDER_KEY_SPECS: readonly ProviderKeySpec[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    group: "models",
    env: "OPENROUTER_API_KEY",
    hint: "openrouter.ai/keys",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    group: "models",
    env: "ANTHROPIC_API_KEY",
    // omp documents the OAuth token as taking precedence over the API key.
    alsoRead: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
    hint: "console.anthropic.com",
  },
  { id: "openai", label: "OpenAI", group: "models", env: "OPENAI_API_KEY", hint: "platform.openai.com" },
  { id: "google", label: "Google Gemini", group: "models", env: "GEMINI_API_KEY", hint: "aistudio.google.com" },
  { id: "xai", label: "xAI Grok", group: "models", env: "XAI_API_KEY", hint: "console.x.ai" },
  { id: "groq", label: "Groq", group: "models", env: "GROQ_API_KEY", hint: "console.groq.com" },
  { id: "cerebras", label: "Cerebras", group: "models", env: "CEREBRAS_API_KEY" },
  { id: "mistral", label: "Mistral", group: "models", env: "MISTRAL_API_KEY" },
  { id: "zai", label: "z.ai (GLM)", group: "models", env: "ZAI_API_KEY" },
  { id: "minimax", label: "MiniMax", group: "models", env: "MINIMAX_API_KEY" },
  { id: "kilo", label: "Kilo Gateway", group: "models", env: "KILO_API_KEY" },
  { id: "opencode", label: "OpenCode Zen", group: "models", env: "OPENCODE_API_KEY" },
  { id: "cursor", label: "Cursor", group: "models", env: "CURSOR_ACCESS_TOKEN" },
  { id: "github-copilot", label: "GitHub Copilot", group: "models", env: "COPILOT_GITHUB_TOKEN" },
  { id: "azure", label: "Azure OpenAI", group: "models", env: "AZURE_OPENAI_API_KEY" },
  { id: "vercel-ai-gateway", label: "Vercel AI Gateway", group: "models", env: "AI_GATEWAY_API_KEY" },
  { id: "wafer", label: "Wafer Serverless", group: "models", env: "WAFER_SERVERLESS_API_KEY" },
  { id: "umans", label: "Umans AI", group: "models", env: "UMANS_AI_CODING_PLAN_API_KEY" },
  { id: "exa", label: "Exa", group: "search", env: "EXA_API_KEY" },
  { id: "brave", label: "Brave", group: "search", env: "BRAVE_API_KEY" },
  { id: "tavily", label: "Tavily", group: "search", env: "TAVILY_API_KEY" },
  { id: "perplexity", label: "Perplexity", group: "search", env: "PERPLEXITY_API_KEY" },
  { id: "firecrawl", label: "Firecrawl", group: "search", env: "FIRECRAWL_API_KEY" },
];

/** Every variable name this feature reads, in spec order (primary then alternates). */
export const PROVIDER_ENV_NAMES: readonly string[] = PROVIDER_KEY_SPECS.flatMap((spec) => [
  spec.env,
  ...(spec.alsoRead ?? []),
]);

export function providerSpecById(id: string): ProviderKeySpec | undefined {
  return PROVIDER_KEY_SPECS.find((spec) => spec.id === id);
}

/** A provider omp authenticates by OAuth login, not by an environment variable. */
export interface OAuthProviderSpec {
  /** Row key on the providers page; distinct from any PROVIDER_KEY_SPECS id. */
  id: string;
  /** omp's provider id — the argument to `login`, `omp token`, `omp auth-broker logout`. */
  providerId: string;
  label: string;
  hint: string;
}

/**
 * Transcribed from `omp auth-broker list` (v18.1.0). Only subscriptions that
 * bill separately from an API-key row belong here; `id` and `providerId` are
 * both kept so a future row whose omp id collides with an API-key row (e.g.
 * anthropic) can still have a unique page key.
 */
export const OAUTH_PROVIDER_SPECS: readonly OAuthProviderSpec[] = [
  {
    id: "openai-codex",
    providerId: "openai-codex",
    label: "ChatGPT Plus/Pro",
    hint: "Codex subscription — models appear as openai-codex/…",
  },
];

export function oauthSpecById(id: string): OAuthProviderSpec | undefined {
  return OAUTH_PROVIDER_SPECS.find((spec) => spec.id === id);
}
