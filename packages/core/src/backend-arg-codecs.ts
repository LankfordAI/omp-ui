import { isObject } from "./guards";
import { parseSpawnRequest } from "./spawn-request";
import type { RpcFrame } from "./rpc/codec";
import type {
  AgentMode,
  BranchListOptions,
  ConsoleProgram,
  ImageAttachment,
  McpSetEnabledRequest,
  OmpSettingValue,
  PlanFormat,
  ProjectOpenTarget,
  RemoteBind,
  SessionMode,
  SpawnRequest,
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
export const projectOpenTargetCodec: ArgCodec<ProjectOpenTarget> = oneOf(
  "vscode",
  "files",
  "terminal",
);
export const consoleProgramCodec: ArgCodec<ConsoleProgram> = oneOf("shell", "omp-tui");
export const remoteBindCodec: ArgCodec<RemoteBind> = oneOf("localhost", "lan");

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

export const branchListOptionsCodec: ArgCodec<BranchListOptions> = objectOf<BranchListOptions>({
  fetchUpstream: optional(bool()),
});

export const checkoutOptionsCodec: ArgCodec<{ create?: boolean }> = objectOf<{
  create?: boolean;
}>({
  create: optional(bool()),
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
