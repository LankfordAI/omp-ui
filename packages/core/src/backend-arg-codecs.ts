import { isObject } from "./guards";
import { parseSpawnRequest } from "./spawn-request";
import type { RpcFrame } from "./rpc/codec";
import type { BrowserPaneInputEvent, BrowserPaneNavigate } from "./browser-pane";
import type {
  AgentMode,
  BranchListOptions,
  ConsoleProgram,
  DiagnosticsExportRequest,
  GlassChrome,
  ImageAttachment,
  McpSetEnabledRequest,
  OmpSettingValue,
  PlanFormat,
  ProjectOpenTarget,
  RemoteBind,
  RemoteInstanceInput,
  RemoteInstancePatch,
  SessionMode,
  SpawnRequest,
  ScopedCapabilityMutation,
  TranscriptWidth,
  UpdateTrain,
  WorktreeReleaseOptions,
} from "./types";

export interface ArgCodec<T> {
  readonly expected: string;
  decode(value: unknown, path: string): T;
}

export type ArgCodecs<Args extends readonly unknown[]> = {
  [K in keyof Args]-?: ArgCodec<Args[K]>;
};

type CodecValue<Codec> = Codec extends ArgCodec<infer Value> ? Value : never;
type FieldCodecs = Readonly<Record<string, ArgCodec<unknown>>>;
type DecodedFields<Fields extends FieldCodecs> = {
  [Key in keyof Fields]: CodecValue<Fields[Key]>;
};

/** Reject objects carrying fields the shape does not name — no silent halves. */
function exactKeys(fields: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const name of Object.keys(fields)) {
    if (!keys.includes(name)) fail(`${path}.${name}`, `absent (known: ${keys.join(", ")})`);
  }
}
function fail(path: string, expected: string): never {
  throw new Error(`${path} must be ${expected}`);
}

function codec<T>(expected: string, accepts: (value: unknown) => boolean): ArgCodec<T> {
  return {
    expected,
    decode(value, path) {
      if (!accepts(value)) fail(path, expected);
      return value as T;
    },
  };
}

export function str(): ArgCodec<string> {
  return codec("a string", (value) => typeof value === "string");
}

/** A string of at most `max` UTF-16 units; the browser pane's text and URL bounds. */
function shortStr(max: number): ArgCodec<string> {
  return codec(`a string of at most ${max} characters`, (value) => typeof value === "string" && value.length <= max);
}

/** Accepts anything: the remote decodes proxied args with its own codecs. */
export function any(): ArgCodec<unknown> {
  return codec("any value", () => true);
}

export function num(): ArgCodec<number> {
  return codec("a finite number", (value) => typeof value === "number" && Number.isFinite(value));
}

export function bool(): ArgCodec<boolean> {
  return codec("a boolean", (value) => typeof value === "boolean");
}

export function nullable<T>(inner: ArgCodec<T>): ArgCodec<T | null> {
  return {
    expected: `${inner.expected} or null`,
    decode(value, path) {
      return value === null ? null : inner.decode(value, path);
    },
  };
}

export function optional<T>(inner: ArgCodec<T>): ArgCodec<T | undefined> {
  return {
    expected: `${inner.expected} or undefined`,
    decode(value, path) {
      return value === undefined ? undefined : inner.decode(value, path);
    },
  };
}

export function trailingOptional<T>(inner: ArgCodec<T>): ArgCodec<T | undefined> {
  return {
    expected: `${inner.expected}, null, or undefined`,
    decode(value, path) {
      return value === undefined || value === null ? undefined : inner.decode(value, path);
    },
  };
}

export function lit<const T extends string | number | boolean | null>(expectedValue: T): ArgCodec<T> {
  return codec(JSON.stringify(expectedValue), (value) => value === expectedValue);
}

export function oneOf<const Values extends readonly string[]>(
  ...values: Values
): ArgCodec<Values[number]> {
  return codec(values.map((value) => JSON.stringify(value)).join(" or "), (value) =>
    typeof value === "string" && values.includes(value as Values[number]),
  );
}

