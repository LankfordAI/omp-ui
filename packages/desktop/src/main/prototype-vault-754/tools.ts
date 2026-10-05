// PROTOTYPE (#754): throwaway.
import { hostToolsDefinition, type RpcHostToolDefinition } from "@omp-ui/core";
import { readProto754Control, type Proto754Control } from "./control";
import { readNote, searchVault, writeNote, type VaultResult } from "./vault-fs";

export const PROTO754_TOOL_PREFIX = "omp-ui_vault_";

const KNOWN_ARGS: Record<string, readonly string[]> = {
  omp_ui_vault_search: ["query", "limit"],
  omp_ui_vault_read: ["path"],
  omp_ui_vault_write: ["mode", "title", "content", "tags"],
};

/** The exact §5.3 definitions; discoverable omits `loadMode` so the wire matches omp's default. */
export function proto754ToolDefinitions(control: Proto754Control): Array<RpcHostToolDefinition & { loadMode?: "essential" }> {
  const loadMode = control.loadMode === "essential" ? { loadMode: "essential" as const } : {};
  return [
    {
      name: "omp-ui_vault_search",
      description:
        "Search the user's Obsidian knowledge vault by note title and text; returns vault-relative paths and matching lines. Search before writing a note, and to find the user's notes to link.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Words to find; a note matches when every word appears in its title or body (case-insensitive).",
          },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Most notes to return; default 10." },
        },
        required: ["query"],
      },
      ...loadMode,
    },
    {
      name: "omp-ui_vault_read",
      description:
        "Read one note from the user's Obsidian knowledge vault by vault-relative path or by title; returns the whole markdown note, frontmatter included.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Vault-relative path such as "omp-ui/Plan Mode Guard.md" (.md optional), or a bare note title.',
          },
        },
        required: ["path"],
      },
      ...loadMode,
    },
    {
      name: "omp-ui_vault_write",
      description:
        "Create or append to a note in the omp-ui/ folder of the user's Obsidian knowledge vault; omp-ui stamps provenance frontmatter and links the note from the project's index note.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["create", "append"] },
          title: {
            type: "string",
            description: "Note title, which becomes the file name: omp-ui/<title>.md. No slashes.",
          },
          content: {
            type: "string",
            description: "Markdown body without frontmatter. On append, the text added at the end.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags such as decision, lesson, write-up.",
          },
        },
        required: ["mode", "title", "content"],
      },
      ...loadMode,
    },
  ];
}

/** The registration command with the vault tools appended; null when the gate is off. */
export function proto754HostToolsCommand(): object | null {
  const control = readProto754Control();
  if (control === null) return null;
  return {
    id: "omp-ui-host-tools-1",
    type: "set_host_tools",
    tools: [...hostToolsDefinition(), ...proto754ToolDefinitions(control)],
  };
}

export interface Proto754Result {
  result: {
    content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
    details: Record<string, unknown>;
  };
  isError?: true;
}

export interface Proto754Answerer {
  /** True only when the control file reads and the name carries the vault prefix. */
  handles(toolName: string): boolean;
  answer(tabId: string, toolName: string, args: unknown, planEnabled: boolean): Promise<Proto754Result>;
}

export function createProto754Answerer(deps: {
  context: (tabId: string) => { project: string; session: string } | null;
  appVersion: string;
  log: (line: string) => void;
}): Proto754Answerer {
  return {
    handles: (toolName) => toolName.startsWith(PROTO754_TOOL_PREFIX) && readProto754Control() !== null,
    async answer(tabId, toolName, args, planEnabled) {
      const started = performance.now();
      const control = readProto754Control();
      const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
      const known = KNOWN_ARGS[toolName.replace(/-/g, "_")] ?? [];
      const extraArgs = Object.keys(record).filter((key) => !known.includes(key));
      let out: Proto754Result;
      try {
        if (control === null) throw new Error("the vault prototype control file is unreadable");
        let vault: VaultResult;
        if (toolName === "omp-ui_vault_search") {
          vault = await searchVault(control, record.query, record.limit);
        } else if (toolName === "omp-ui_vault_read") {
          vault = await readNote(control, record.path);
        } else if (toolName === "omp-ui_vault_write") {
          const ctx = deps.context(tabId) ?? { project: "unknown", session: `tab-${tabId}` };
          vault = await writeNote(control, { ...ctx, appVersion: deps.appVersion, planEnabled }, record);
        } else {
          throw new Error(`unknown host tool "${toolName}"`);
        }
        const content: Proto754Result["result"]["content"] = [{ type: "text", text: vault.text }];
        if (vault.image !== undefined) {
          content.push({ type: "image", data: vault.image.data, mimeType: vault.image.mimeType });
        }
        out = { result: { content, details: { ...vault.details, extraArgs } } };
        if (!vault.ok) out.isError = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        out = { result: { content: [{ type: "text", text: message }], details: { extraArgs } }, isError: true };
      }
      const textChars = out.result.content.reduce((n, c) => n + (c.type === "text" ? c.text.length : 0), 0);
      const imageBytes = out.result.content.reduce(
        (n, c) => n + (c.type === "image" ? Buffer.from(c.data, "base64").length : 0),
        0,
      );
      deps.log(
        `proto754 ${JSON.stringify({
          tool: toolName,
          tabId,
          ms: Math.round(performance.now() - started),
          argsBytes: Buffer.byteLength(JSON.stringify(args ?? null), "utf8"),
          resultTextChars: textChars,
          imageBytes,
          isError: out.isError === true,
          planEnabled,
          loadMode: control?.loadMode ?? null,
          extraArgs,
        })}`,
      );
      return out;
    },
  };
}
