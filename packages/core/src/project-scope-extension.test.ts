import { describe, expect, it } from "vitest";
import { PROJECT_SCOPE_TEXT_MAX, projectScopeGuidance, type ProjectScopeRole } from "./project-scope-extension";

const base = { projectName: "scope-a", projectCwd: "/repos/scope-a", checkoutPath: "/repos/scope-a" };
const guidance = (role: ProjectScopeRole, over: Partial<typeof base> = {}): string =>
  projectScopeGuidance({ ...base, ...over, role });

describe("projectScopeGuidance (#1226)", () => {
  it("dispatch text names the project, both fleet tools, and planMode true", () => {
    const text = guidance("dispatch");
    expect(text).toContain('the project "scope-a" at /repos/scope-a.');
    expect(text).toContain("omp-ui_fleet_machines");
    expect(text).toContain("omp-ui_fleet_dispatch");
    expect(text).toContain("planMode true");
    expect(text).not.toContain("working in the checkout");
  });

  it("names the worktree checkout when it differs from the project", () => {
    expect(guidance("dispatch", { checkoutPath: "/wt/scope-a-x" })).toContain(
      'the project "scope-a" at /repos/scope-a, working in the checkout /wt/scope-a-x.',
    );
  });

  it("report-to-parent names no dispatch tool and states the forwarding limit", () => {
    const text = guidance("report-to-parent");
    expect(text).not.toContain("omp-ui_fleet_dispatch");
    expect(text).not.toContain("omp-ui_fleet_machines");
    expect(text).toContain("first 2,000 characters");
  });

  it("report-to-user names no dispatch tool", () => {
    const text = guidance("report-to-user");
    expect(text).not.toContain("omp-ui_fleet_dispatch");
    expect(text).not.toContain("omp-ui_fleet_machines");
    expect(text).toContain("tell the user");
  });

  it("falls back to the generic location for a very long path and keeps the role paragraphs", () => {
    const long = "/" + "x".repeat(5_000);
    const text = guidance("dispatch", { projectCwd: long, checkoutPath: long });
    expect(text.length).toBeLessThanOrEqual(PROJECT_SCOPE_TEXT_MAX);
    expect(text).not.toContain(long);
    expect(text).toContain("This session belongs to one omp-ui project; its working directory is that project's checkout.");
    expect(text).toContain("omp-ui_fleet_dispatch");
    expect(text).toContain("planMode true");
  });
});
