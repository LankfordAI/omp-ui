import {
  CH,
  parseSttSelector,
  readSttModels,
  resolveSttSelector,
  STT_ROUTES,
  type RequestHandlers,
  type Registry,
  type SttTranscribeRequest,
  type SttTranscribeResult,
} from "@omp-ui/core";

type SttHandlerChannels = typeof CH.readSttModels | typeof CH.transcribeAudio;

interface SttHandlerDependencies {
  registry: Registry;
  ompPath: string | null;
  /** Injected for tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

/** Upstream error bodies vary; dig out anything human-readable. */
function errorText(body: unknown): string | null {
  if (typeof body === "string" && body.trim() !== "") return body.trim();
  if (typeof body === "object" && body !== null) {
    const err = (body as { error?: unknown }).error;
    const message =
      typeof err === "string"
        ? err
        : typeof err === "object" && err !== null
          ? (err as { message?: unknown }).message
          : undefined;
    if (typeof message === "string" && message.trim() !== "") return message.trim();
  }
  return null;
}

export function registerSttHandlers(
  deps: SttHandlerDependencies,
): Pick<RequestHandlers, SttHandlerChannels> {
  const doFetch = deps.fetchImpl ?? fetch;

  /** The stored selector, or the preferred callable model when unset. */
  async function resolveModel(): Promise<string> {
    const stored = deps.registry.getSetting("sttModel");
    if (stored !== null) return stored;
    const snapshot = await readSttModels({ ompPath: deps.ompPath });
    const resolved = resolveSttSelector(snapshot.models);
    if (resolved === null) {
      throw new Error(
        snapshot.discovered
          ? "no callable dictation model — add a provider key in Settings → Providers first"
          : `could not discover a dictation model: ${snapshot.error ?? "unknown reason"}`,
      );
    }
    return resolved;
  }

  return {
    [CH.readSttModels]: () => readSttModels({ ompPath: deps.ompPath }),
    [CH.transcribeAudio]: async (req: SttTranscribeRequest): Promise<SttTranscribeResult> => {
      const model = await resolveModel();
      const route = parseSttSelector(model);
      if (route === null) throw new Error(`unsupported dictation model: ${model}`);
      const spec = STT_ROUTES[route.provider]!;
      const key = process.env[spec.env];
      if (key === undefined || key === "") {
        throw new Error(`no credential for ${route.provider} — add it in Settings → Providers`);
      }
      const form = new FormData();
      form.append("model", route.model);
      if (req.language !== null) form.append("language", req.language);
      form.append(
        "file",
        new Blob([Buffer.from(req.audioBase64, "base64")], { type: "audio/wav" }),
        "dictation.wav",
      );
      // Providers cap an STT request at 60 s upstream (OpenRouter docs); abort
      // just past that so the user gets a message, not a hung promise.
      const res = await doFetch(`${spec.base}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(65_000),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          `transcription failed (${res.status}): ${errorText(body) ?? "provider gave no reason"}`,
        );
      }
      const text = (body as { text?: unknown } | null)?.text;
      return { text: typeof text === "string" ? text.trim() : "" };
    },
  };
}
