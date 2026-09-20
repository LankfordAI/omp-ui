import { describe, expect, it } from "vitest";
import { composerPaintRuns } from "./composer-paint";

describe("composerPaintRuns", () => {
  it("paints resolved mentions without changing draft geometry", () => {
    const text = "inspect @src/app.ts now";
    const runs = composerPaintRuns(text, new Set(["src/app.ts"]), 0);
    expect(runs.map((run) => run.text).join("")).toBe(text);
    expect(runs.find((run) => run.iris)?.text).toBe("@src/app.ts");
  });

  it("preserves every keyword character as a colored run", () => {
    const text = "orchestrate this";
    const runs = composerPaintRuns(text, new Set(), 0);
    expect(runs.map((run) => run.text).join("")).toBe(text);
    expect(runs.filter((run) => run.color !== undefined).map((run) => run.text).join(""))
      .toBe("orchestrate");
  });
});
