import { describe, expect, it } from "vitest";
import {
  OAUTH_LOGIN_RISK_NAME_SUFFIX,
  isOmpRpcLoginBlockedError,
  oauthLoginRiskFromRosterName,
  resolveOAuthProviderSpecs,
  terminalLoginCommand,
  terminalLoginExplanation,
  PROVIDER_ENV_NAMES,
  PROVIDER_KEY_SPECS,
  providerSpecById,
  type LoginProvider,
} from "./provider-catalog";

describe("PROVIDER_KEY_SPECS", () => {
  it("gives every spec a distinct id", () => {
    const ids = PROVIDER_KEY_SPECS.map((spec) => spec.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it("never lets two specs share an environment variable", () => {
    // PROVIDER_ENV_NAMES is primary-then-alternates across every spec, so a
    // duplicate here means one env name authenticates two rows on the page.
    const dupes = PROVIDER_ENV_NAMES.filter((name, index) => PROVIDER_ENV_NAMES.indexOf(name) !== index);
    expect(dupes).toEqual([]);
  });

  it("resolves each spec by its own id and none by an unknown one", () => {
    for (const spec of PROVIDER_KEY_SPECS) {
      expect(providerSpecById(spec.id)).toBe(spec);
    }
    expect(providerSpecById("sambanova")).toBeUndefined();
  });
});

const roster = (id: string, name: string): LoginProvider => ({
  id,
  name,
  available: true,
  authenticated: false,
});

describe("login-risk providers (issue #1197)", () => {
  it("flags a discovered roster entry whose name carries omp's risk suffix", () => {
    // Names exactly as omp v18.18.7+ getOAuthProviders() reports them.
    const rows = resolveOAuthProviderSpecs([
      roster("google-antigravity", `Google Antigravity${OAUTH_LOGIN_RISK_NAME_SUFFIX}`),
      roster("anthropic", "Anthropic"),
    ]);
    const agy = rows.find((row) => row.providerId === "google-antigravity");
    expect(agy?.requiresTerminalLogin).toBe(true);
    // The suffix is omp's warning marker, not part of the product name.
    expect(agy?.label).toBe("Google Antigravity");
    expect(rows.find((row) => row.providerId === "anthropic")?.requiresTerminalLogin).toBeUndefined();
  });

  it("flags a curated spec whose roster entry carries the suffix", () => {
    const rows = resolveOAuthProviderSpecs([
      roster("openai-codex", `ChatGPT Plus/Pro${OAUTH_LOGIN_RISK_NAME_SUFFIX}`),
    ]);
    expect(rows[0]?.requiresTerminalLogin).toBe(true);
  });

  it("leaves an unmarked entry without the flag", () => {
    const rows = resolveOAuthProviderSpecs([roster("openai-codex", "ChatGPT Plus/Pro")]);
    expect(rows[0]).not.toHaveProperty("requiresTerminalLogin");
  });

  it("detects the risk marker only at the name's end", () => {
    expect(oauthLoginRiskFromRosterName(`X${OAUTH_LOGIN_RISK_NAME_SUFFIX}`)).toBe(true);
    expect(oauthLoginRiskFromRosterName(`X${OAUTH_LOGIN_RISK_NAME_SUFFIX} extra`)).toBe(false);
    expect(oauthLoginRiskFromRosterName("X (at your own risk!)")).toBe(false);
  });

  it("names the real terminal command", () => {
    // Verified against upstream commands/login.ts: `omp login <provider>`.
    expect(terminalLoginCommand("google-antigravity")).toBe("omp login google-antigravity");
    expect(terminalLoginExplanation("antigravity-cli")).toContain("omp login antigravity-cli");
  });

  it("maps omp's RPC login refusal to the terminal explanation", () => {
    // Both rpc-mode.ts refusals (pre-auth prompt, secret input) end on this tail.
    expect(
      isOmpRpcLoginBlockedError(
        "Provider 'google-antigravity' requires interactive prompts which are not supported in RPC mode. Use the terminal UI to log in.",
      ),
    ).toBe(true);
    expect(
      isOmpRpcLoginBlockedError(
        "Provider 'x' requires secret input, which is not supported in RPC mode. Use the terminal UI to log in.",
      ),
    ).toBe(true);
    expect(isOmpRpcLoginBlockedError("Unknown OAuth provider: nope")).toBe(false);
    expect(isOmpRpcLoginBlockedError("sign-in failed")).toBe(false);
  });
});
