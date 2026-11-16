// The agent's theme host tool (issue #1168, ADR-0043): an agent saves an
// authored theme through the same gate the editor uses; it never applies one.
import { isObject } from "./guards";
import type { RpcHostToolDefinition } from "./host-bridge";
import { AUTHORED_THEME_ID_PREFIX, STORED_ID, THEME_SYNTAX_SEEDS } from "./theme";
import { BACKDROP_BLUR_MAX, BACKDROP_DIM_MAX } from "./theme-backdrop";
import { THEME_SEED_ACCENTS, type ThemeSeeds } from "./theme-seeds";

export const THEME_TOOL_NAME = "omp-ui_theme_save";

export type ThemeToolArgs = {
  label: string;
  seeds: ThemeSeeds;
  id?: string;
  backdrop?: { path: string; dim?: number; blur?: number };
};

const LABEL_MAX = 80;
const PATH_MAX = 4096;
const HEX_PATTERN = "^#[0-9a-fA-F]{6}$";
const HEX = new RegExp(HEX_PATTERN);

function colourSchema(keys: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(keys.map((key) => [key, { type: "string", pattern: HEX_PATTERN }])),
  };
}

export function themeTool(): RpcHostToolDefinition {
  return {
    name: THEME_TOOL_NAME,
    loadMode: "essential",
    description:
      "Save a custom omp-ui theme from a few seed colours; omp-ui derives the rest and refuses a theme whose text would be hard to read. canvas is the reading background and decides dark or light. accents.signal is the agent-activity colour and must be a green. Optional backdrop.path is a PNG, JPEG, WebP or SVG file inside this session's working directory, shown behind the app; dim (0-80) darkens it and blur (0-32) softens it. The theme is added to the user's themes and is not applied: tell the user to pick it in Settings, Appearance. Pass id to replace a theme you saved earlier. A refusal lists each failing colour pair with its ratio so you can adjust and call again.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["label", "seeds"],
      properties: {
        label: { type: "string", minLength: 1, maxLength: LABEL_MAX },
        seeds: {
          type: "object",
          additionalProperties: false,
          required: ["canvas"],
          properties: {
            canvas: { type: "string", pattern: HEX_PATTERN },
            ink: { type: "string", pattern: HEX_PATTERN },
            accents: colourSchema(THEME_SEED_ACCENTS),
            syntax: colourSchema(THEME_SYNTAX_SEEDS),
          },
        },
        id: { type: "string", pattern: "^custom-[a-z0-9]+(?:-[a-z0-9]+)*$" },
        backdrop: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: { type: "string", minLength: 1, maxLength: PATH_MAX },
            dim: { type: "integer", minimum: 0, maximum: BACKDROP_DIM_MAX },
            blur: { type: "integer", minimum: 0, maximum: BACKDROP_BLUR_MAX },
          },
        },
      },
    },
  };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The first key of `value` outside `keys`, named by its full field path. */
function unknownKey(value: Record<string, unknown>, keys: readonly string[], prefix: string): string | null {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  return extra === undefined ? null : `unknown field ${prefix}${extra}`;
}

function parseColours(value: unknown, keys: readonly string[], field: string): Parsed<Record<string, string>> {
  if (!isObject(value) || Array.isArray(value)) return { ok: false, reason: `${field} must be an object` };
  const extra = unknownKey(value, keys, `${field}.`);
  if (extra !== null) return { ok: false, reason: extra };
  for (const [key, colour] of Object.entries(value)) {
    if (typeof colour !== "string" || !HEX.test(colour)) return { ok: false, reason: `${field}.${key} must be #rrggbb` };
  }
  return { ok: true, value: value as Record<string, string> };
}

function parseSeeds(value: unknown): Parsed<ThemeSeeds> {
  if (!isObject(value) || Array.isArray(value)) return { ok: false, reason: "seeds must be an object" };
  const extra = unknownKey(value, ["canvas", "ink", "accents", "syntax"], "seeds.");
  if (extra !== null) return { ok: false, reason: extra };
  const { canvas, ink, accents, syntax } = value;
  if (typeof canvas !== "string" || !HEX.test(canvas)) return { ok: false, reason: "seeds.canvas must be #rrggbb" };
  const seeds: ThemeSeeds = { canvas };
  if (ink !== undefined) {
    if (typeof ink !== "string" || !HEX.test(ink)) return { ok: false, reason: "seeds.ink must be #rrggbb" };
    seeds.ink = ink;
  }
  if (accents !== undefined) {
    const parsed = parseColours(accents, THEME_SEED_ACCENTS, "seeds.accents");
    if (!parsed.ok) return parsed;
    seeds.accents = parsed.value;
  }
  if (syntax !== undefined) {
    const parsed = parseColours(syntax, THEME_SYNTAX_SEEDS, "seeds.syntax");
    if (!parsed.ok) return parsed;
    seeds.syntax = parsed.value;
  }
  return { ok: true, value: seeds };
}

function parseLevel(value: unknown, max: number, field: string): Parsed<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    return { ok: false, reason: `${field} must be an integer from 0 to ${max}` };
  }
  return { ok: true, value };
}

function parseBackdrop(value: unknown): Parsed<NonNullable<ThemeToolArgs["backdrop"]>> {
  if (!isObject(value) || Array.isArray(value)) return { ok: false, reason: "backdrop must be an object" };
  const extra = unknownKey(value, ["path", "dim", "blur"], "backdrop.");
  if (extra !== null) return { ok: false, reason: extra };
  const { path } = value;
  if (typeof path !== "string" || path.trim() === "" || path.length > PATH_MAX) {
    return { ok: false, reason: "backdrop.path must be a non-empty file path" };
  }
  const dim = parseLevel(value.dim, BACKDROP_DIM_MAX, "backdrop.dim");
  if (!dim.ok) return dim;
  const blur = parseLevel(value.blur, BACKDROP_BLUR_MAX, "backdrop.blur");
  if (!blur.ok) return blur;
  const backdrop: NonNullable<ThemeToolArgs["backdrop"]> = { path };
  if (dim.value !== undefined) backdrop.dim = dim.value;
  if (blur.value !== undefined) backdrop.blur = blur.value;
  return { ok: true, value: backdrop };
}

/** Validates the agent's arguments; a refusal is one line naming the field. */
export function parseThemeToolArgs(args: unknown): { ok: true; args: ThemeToolArgs } | { ok: false; reason: string } {
  if (!isObject(args) || Array.isArray(args)) return { ok: false, reason: "arguments must be an object" };
  const extra = unknownKey(args, ["label", "seeds", "id", "backdrop"], "");
  if (extra !== null) return { ok: false, reason: extra };
  const { label, id } = args;
  if (typeof label !== "string" || label.trim() === "" || label.trim().length > LABEL_MAX) {
    return { ok: false, reason: `label must be 1 to ${LABEL_MAX} characters` };
  }
  const seeds = parseSeeds(args.seeds);
  if (!seeds.ok) return seeds;
  const parsed: ThemeToolArgs = { label, seeds: seeds.value };
  if (id !== undefined) {
    if (typeof id !== "string" || !STORED_ID.test(id) || !id.startsWith(AUTHORED_THEME_ID_PREFIX)) {
      return { ok: false, reason: `id must be a ${AUTHORED_THEME_ID_PREFIX} theme id you saved earlier` };
    }
    parsed.id = id;
  }
  if (args.backdrop !== undefined) {
    const backdrop = parseBackdrop(args.backdrop);
    if (!backdrop.ok) return backdrop;
    parsed.backdrop = backdrop.value;
  }
  return { ok: true, args: parsed };
}
