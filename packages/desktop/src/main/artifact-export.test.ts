import { describe, expect, it } from "vitest";
import { sanitizeExportName } from "./artifact-export";

describe("sanitizeExportName", () => {
  it("strips path separators, control characters, and reserved punctuation from agent-authored titles", () => {
    expect(sanitizeExportName("../../etc/passwd")).toBe("etc passwd");
    expect(sanitizeExportName("evil\\name:with*reserved?chars\"<>|")).toBe("evil name with reserved chars");
    expect(sanitizeExportName("line\r\nbreak\ttabbell")).toBe("line break tab bell");
    expect(sanitizeExportName("   ")).toBe("artifact");
    expect(sanitizeExportName("".padStart(500, "x"))).toHaveLength(120);
    expect(sanitizeExportName("Quartély ✓ chart")).toBe("Quartély ✓ chart");
  });
});
