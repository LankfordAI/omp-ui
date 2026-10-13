import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRIVATE_DISABLED_TOOLS,
  privateGuardArmMessage,
  privateGuardExtensionPath,
  writePrivateGuardExtension,
} from "./private-guard-extension";
import { transpileGeneratedExtension, typecheckGeneratedExtension } from "./generated-extension-test-utils";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-private-guard-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface ExtensionApi {
  pi?: { AgentSession?: { prototype?: Record<string, unknown> } };
  registerCommand: (
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: { ui: { notify: (m: string, l?: string) => void } }) => Promise<void>;
    },
  ) => void;
}

type ExtensionFactory = (api: ExtensionApi) => void;

async function loadExtension(): Promise<ExtensionFactory> {
  const file = writePrivateGuardExtension(tempLineage());
  const outputText = transpileGeneratedExtension(fs.readFileSync(file, "utf8"), "esm");
  const js = file.replace(/\.ts$/, ".mjs");
  fs.writeFileSync(js, outputText, "utf8");
  const mod: unknown = await import(pathToFileURL(js).href);
  if (!mod || typeof mod !== "object" || !("default" in mod) || typeof mod.default !== "function") {
    throw new Error("generated extension has no default export");
  }
  return mod.default as ExtensionFactory;
}

interface Harness {
  run: () => Promise<void>;
  /** The enabled roster after every apply. */
  tools: () => string[];
  /** Every presentation-setter apply: [enabled, mounted, force]. */
  applies: Array<[string[], string[], boolean]>;
  /** Every by-name apply. */
  byName: string[][];
  notices: string[];
}

/**
 * All six memory tools enabled, plus ordinary tools; the presentation setter
 * is the apply path unless `presentation: false`. A fresh class per harness:
 * the extension patches the prototype's prompt.
 */
function harness(
  factory: ExtensionFactory,
  options?: {
    presentation?: boolean;
    byName?: boolean;
    /** Roster to report; defaults to the six memory tools plus read. */
    enabled?: string[];
    mounted?: string[];
  },
): Harness {
  let tools = options?.enabled ?? [
    "read",
    "memory_edit",
    "retain",
    "learn",
    "manage_skill",
    "recall",
    "reflect",
  ];
  const applies: Array<[string[], string[], boolean]> = [];
  const byName: string[][] = [];
  const notices: string[] = [];
  let handler: ((args: string, ctx: { ui: { notify: (m: string, l?: string) => void } }) => Promise<void>) | null = null;

  class FakeSession {
    getEnabledToolNames(): string[] {
      return [...tools];
    }
    getMountedXdevToolNames(): string[] {
      return options?.mounted ?? [];
    }
    prompt(): Promise<boolean> {
      return Promise.resolve(true);
    }
  }
  const proto = FakeSession.prototype as unknown as Record<string, unknown>;
  if (options?.presentation !== false && options?.byName !== true) {
    proto.setActiveToolPresentation = (
      enabled: string[],
      mounted: string[],
      force?: boolean,
    ): void => {
      applies.push([[...enabled], [...mounted], force === true]);
      tools = [...enabled];
    };
  }
  if (options?.byName === true) {
    proto.setActiveToolsByName = async (names: string[]): Promise<void> => {
      byName.push([...names]);
      tools = [...names];
    };
  }
  if (options?.presentation === false && options?.byName !== true) {
    delete proto.getMountedXdevToolNames;
  }

  factory({
    pi: { AgentSession: { prototype: proto } },
    registerCommand: (_name, opts) => {
      handler = opts.handler;
    },
  });

  // The arming command binds the root through the prompt wrapper, so prompt
  // once before the first arm, exactly like the spawner's initialCommands.
  void new FakeSession().prompt();

  return {
    run: () => {
      if (handler === null) throw new Error("the extension registered no command");
      return handler("", { ui: { notify: (m: string) => notices.push(m) } });
    },
    tools: () => [...tools],
    applies,
    byName,
    notices,
  };
}

