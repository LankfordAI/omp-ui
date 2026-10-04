import { describe, expect, it } from "vitest";
import { CODE_REVIEW_COMMAND, CODE_REVIEW_TOOL } from "./review";

describe("wire constants", () => {
  it("namespace the tool but not the command", () => {
    expect(CODE_REVIEW_COMMAND).toBe("code-review");
    expect(CODE_REVIEW_TOOL).toBe("omp-ui_code_review");
  });
});
