import { describe, expect, it } from "vitest";
import { ALL_MAGIC_KEYWORDS } from "@omp-ui/core/magic-keywords";
import { composerPaintRuns } from "./composer-paint";

describe("composerPaintRuns", () => {
  it("paints resolved mentions without changing draft geometry", () => {
    const text = "inspect @src/app.ts now";
    const runs = composerPaintRuns(text, new Set(["src/app.ts"]), 0, ALL_MAGIC_KEYWORDS);
    expect(runs.map((run) => run.text).join("")).toBe(text);
    expect(runs.find((run) => run.iris)?.text).toBe("@src/app.ts");
  });

  it("preserves every keyword character as a colored run", () => {
    const text = "orchestrate this";
    const runs = composerPaintRuns(text, new Set(), 0, ALL_MAGIC_KEYWORDS);
    expect(runs.map((run) => run.text).join("")).toBe(text);
    expect(runs.filter((run) => run.color !== undefined).map((run) => run.text).join(""))
      .toBe("orchestrate");
  });

  it("paints a keyword missing from the firing set as a plain run", () => {
    const text = "orchestrate this";
    const runs = composerPaintRuns(text, new Set(), 0, new Set());
    expect(runs.map((run) => run.text).join("")).toBe(text);
    expect(runs.some((run) => run.color !== undefined)).toBe(false);
  });
});
