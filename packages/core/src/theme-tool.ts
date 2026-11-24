// The agent's theme host tools (issue #1168, ADR-0043): an agent saves an
// authored theme through the same gate the editor uses, and with the user's
// yes (#1169) can apply the theme it just saved. Issue #1175 adds the read
// (theme_list) and the activation of any existing theme (theme_set); removal
// stays human-only per ADR-0094's amendment.
import { isObject } from "./guards";
import type { RpcHostToolDefinition } from "./host-bridge";
import { AUTHORED_THEME_ID_PREFIX, STORED_ID, THEME_SYNTAX_SEEDS, type ThemeMode } from "./theme";
import { BACKDROP_BLUR_MAX } from "./theme-backdrop";
import { THEME_SEED_ACCENTS, type ThemeSeeds } from "./theme-seeds";

export const THEME_TOOL_NAME = "omp-ui_theme_save";
export const THEME_LIST_TOOL_NAME = "omp-ui_theme_list";
export const THEME_SET_TOOL_NAME = "omp-ui_theme_set";

export type ThemeToolArgs = {
  label: string;
  seeds: ThemeSeeds;
  id?: string;
  backdrop?: { path: string; blur?: number };
  /** Paint the saved theme now; only meaningful after the user agreed in chat (#1169). */
  apply?: boolean;
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
      "Save a custom omp-ui theme from a few seed colours; omp-ui derives the rest and refuses a theme whose text would be hard to read. canvas is the reading background and decides dark or light. accents.signal is the agent-activity colour and must be a green. Optional backdrop.path is a PNG, JPEG, WebP or SVG file (up to 4 MiB), or an MP4 or WebM video loop (up to 16 MiB), inside this session's working directory, shown behind the app, shown as-is with no dimming; blur (0-32) softens it. By default the theme is saved and not applied. When the user asked for the theme or its application, act directly. Only when you propose a theme yourself, call your question tool first and pass apply:true on their yes. Applying switches the user's theme (and the system pick matching its lightness) for every connected client. Pass id to replace a theme you saved earlier. A refusal lists each failing colour pair with its ratio so you can adjust and call again.",
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
            blur: { type: "integer", minimum: 0, maximum: BACKDROP_BLUR_MAX },
          },
        },
        apply: { type: "boolean" },
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
  const extra = unknownKey(value, ["path", "blur"], "backdrop.");
  if (extra !== null) return { ok: false, reason: extra };
  const { path } = value;
  if (typeof path !== "string" || path.trim() === "" || path.length > PATH_MAX) {
    return { ok: false, reason: "backdrop.path must be a non-empty file path" };
  }
  const blur = parseLevel(value.blur, BACKDROP_BLUR_MAX, "backdrop.blur");
  if (!blur.ok) return blur;
  const backdrop: NonNullable<ThemeToolArgs["backdrop"]> = { path };
  if (blur.value !== undefined) backdrop.blur = blur.value;
  return { ok: true, value: backdrop };
}

/** Validates the agent's arguments; a refusal is one line naming the field. */
export function parseThemeToolArgs(args: unknown): { ok: true; args: ThemeToolArgs } | { ok: false; reason: string } {
  if (!isObject(args) || Array.isArray(args)) return { ok: false, reason: "arguments must be an object" };
  const extra = unknownKey(args, ["label", "seeds", "id", "backdrop", "apply"], "");
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
  if (args.apply !== undefined) {
    if (typeof args.apply !== "boolean") return { ok: false, reason: "apply must be a boolean" };
    parsed.apply = args.apply;
  }
  return { ok: true, args: parsed };
}

/* ------------------------------------------------- list / set (issue #1175) */

/** Which preference slot one write targeted. */
export type ThemeWriteSlot = "themeId" | "darkThemeId" | "lightThemeId";

/** The outcome of painting one theme id into the user's preference. */
export interface ThemeApplyResult {
  slot: ThemeWriteSlot;
  /** True when the theme written is the one this host's windows paint now. */
  painting: boolean;
}

/** Everything the theme tools answer with: the current appearance and every theme. */
export interface ThemeList {
  mode: ThemeMode;
  /** The label of the theme actually painted, resolved under the OS scheme. */
  effectiveLabel: string;
  /** The host OS scheme, from nativeTheme.shouldUseDarkColors. */
  scheme: "light" | "dark";
  motion: boolean;
  slots: { themeId: string | null; lightThemeId: string; darkThemeId: string };
  themes: Array<{ id: string; label: string; dark: boolean; backdrop: boolean }>;
}

