import { describe, expect, it } from "vitest";
import { parseSpawnRequest } from "./spawn-request";
import type { SpawnRequest } from "./types";

const newRpcRequest: SpawnRequest = {
  origin: "new",
  mode: "rpc-ui",
  projectCwd: "/project",
  advisor: true,
  advisorModel: "openrouter/advisor",
  cols: 120,
  rows: 40,
  worktree: {
    mint: { branch: "omp-ui/feature", baseRef: "main" },
  },
  planMode: false,
  planImplementationSource: {
    sourceTabId: "planning-tab",
    planTitle: "Accepted plan",
    planFilePath: "local://plans/accepted.md",
  },
};

const newPtyRequest: SpawnRequest = {
  origin: "new",
  mode: "pty",
  projectCwd: "/project",
  advisor: false,
  cols: 80,
  rows: 24,
  worktree: {
    reuse: { path: "/worktrees/feature", branch: "omp-ui/feature", base: "main" },
  },
};

const newProjectRequest: SpawnRequest = {
  ...newPtyRequest,
  worktree: null,
};

const resumeRequest: SpawnRequest = {
  origin: "resume",
  resumeTabId: "tab-1",
  cols: 90,
  rows: 30,
  advisor: false,
  advisorModel: null,
  planMode: true,
};

describe("parseSpawnRequest", () => {
  const nullPlanSource: SpawnRequest = {
    ...newRpcRequest,
    planImplementationSource: null,
  };
  it.each([newRpcRequest, newPtyRequest, newProjectRequest, nullPlanSource, resumeRequest])(
    "round-trips a well-shaped $origin request",
    (request) => {
      expect(parseSpawnRequest(request)).toEqual(request);
      expect(parseSpawnRequest(request)).not.toBe(request);
    },
  );

  it.each([
    ["non-object", null],
    ["unknown origin", { ...newRpcRequest, origin: "restart" }],
    ["unknown mode", { ...newRpcRequest, mode: "tui" }],
    ["missing new mode", { ...newRpcRequest, mode: undefined }],
    ["missing new columns", { ...newRpcRequest, cols: undefined }],
    ["missing new rows", { ...newRpcRequest, rows: undefined }],
    ["non-boolean advisor", { ...newRpcRequest, advisor: "yes" }],
    ["non-string advisor model", { ...newRpcRequest, advisorModel: 42 }],
    ["non-boolean plan mode", { ...newRpcRequest, planMode: "yes" }],
    ["missing new project", { ...newRpcRequest, projectCwd: undefined }],
    ["missing new advisor", { ...newRpcRequest, advisor: undefined }],
    ["non-finite columns", { ...newRpcRequest, cols: Number.POSITIVE_INFINITY }],
    ["non-finite rows", { ...newRpcRequest, rows: Number.NaN }],
    ["pty plan mode", { ...newPtyRequest, planMode: false }],
    ["missing worktree", { ...newRpcRequest, worktree: undefined }],
    ["ambiguous worktree", { ...newRpcRequest, worktree: { mint: {}, reuse: {} } }],
    ["malformed mint", { ...newRpcRequest, worktree: { mint: { branch: "", baseRef: 1 } } }],
    ["malformed reuse", { ...newRpcRequest, worktree: { reuse: { path: "", branch: "b" } } }],
    [
      "malformed plan source",
      { ...newRpcRequest, planImplementationSource: { sourceTabId: "tab", planTitle: "" } },
    ],
    ["resume project", { ...resumeRequest, projectCwd: "/project" }],
    ["resume worktree", { ...resumeRequest, worktree: null }],
    ["resume plan source", { ...resumeRequest, planImplementationSource: null }],
    ["missing resume tab", { ...resumeRequest, resumeTabId: "" }],
    ["legacy plan field", { ...newRpcRequest, startInPlanMode: false }],
  ] as const)("rejects %s", (_label, raw) => {
    expect(() => parseSpawnRequest(raw)).toThrow(/spawn request/);
  });
});
