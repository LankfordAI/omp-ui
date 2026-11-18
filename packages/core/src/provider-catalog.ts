// Zero Node-import on purpose: the renderer bundles this file to label and
// group the providers page, exactly like omp-settings-keys.ts. Node-only logic
// (reading, decrypting, and resolving the values) lives in provider-keys.ts.
import { compareVersions } from "./semver";
//
// The list is transcribed from omp's own `--help` environment table (re-verified
// against v18.11.1), which is the authority on which variable name authenticates
// which provider.
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
    // The ANTHROPIC_SEARCH_* pair overrides web search only (isolating it from
    // the main key); not providers, so they ride here as read-alongside vars.
    alsoRead: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_SEARCH_API_KEY", "ANTHROPIC_SEARCH_BASE_URL"],
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
  { id: "cline", label: "ClinePass", group: "models", env: "CLINE_API_KEY" },
  { id: "command-code", label: "Command Code", group: "models", env: "COMMAND_CODE_API_KEY" },
  { id: "charm-hyper", label: "Charm Hyper", group: "models", env: "CHARM_HYPER_API_KEY" },
  { id: "stepfun", label: "StepFun", group: "models", env: "STEPFUN_API_KEY" },
  { id: "helmcode", label: "Helmcode (EU)", group: "models", env: "HELMCODE_API_KEY" },
  {
    id: "singularityapi-dev",
    label: "SingularityAPI",
    group: "models",
    env: "SINGULARITYAPI_DEV_API_KEY",
  },
  {
    id: "singularityapi-tech",
    label: "SingularityAPI DeepSeek",
    group: "models",
    env: "SINGULARITYAPI_TECH_API_KEY",
  },
  { id: "chutes", label: "Chutes", group: "models", env: "CHUTES_API_KEY" },
  { id: "otari", label: "Otari", group: "models", env: "OTARI_API_KEY", hint: "api.otari.ai" },
  // omp serves the Liquid and Nace decision models as `judge` models.
  { id: "liquid", label: "Liquid AI (judges)", group: "models", env: "LIQUID_API_KEY", hint: "console.liquid.ai" },
  { id: "nace", label: "Nace Drex (judges)", group: "models", env: "NACE_API_KEY", hint: "console.nace.ai" },
  // omp reads the combined `wk-<id>.ws-<secret>` proxy token; MODAL_BASE_URL is
  // an endpoint config, not a credential, so it stays out of the catalog.
  { id: "modal", label: "Modal", group: "models", env: "MODAL_PROXY_TOKEN" },
  { id: "yolo-auto", label: "Yolo-Auto", group: "models", env: "YOLO_AUTO_API_KEY" },
  { id: "abliteration", label: "Abliteration", group: "models", env: "ABLITERATION_API_KEY" },
  { id: "typesafe", label: "TypeSafe Jev", group: "models", env: "TYPESAFE_API_KEY" },
  { id: "exa", label: "Exa", group: "search", env: "EXA_API_KEY" },
  { id: "brave", label: "Brave", group: "search", env: "BRAVE_API_KEY" },
  { id: "tavily", label: "Tavily", group: "search", env: "TAVILY_API_KEY" },
  { id: "perplexity", label: "Perplexity", group: "search", env: "PERPLEXITY_API_KEY" },
  { id: "firecrawl", label: "Firecrawl", group: "search", env: "FIRECRAWL_API_KEY" },
  { id: "tinyfish", label: "TinyFish", group: "search", env: "TINYFISH_API_KEY" },
  { id: "sofya", label: "Sofya", group: "search", env: "SOFYA_API_KEY" },
];

/** Every variable name this feature reads, in spec order (primary then alternates). */
export const PROVIDER_ENV_NAMES: readonly string[] = PROVIDER_KEY_SPECS.flatMap((spec) => [
  spec.env,
  ...(spec.alsoRead ?? []),
]);

export function providerSpecById(id: string): ProviderKeySpec | undefined {
  return PROVIDER_KEY_SPECS.find((spec) => spec.id === id);
}

/**
 * omp appends this suffix to a login roster entry whose auth rule declares
 * `login-warning` (upstream `packages/ai/src/registry/oauth/index.ts`, since
 * v18.18.7). Such a login answers an account-risk prompt before any auth URL
 * (`packages/ai/src/auth/oauth.ts`, the `loginRiskWarning` block), and omp's
 * rpc `login` handler rejects a prompt that arrives before the first auth URL
 * outright (`packages/coding-agent/src/modes/rpc/rpc-mode.ts`, the `login`
 * case: "requires interactive prompts which are not supported in RPC mode").
 * No host could answer it before omp 18.22.1, which started routing the
 * prompt to RPC hosts (upstream #19527); older binaries still need a terminal,
 * which is what the rows fall back to (issue #1197).
 */
export const OAUTH_LOGIN_RISK_NAME_SUFFIX = " (at your own risk)";

