import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH, Registry, type SttTranscribeRequest } from "@omp-ui/core";
import { registerSttHandlers } from "./stt-handlers";

let base: string;
let registry: Registry;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-stt-"));
  registry = Registry.load(path.join(base, "registry.json"));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function handlers(fetchImpl: typeof fetch) {
  return registerSttHandlers({ registry, ompPath: "/bin/omp", fetchImpl });
}

const req: SttTranscribeRequest = { audioBase64: "AUIATABc", language: null };

describe("transcribeAudio", () => {
  it("posts the selector's bare model slug and the WAV as multipart", async () => {
    registry.setSetting("sttModel", "openrouter/openai/whisper-large-v3");
    process.env.OPENROUTER_API_KEY = "sk-or";
    try {
      const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
        expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
        const opts = init as { method: string; headers: Record<string, string>; body: FormData };
        expect(opts.method).toBe("POST");
        expect(opts.headers.Authorization).toBe("Bearer sk-or");
        // The endpoint names the model without the provider prefix.
        expect(opts.body.get("model")).toBe("openai/whisper-large-v3");
        expect(opts.body.get("language")).toBeNull();
        const file = opts.body.get("file");
        expect(file).toBeInstanceOf(Blob);
        expect((file as Blob).type).toBe("audio/wav");
        return new Response(JSON.stringify({ text: "  hello world  " }), { status: 200 });
      });
      await expect(handlers(fetchImpl as unknown as typeof fetch)[CH.transcribeAudio](req)).resolves.toEqual({
        text: "hello world",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("sends the language hint when given one", async () => {
    registry.setSetting("sttModel", "openai/whisper-1");
    process.env.OPENAI_API_KEY = "sk-oai";
    try {
      const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
        const body = (init as { body: FormData }).body;
        expect(body.get("model")).toBe("whisper-1");
        expect(body.get("language")).toBe("ko");
        return new Response(JSON.stringify({ text: "안녕" }), { status: 200 });
      });
      const result = await handlers(fetchImpl as unknown as typeof fetch)[CH.transcribeAudio]({
        audioBase64: "AUIATABc",
        language: "ko",
      });
      expect(result).toEqual({ text: "안녕" });
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("rejects an unroutable stored selector without calling out", async () => {
    registry.setSetting("sttModel", "local/whisper-base");
    const fetchImpl = vi.fn();
    await expect(
      handlers(fetchImpl as unknown as typeof fetch)[CH.transcribeAudio](req),
    ).rejects.toThrow(/unsupported dictation model: local\/whisper-base/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names the provider when its credential is missing", async () => {
    registry.setSetting("sttModel", "openrouter/openai/whisper-1");
    delete process.env.OPENROUTER_API_KEY;
    const fetchImpl = vi.fn();
    await expect(
      handlers(fetchImpl as unknown as typeof fetch)[CH.transcribeAudio](req),
    ).rejects.toThrow(/no credential for openrouter — add it in Settings → Providers/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces the provider status and reason verbatim", async () => {
    registry.setSetting("sttModel", "openrouter/openai/whisper-1");
    process.env.OPENROUTER_API_KEY = "sk-or";
    try {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), {
            status: 429,
          }),
      );
      await expect(
        handlers(fetchImpl as unknown as typeof fetch)[CH.transcribeAudio](req),
      ).rejects.toThrow("transcription failed (429): rate limit exceeded");
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("auto-resolves a null sttModel from the omp probe at call time", async () => {
    // Exercise the real catalog parsing without a Unix shell shim (Windows
    // cannot spawn a shebang script via execFile).
    const runOmp = async () => JSON.stringify({ models: [{ provider: "openrouter", kind: "stt", selector: "openrouter/openai/whisper-1", name: "Whisper 1" }] });
    process.env.OPENROUTER_API_KEY = "sk-or";
    try {
      const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
        const body = (init as { body: FormData }).body;
        expect(body.get("model")).toBe("openai/whisper-1");
        return new Response(JSON.stringify({ text: "resolved" }), { status: 200 });
      });
      const h = registerSttHandlers({ registry, ompPath: "omp", runOmp, fetchImpl: fetchImpl as unknown as typeof fetch });
      await expect(h[CH.transcribeAudio](req)).resolves.toEqual({ text: "resolved" });
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("rejects with the providers hint when nothing is callable", async () => {
    const runOmp = async () => JSON.stringify({ models: [] });
    const h = registerSttHandlers({ registry, ompPath: "omp", runOmp, fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(h[CH.transcribeAudio](req)).rejects.toThrow(/no callable dictation model/);
  });
});

describe("readSttModels handler", () => {
  it("passes the probe snapshot through", async () => {
    const runOmp = async () => JSON.stringify({ models: [
      { provider: "openrouter", kind: "stt", selector: "openrouter/openai/whisper-1", name: "Whisper 1" },
      { provider: "local", kind: "stt", selector: "local/whisper-base", name: "Whisper Base" },
    ] });
    const h = registerSttHandlers({ registry, ompPath: "omp", runOmp, fetchImpl: vi.fn() as unknown as typeof fetch });
    const snapshot = await h[CH.readSttModels]();
    expect(snapshot.discovered).toBe(true);
    expect(snapshot.models.map((m) => m.selector)).toEqual(["openrouter/openai/whisper-1"]);
  });

  it("reports a missing binary", async () => {
    const h = registerSttHandlers({ registry, ompPath: null, fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(h[CH.readSttModels]()).resolves.toEqual({
      models: [],
      discovered: false,
      error: "omp binary not found",
    });
  });
});