/** The theme_set answer: the write plus a fresh list, for an honest reply. */
export type ThemeSetOutcome =
  | { ok: true; wrote: ThemeWriteSlot[]; modeChanged: boolean; motion: boolean | null; list: ThemeList }
  | { ok: false; reason: string };

/** The agent's theme_set arguments (#1175); every field optional, never all absent. */
export type ThemeSetArgs = {
  id?: string;
  slot?: "auto" | "light" | "dark";
  mode?: ThemeMode;
  motion?: boolean;
};

const SET_ID_MAX = 96;

/** The curated or stored theme to activate, the slot to write, the mode, the motion. */
export function themeSetTool(): RpcHostToolDefinition {
  return {
    name: THEME_SET_TOOL_NAME,
    loadMode: "essential",
    description:
      "Activates an existing omp-ui theme by id (list them first with omp-ui_theme_list); refuses an unknown id by listing the valid ones instead of writing it. In fixed mode the theme becomes the app's one theme and needs no slot; in system mode pass slot \"light\" or \"dark\" to write that system pick, or leave slot at its default \"auto\" to write the pick matching the theme's canvas lightness. May also set mode (\"fixed\" or \"system\") and motion (the backdrop animation toggle) in the same call, applied atomically. Refuses slot while the effective mode is fixed. Answers name the slot written and the theme this host actually paints: in system mode a theme whose lightness mismatches the OS scheme is stored but not shown until the OS flips or you pass mode:\"fixed\". Act on the user's own request directly; call your question tool first only when you propose the change yourself.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1, maxLength: SET_ID_MAX },
        slot: { type: "string", enum: ["auto", "light", "dark"] },
        mode: { type: "string", enum: ["fixed", "system"] },
        motion: { type: "boolean" },
      },
    },
  };
}

/** The agent's read of the current appearance and every theme (#1175). */
export function themeListTool(): RpcHostToolDefinition {
  return {
    name: THEME_LIST_TOOL_NAME,
    loadMode: "essential",
    description:
      "Lists the app's appearance: the theme mode, each slot's id and label, the theme now showing, backdrop motion, then every curated and stored theme as id — label (dark|light[, backdrop]). Read-only; call it before omp-ui_theme_set to learn which ids exist.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
  };
}

/** Validates theme_set arguments; a refusal is one line naming the field. */
export function parseThemeSetArgs(args: unknown): { ok: true; args: ThemeSetArgs } | { ok: false; reason: string } {
  if (!isObject(args) || Array.isArray(args)) return { ok: false, reason: "arguments must be an object" };
  const extra = unknownKey(args, ["id", "slot", "mode", "motion"], "");
  if (extra !== null) return { ok: false, reason: extra };
  const { id, slot, mode, motion } = args;
  const parsed: ThemeSetArgs = {};
  if (id !== undefined) {
    if (typeof id !== "string" || id.trim() === "" || id.length > SET_ID_MAX) {
      return { ok: false, reason: `id must be a theme id of 1 to ${SET_ID_MAX} characters` };
    }
    parsed.id = id;
  }
  if (slot !== undefined) {
    if (slot !== "auto" && slot !== "light" && slot !== "dark") {
      return { ok: false, reason: 'slot must be "auto", "light" or "dark"' };
    }
    parsed.slot = slot;
  }
  if (mode !== undefined) {
    if (mode !== "fixed" && mode !== "system") return { ok: false, reason: 'mode must be "fixed" or "system"' };
    parsed.mode = mode;
  }
  if (motion !== undefined) {
    if (typeof motion !== "boolean") return { ok: false, reason: "motion must be a boolean" };
    parsed.motion = motion;
  }
  // slot picks which system pick an id lands in; with no id there is nothing to place.
  if (parsed.slot !== undefined && parsed.id === undefined) return { ok: false, reason: "slot needs id" };
  if (parsed.id === undefined && parsed.mode === undefined && parsed.motion === undefined) {
    return { ok: false, reason: "pass at least one of id, slot, mode, motion" };
  }
  return { ok: true, args: parsed };
}