export function arrayOf<T>(inner: ArgCodec<T>): ArgCodec<T[]> {
  const expected = `an array of ${inner.expected}`;
  return {
    expected,
    decode(value, path) {
      if (!Array.isArray(value)) fail(path, expected);
      for (let index = 0; index < value.length; index += 1) {
        inner.decode(value[index], `${path}[${index}]`);
      }
      return value as T[];
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function objectOf<const Fields extends FieldCodecs>(
  fields: Fields,
): ArgCodec<DecodedFields<Fields>>;
export function objectOf<T extends object>(fields: {
  readonly [Key in keyof T]-?: ArgCodec<T[Key]>;
}): ArgCodec<T>;
export function objectOf(fields: FieldCodecs): ArgCodec<Record<string, unknown>> {
  const expected = "an object with the declared fields";
  const declaredKeys = Object.keys(fields);
  return {
    expected,
    decode(value, path) {
      if (!isPlainRecord(value)) fail(path, expected);
      if (Object.keys(value).some((key) => !declaredKeys.includes(key))) {
        fail(path, expected);
      }
      for (const key of declaredKeys) {
        const fieldValue = Object.hasOwn(value, key) ? value[key] : undefined;
        fields[key]!.decode(fieldValue, `${path}.${key}`);
      }
      return value;
    },
  };
}

export function record(): ArgCodec<Record<string, unknown>> {
  return codec("a plain object", isPlainRecord);
}

export const sessionModeCodec: ArgCodec<SessionMode> = oneOf("pty", "rpc-ui");
export const agentModeCodec: ArgCodec<AgentMode> = oneOf("plan", "build");
export const planFormatCodec: ArgCodec<PlanFormat> = oneOf("html", "md");
export const transcriptWidthCodec: ArgCodec<TranscriptWidth> = oneOf("comfortable", "wide", "full");
export const glassChromeCodec: ArgCodec<GlassChrome> = oneOf("off", "subtle", "frosted");
export const projectOpenTargetCodec: ArgCodec<ProjectOpenTarget> = oneOf(
  "vscode",
  "files",
  "terminal",
);
export const consoleProgramCodec: ArgCodec<ConsoleProgram> = oneOf("shell", "omp-tui");
export const remoteBindCodec: ArgCodec<RemoteBind> = oneOf("localhost", "lan");
export const updateTrainCodec: ArgCodec<UpdateTrain> = oneOf("stable", "nightly");

export const remoteInstanceSecretCodec: ArgCodec<RemoteInstanceInput["secret"]> = {
  expected: "a { kind: password | token, value } secret",
  decode(value, path) {
    return objectOf({ kind: oneOf("password", "token"), value: str() }).decode(value, path) as
      RemoteInstanceInput["secret"];
  },
};
export const remoteInstanceInputCodec: ArgCodec<RemoteInstanceInput> = objectOf<RemoteInstanceInput>({
  url: str(),
  nickname: str(),
  secret: remoteInstanceSecretCodec,
});
export const remoteInstancePatchCodec: ArgCodec<RemoteInstancePatch> = objectOf<RemoteInstancePatch>({
  nickname: optional(str()),
  url: optional(str()),
  secret: optional(remoteInstanceSecretCodec),
});

export const imageAttachmentCodec: ArgCodec<ImageAttachment> = objectOf<ImageAttachment>({
  type: lit("image"),
  data: str(),
  mimeType: str(),
});

export const mcpSetEnabledRequestCodec: ArgCodec<McpSetEnabledRequest> =
  objectOf<McpSetEnabledRequest>({
    projectCwd: nullable(str()),
    name: str(),
    sourcePath: optional(str()),
    enabled: bool(),
  });

export const diagnosticsExportRequestCodec: ArgCodec<DiagnosticsExportRequest> =
  objectOf<DiagnosticsExportRequest>({
    includeTranscripts: bool(),
    destinationPath: nullable(str()),
  });

export const branchListOptionsCodec: ArgCodec<BranchListOptions> = objectOf<BranchListOptions>({
  fetchUpstream: optional(bool()),
});

export const checkoutOptionsCodec: ArgCodec<{ create?: boolean }> = objectOf<{
  create?: boolean;
}>({
  create: optional(bool()),
});

export const worktreeReleaseOptionsCodec: ArgCodec<WorktreeReleaseOptions> =
  objectOf<WorktreeReleaseOptions>({
    keepBranch: bool(),
    mergedInto: nullable(str()),
    checkoutOnReturn: optional(nullable(str())),
  });

export const rpcFrameCodec: ArgCodec<RpcFrame> = record();

const stringArrayCodec = arrayOf(str());
const openRecordCodec = record();
export const ompSettingValueCodec: ArgCodec<OmpSettingValue> = {
  expected: "a boolean, finite number, string, string array, or plain object",
  decode(value, path) {
    if (typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number") return num().decode(value, path);
    if (Array.isArray(value)) return stringArrayCodec.decode(value, path);
    return openRecordCodec.decode(value, path);
  },
};

/**
 * The scoped capability mutation (issue #383), decoded as a strict discriminated
 * union: unknown fields are rejected, so a half-formed mutation can never be
 * silently half-applied — the capabilities.ts mutation-request rule, reused.
 */
export const scopedCapabilityMutationCodec: ArgCodec<ScopedCapabilityMutation> = {
  expected: "a scoped capability mutation",
  decode(value, path) {
    const fields = record().decode(value, path);
    const scopeCwd = nullable(str()).decode(fields["scopeCwd"], `${path}.scopeCwd`);
    const kind = oneOf("tool", "skill-ignore", "skill-gate").decode(fields["kind"], `${path}.kind`);
    if (kind === "tool") {
      exactKeys(fields, ["scopeCwd", "kind", "tool", "enabled"], path);
      return {
        scopeCwd,
        kind,
        tool: str().decode(fields["tool"], `${path}.tool`),
        enabled: bool().decode(fields["enabled"], `${path}.enabled`),
      };
    }
    if (kind === "skill-ignore") {
      exactKeys(fields, ["scopeCwd", "kind", "name", "ignored"], path);
      return {
        scopeCwd,
        kind,
        name: str().decode(fields["name"], `${path}.name`),
        ignored: bool().decode(fields["ignored"], `${path}.ignored`),
      };
    }
    exactKeys(fields, ["scopeCwd", "kind", "key", "enabled"], path);
    return {
      scopeCwd,
      kind,
      key: str().decode(fields["key"], `${path}.key`),
      enabled: bool().decode(fields["enabled"], `${path}.enabled`),
    };
  },
};

const browserPaneModifiersCodec = optional(
  arrayOf(oneOf("shift", "control", "alt", "meta", "capsLock", "isKeypad", "left", "middle", "right")),
);
const browserPaneMouseButtonCodec = optional(oneOf("left", "middle", "right"));
/** Finite and within the viewport bound; input beyond it is a malformed tuple, not a clamp. */
const paneCoord: ArgCodec<number> = codec(
  "a pane coordinate",
  (value) => typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 8192,
);

/**
 * Renderer input into the browser pane (#529): Electron's sendInputEvent
 * unions plus insertText and the edit verbs, decoded strictly per arm so a
 * half-formed event is rejected, never partially dispatched.
 */
export const browserPaneInputCodec: ArgCodec<BrowserPaneInputEvent> = {
  expected: "a browser pane input event",
  decode(value, path) {
    const fields = record().decode(value, path);
    const type = oneOf(
      "mouseDown",
      "mouseUp",
      "mouseMove",
      "mouseLeave",
      "mouseWheel",
      "keyDown",
      "keyUp",
      "char",
      "insertText",
      "edit",
    ).decode(fields["type"], `${path}.type`);
    switch (type) {
      case "mouseDown":
      case "mouseUp":
      case "mouseMove":
      case "mouseLeave":
        exactKeys(fields, ["type", "x", "y", "button", "clickCount", "modifiers"], path);
        return {
          type,
          x: paneCoord.decode(fields["x"], `${path}.x`),
          y: paneCoord.decode(fields["y"], `${path}.y`),
          button: browserPaneMouseButtonCodec.decode(fields["button"], `${path}.button`),
          clickCount: optional(num()).decode(fields["clickCount"], `${path}.clickCount`),
          modifiers: browserPaneModifiersCodec.decode(fields["modifiers"], `${path}.modifiers`),
        };
      case "mouseWheel":
        exactKeys(
          fields,
          ["type", "x", "y", "deltaX", "deltaY", "hasPreciseScrollingDeltas", "modifiers"],
          path,
        );
        return {
          type,
          x: paneCoord.decode(fields["x"], `${path}.x`),
          y: paneCoord.decode(fields["y"], `${path}.y`),
          deltaX: num().decode(fields["deltaX"], `${path}.deltaX`),
          deltaY: num().decode(fields["deltaY"], `${path}.deltaY`),
          hasPreciseScrollingDeltas: bool().decode(
            fields["hasPreciseScrollingDeltas"],
            `${path}.hasPreciseScrollingDeltas`,
          ),
          modifiers: browserPaneModifiersCodec.decode(fields["modifiers"], `${path}.modifiers`),
        };
      case "keyDown":
      case "keyUp":
      case "char":
        exactKeys(fields, ["type", "keyCode", "modifiers"], path);
        return {
          type,
          keyCode: shortStr(64).decode(fields["keyCode"], `${path}.keyCode`),
          modifiers: browserPaneModifiersCodec.decode(fields["modifiers"], `${path}.modifiers`),
        };
      case "insertText":
        exactKeys(fields, ["type", "text"], path);
        return { type, text: shortStr(16_384).decode(fields["text"], `${path}.text`) };
      case "edit":
        exactKeys(fields, ["type", "command"], path);
        return {
          type,
          command: oneOf("selectAll", "copy", "paste", "cut", "undo", "redo").decode(
            fields["command"],
            `${path}.command`,
          ),
        };
    }
  },
};

export const browserPaneNavigateCodec: ArgCodec<BrowserPaneNavigate> = {
  expected: "a browser pane navigation",
  decode(value, path) {
    const fields = record().decode(value, path);
    const action = oneOf("goto", "back", "forward", "reload", "stop").decode(
      fields["action"],
      `${path}.action`,
    );
    if (action === "goto") {
      exactKeys(fields, ["action", "url"], path);
      return { action, url: shortStr(8_192).decode(fields["url"], `${path}.url`) };
    }
    exactKeys(fields, ["action"], path);
    return { action };
  },
};

export const spawnRequestCodec: ArgCodec<SpawnRequest> = {
  expected: "a valid spawn request",
  decode(value, path) {
    try {
      return parseSpawnRequest(value);
    } catch {
      return fail(path, this.expected);
    }
  },
};
