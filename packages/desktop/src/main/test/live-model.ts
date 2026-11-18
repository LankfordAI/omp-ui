import * as fs from "node:fs";
import * as path from "node:path";

/** RPC-only proofs need a model to boot, but must never call a real provider. */
export function writeInertLiveModel(home: string): string {
  const agent = path.join(home, ".omp", "agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "config.yml"), "startup:\n  checkUpdate: false\nretry:\n  enabled: false\n");
  fs.writeFileSync(path.join(agent, "models.yml"), `providers:
  probe:
    baseUrl: http://127.0.0.1:1/v1
    api: openai-completions
    apiKey: none
    models:
      - id: inert
        name: inert
        contextWindow: 131072
        maxTokens: 128
        reasoning: false
`);
  return "probe/inert";
}