/** True when a `get_login_providers` name carries omp's login-risk suffix. */
export function oauthLoginRiskFromRosterName(name: string): boolean {
  return name.endsWith(OAUTH_LOGIN_RISK_NAME_SUFFIX);
}

/**
 * The first omp whose rpc `login` answers the risk-warning prompt for RPC
 * hosts (upstream #19527, merged 2026-11-17): the prompt carries a
 * `riskAcknowledgement` marker and the handler routes it as an ordinary
 * `extension_ui_request` `input` (warning text as `title`, `placeholder:
 * "yes"`) instead of rejecting every pre-`onAuth` prompt. Verified live on
 * omp/18.22.2: a risk row's login emits the input frame, and an answer other
 * than "yes" ends the login with "Login cancelled". Below this version — and
 * for an unknown version — the prompt is unanswerable and the sign-in must run
 * in a terminal (issue #1197).
 */
export const RPC_RISK_LOGIN_MIN_OMP = "18.22.1";

/**
 * True when the installed omp can drive a risk-warning sign-in over RPC.
 * Unknown version is unsupported: an older binary rejects the prompt outright,
 * and the terminal path always works.
 */
export function supportsRpcRiskLogin(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, RPC_RISK_LOGIN_MIN_OMP) >= 0;
}

/** The exact terminal command that completes a sign-in RPC mode cannot. */
export function terminalLoginCommand(providerId: string): string {
  return `omp login ${providerId}`;
}

/**
 * English explanation core emits when a login cannot run over RPC — the same
 * reason a flagged row shows instead of a Sign in button, and the replacement
 * for omp's raw handler text. All core-side user strings are English (the
 * flow's other errors are omp's own English messages); the row copy around it
 * is translated.
 */
export function terminalLoginExplanation(providerId: string): string {
  return (
    "This provider asks you to accept an account-risk warning before the sign-in starts, " +
    `which omp cannot answer over RPC. Run \`${terminalLoginCommand(providerId)}\` in a terminal instead.`
  );
}

/**
 * omp's rpc `login` refusal for anything it cannot drive headlessly — the
 * risk-warning prompt thrown before any auth URL, and secret input, both end
 * on "which is not supported in RPC mode" (rpc-mode.ts, `login` case). The
 * row-level detection reads the roster, so this mapping only backstops a binary
 * whose names omp-ui cannot classify.
 */
export function isOmpRpcLoginBlockedError(error: string): boolean {
  return error.includes("not supported in RPC mode");
}

/** Presentation metadata for an omp provider sign-in row. */
export interface OAuthProviderSpec {
  /** Row key within the provider sign-in group. */
  id: string;
  /** omp's provider id — the argument to `login`, `get_logout_accounts`, `logout`. */
  providerId: string;
  label: string;
  hint: string;
  /**
   * True when the roster entry carries omp's login-risk suffix: the sign-in
   * answers an account-risk prompt before any auth URL. On binaries below
   * {@link RPC_RISK_LOGIN_MIN_OMP} that prompt cannot be answered over RPC and
   * the row publishes `requiresTerminalLogin`; on newer binaries the row signs
   * in over RPC like any other (issue #1197).
   */
  riskWarningLogin?: boolean;
}

/**
 * Curated presentation metadata and discovery-failure compatibility catalog,
 * not the complete login roster. Supported sign-ins come from the installed
 * omp binary; these rows retain their familiar labels when discovered.
 */
export const OAUTH_PROVIDER_SPECS: readonly OAuthProviderSpec[] = [
  {
    id: "openai-codex",
    providerId: "openai-codex",
    label: "ChatGPT Plus/Pro",
    hint: "Codex subscription — models appear as openai-codex/…",
  },
];

/** Provider sign-in metadata returned by omp's `get_login_providers` command. */
export interface LoginProvider {
  id: string;
  name: string;
  available: boolean;
  authenticated: boolean;
}

/** Resolve a successful, authoritative roster without introducing fallback rows. */
export function resolveOAuthProviderSpecs(
  providers: readonly LoginProvider[],
): OAuthProviderSpec[] {
  const firstById = new Map<string, LoginProvider>();
  for (const provider of providers) {
    if (!firstById.has(provider.id)) firstById.set(provider.id, provider);
  }

  const specs: OAuthProviderSpec[] = [];
  for (const spec of OAUTH_PROVIDER_SPECS) {
    const provider = firstById.get(spec.providerId);
    if (provider?.available === true) {
      const risk = oauthLoginRiskFromRosterName(provider.name);
      specs.push(risk ? { ...spec, riskWarningLogin: true } : spec);
    }
    firstById.delete(spec.providerId);
  }
  for (const provider of firstById.values()) {
    if (!provider.available) continue;
    const risk = oauthLoginRiskFromRosterName(provider.name);
    specs.push({
      id: provider.id,
      providerId: provider.id,
      label: risk
        ? provider.name.slice(0, -OAUTH_LOGIN_RISK_NAME_SUFFIX.length)
        : provider.name,
      hint: provider.id,
      ...(risk ? { riskWarningLogin: true } : {}),
    });
  }
  return specs;
}
