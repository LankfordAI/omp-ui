import { describe, expect, it } from "vitest";
import { slashCompletion } from "./slash-completion";
import type { SlashCommandInfo } from "./rpc-types";

const GOAL: SlashCommandInfo = {
  name: "goal",
  description: "goal — one objective this session works toward on its own",
  source: "omp-ui",
  input: { hint: "[objective]" },
  subcommands: [
    { name: "set", description: "set or replace the goal", usage: "<objective>" },
    { name: "show", description: "show the goal, its budget and what it has spent" },
    { name: "pause", description: "pause the goal" },
    { name: "resume", description: "resume the goal" },
    { name: "drop", description: "drop the goal" },
    { name: "budget", description: "set the token budget", usage: "<N|off>" },
  ],
};

const MEMORY: SlashCommandInfo = {
  name: "memory",
  description: "manage memory",
  aliases: ["mem"],
  subcommands: [
    { name: "view", description: "view the memory files" },
    { name: "mm list", description: "list memories" },
    { name: "mm show", description: "show one memory" },
  ],
};

const MODEL: SlashCommandInfo = {
  name: "model",
  description: "switch model",
  input: { hint: "[id]" },
};

const COMMANDS: SlashCommandInfo[] = [GOAL, MEMORY, MODEL];

/** The offered subcommand names for a draft, in palette order ([] when there is no offer). */
function names(text: string): string[] {
  const completion = slashCompletion(text, COMMANDS);
  return completion === null || completion.stage !== "subcommand"
    ? []
    : completion.matches.map((m) => m.subcommand.name);
}

describe("slashCompletion stage one", () => {
  it("reports the command word while it is still being typed", () => {
    expect(slashCompletion("/goa", COMMANDS)).toEqual({ stage: "command", needle: "goa" });
    expect(slashCompletion("/", COMMANDS)).toEqual({ stage: "command", needle: "" });
  });

  it("offers nothing for a non-slash draft", () => {
    expect(slashCompletion("hello /goal", COMMANDS)).toBeNull();
    expect(slashCompletion("", COMMANDS)).toBeNull();
  });
});

describe("slashCompletion stage two", () => {
  it("lists every subcommand of the word, in advertised order, at the bare space", () => {
    const completion = slashCompletion("/goal ", COMMANDS);
    expect(completion?.stage).toBe("subcommand");
    expect(names("/goal ")).toEqual(["set", "show", "pause", "resume", "drop", "budget"]);
  });

  it("filters by fuzzy name match, needle spaces included", () => {
    // `set` and `show` start with s; `resume` and `pause` contain it — the
    // subsequence hazard the design accepts (see `/goal do` → `drop`).
    expect(names("/goal s")).toEqual(["set", "show", "resume", "pause"]);
    expect(names("/memory mm l")).toEqual(["mm list"]);
  });

  it("hides when the argument matches no name", () => {
    expect(slashCompletion("/goal finish the migration", COMMANDS)).toBeNull();
    expect(slashCompletion("/goal fix", COMMANDS)).toBeNull();
  });

  it("matches names only, never descriptions", () => {
    // "spent" appears in `show`'s description but in no name.
    expect(slashCompletion("/goal spent", COMMANDS)).toBeNull();
  });

  it("hides for a word that names no command with subcommands", () => {
    expect(slashCompletion("/model gpt", COMMANDS)).toBeNull();
    expect(slashCompletion("/nope ", COMMANDS)).toBeNull();
    expect(slashCompletion("/ goal", COMMANDS)).toBeNull();
  });

  it("resolves aliases exactly", () => {
    expect(names("/mem v")).toEqual(["view"]);
  });
});
