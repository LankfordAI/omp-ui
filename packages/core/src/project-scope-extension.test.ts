import { describe, expect, it } from "vitest";
import {
  PROJECT_SCOPE_TEXT_MAX,
  projectScopeGuidance,
  type ProjectScopeInput,
  type ProjectScopeRole,
} from "./project-scope-extension";

const fences = {
  agentDir: "/home/u/.omp/agent",
  userData: "/home/u/.config/@omp-ui/desktop",
  sessionsRoot: "/home/u/.omp/agent/sessions",
  archiveRoot: "/home/u/.omp/agent/sessions-archive",
};
const base: Omit<ProjectScopeInput, "role"> = {
  kind: "project",
  projectName: "scope-a",
  projectCwd: "/repos/scope-a",
  checkoutPath: "/repos/scope-a",
  fences,
};
const guidance = (role: ProjectScopeRole, over: Partial<ProjectScopeInput> = {}): string =>
  projectScopeGuidance({ ...base, ...over, role });

const ROLES: ProjectScopeRole[] = ["dispatch", "report-to-parent", "report-to-user", "no-dispatch"];
const ROLE_MARK: Record<ProjectScopeRole, string> = {
  dispatch: "planMode true",
  "report-to-parent": "first 2,000 characters",
  "report-to-user": "This is a private session",
  "no-dispatch": "This session cannot dispatch work to other sessions.",
};

describe("projectScopeGuidance (#1226, #1227)", () => {
  it("dispatch text names the project, the fleet tools, planMode true, and local project requests", () => {
    const text = guidance("dispatch");
    expect(text).toContain('the project "scope-a" at /repos/scope-a.');
    expect(text).toContain("omp-ui_fleet_machines");
    expect(text).toContain("omp-ui_fleet_dispatch");
    expect(text).toContain("omp-ui_fleet_project");
    expect(text).toContain('machine "this computer"');
    expect(text).toContain("planMode true");
    expect(text).not.toContain("working in the checkout");
  });

  it("report-to-parent names no fleet tool, states the forwarding limit, and uses the child outside-files text", () => {
    const text = guidance("report-to-parent");
    expect(text).not.toMatch(/omp-ui_fleet_/);
    expect(text).toContain("first 2,000 characters");
    expect(text).toContain("the prompt that dispatched you names them");
    expect(text).toContain(`Do not change omp's agent folder ${fences.agentDir} (extensions`);
    expect(text).not.toContain("the user's request names them");
  });

  it("report-to-user and no-dispatch name no fleet tool", () => {
    for (const role of ["report-to-user", "no-dispatch"] as const) {
      const text = guidance(role);
      expect(text).not.toMatch(/omp-ui_fleet_/);
      expect(text).toContain("tell the user what the other repository needs");
      expect(text).toContain("the user's request names them");
    }
  });

  it("a chat opens with the chat text and never names a project", () => {
    const text = guidance("dispatch", { kind: "chat", projectName: "ignored", projectCwd: "/chats/c1", checkoutPath: "/chats/c1" });
    expect(text).toContain("belongs to no project");
    expect(text).not.toContain("ignored");
    expect(text).toContain("omp-ui_fleet_dispatch");
  });

  it("a realistic worktree location uses tier 1: the checkout path and the real fences", () => {
    const text = guidance("dispatch", {
      projectName: "omp-ui",
      projectCwd: "/home/alankford/Documents/GitHub/omp-ui",
      checkoutPath: "/home/alankford/.config/@omp-ui/desktop/worktrees/omp-ui--884e5253/omp-ui-main-2c1ec7d1",
    });
    expect(text.length).toBeLessThanOrEqual(PROJECT_SCOPE_TEXT_MAX);
    expect(text).toContain("working in the checkout /home/alankford/.config/@omp-ui/desktop/worktrees/omp-ui--884e5253/omp-ui-main-2c1ec7d1.");
    expect(text).toContain(fences.agentDir);
    expect(text).toContain(fences.sessionsRoot);
  });

  it.each(ROLES.flatMap((role) => [["project", role], ["chat", role]] as const))(
    "stays within the cap with 5,000-character paths and fences: %s %s",
    (kind, role) => {
      const long = "/" + "x".repeat(5_000);
      const text = guidance(role, {
        kind,
        projectCwd: long,
        checkoutPath: long,
        fences: { agentDir: long, userData: long, sessionsRoot: long, archiveRoot: long },
      });
      expect(text.length).toBeLessThanOrEqual(PROJECT_SCOPE_TEXT_MAX);
      expect(text).not.toContain(long);
      expect(text).toContain(ROLE_MARK[role]);
      expect(text).toContain("~/.omp/agent unless PI_CODING_AGENT_DIR moves it");
    },
  );

  it("a long location alone falls back to the generic location but keeps the named fences", () => {
    const long = "/" + "x".repeat(5_000);
    const text = guidance("dispatch", { projectCwd: long, checkoutPath: long });
    expect(text).toContain("This session belongs to one omp-ui project; its working directory is that project's checkout.");
    expect(text).toContain(fences.agentDir);
  });
});