describe("writePrivateGuardExtension", () => {
  it("writes the extension into the lineage dir, creating it when absent", () => {
    const lineage = path.join(tempLineage(), "nested");
    const file = writePrivateGuardExtension(lineage);
    expect(file).toBe(privateGuardExtensionPath(lineage));
    expect(fs.existsSync(file)).toBe(true);
  });

  it("is rewritten on every spawn, so a stale build cannot outvote the contract", () => {
    const lineage = tempLineage();
    const file = writePrivateGuardExtension(lineage);
    fs.writeFileSync(file, "// stale from an older omp-ui\n", "utf8");
    writePrivateGuardExtension(lineage);
    expect(fs.readFileSync(file, "utf8")).toContain(JSON.stringify([...PRIVATE_DISABLED_TOOLS]));
  });

  it("names exactly the four write tools and the arm command", () => {
    const source = fs.readFileSync(writePrivateGuardExtension(tempLineage()), "utf8");
    expect(source).toContain(JSON.stringify(privateGuardArmMessage().slice(1)));
    expect(source).toContain('"memory_edit"');
    expect(source).toContain('"retain"');
    expect(source).toContain('"learn"');
    expect(source).toContain('"manage_skill"');
    // The read tools must never appear in the removal list.
    expect(source).not.toContain('"recall"');
    expect(source).not.toContain('"reflect"');
  });

  it("typechecks as the exact generated file omp will load", () => {
    typecheckGeneratedExtension(writePrivateGuardExtension(tempLineage()));
  });
});

describe("the private guard arm", () => {
  it("removes exactly the four write tools and keeps recall/reflect", async () => {
    const h = harness(await loadExtension());
    await h.run();
    expect(h.tools().sort()).toEqual(["read", "recall", "reflect"]);
    expect(h.applies).toHaveLength(1);
  });

  it("hands the presentation setter the mounted intersection and force", async () => {
    const h = harness(await loadExtension(), { mounted: ["xd://memory_edit", "recall"] });
    await h.run();
    expect(h.applies).toHaveLength(1);
    const [enabled, mounted, force] = h.applies[0];
    expect(mounted).toEqual(["recall"]);
    expect(force).toBe(true);
    expect(enabled).not.toContain("memory_edit");
  });

  it("takes the by-name ladder on an omp without the presentation setter", async () => {
    const h = harness(await loadExtension(), { byName: true });
    await h.run();
    expect(h.byName).toHaveLength(1);
    expect(h.tools().sort()).toEqual(["read", "recall", "reflect"]);
    expect(h.applies).toHaveLength(0);
  });

  it("skips absent tools without a throw and stays silent when nothing changed", async () => {
    const h = harness(await loadExtension(), { enabled: ["read", "retain"] });
    await h.run();
    expect(h.tools()).toEqual(["read"]);
    expect(h.notices).toEqual([]);
    // A second arm on an already-quiet roster applies nothing.
    await h.run();
    expect(h.applies).toHaveLength(1);
  });

  it("reports an omp with no apply path once, without throwing", async () => {
    const h = harness(await loadExtension(), { presentation: false, byName: false });
    await expect(h.run()).resolves.toBeUndefined();
    expect(h.notices).toHaveLength(1);
    await h.run();
    expect(h.notices).toHaveLength(1);
  });

  it("reports a roster-less session once, without throwing", async () => {
    const factory = await loadExtension();
    let handler: ((args: string, ctx: { ui: { notify: (m: string, l?: string) => void } }) => Promise<void>) | null = null;
    factory({
      pi: {},
      registerCommand: (_name, opts) => {
        handler = opts.handler;
      },
    });
    const notices: string[] = [];
    // No prompt ever ran: the root is unbound.
    await handler!("", { ui: { notify: (m: string) => notices.push(m) } });
    await handler!("", { ui: { notify: (m: string) => notices.push(m) } });
    expect(notices).toHaveLength(1);
  });
});
