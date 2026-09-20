export interface SessionExperiment {
  goal: string;
  metric: string;
  unit: string;
  direction: "lower" | "higher";
  launchedBranch: string | null;
  launchedAt: string;
}

export interface ExperimentRun {
  id: number;
  segment: number;
  command: string;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  exitCode: number | null;
  timedOut: boolean;
  parsedPrimary: number | null;
  metric: number | null;
  status: "keep" | "discard" | "crash" | "checks_failed" | null;
  abandoned: boolean;
  description: string | null;
  commitHash: string | null;
  modifiedPaths: string[];
  scopeDeviations: string[];
  justification: string | null;
  flagged: boolean;
  flaggedReason: string | null;
  loggedAt: number | null;
  hasLog: boolean;
}

export interface ExperimentProgress {
  segmentRuns: number;
  kept: number;
  discarded: number;
  crashed: number;
  checksFailed: number;
  baseline: { runId: number; metric: number } | null;
  best: { runId: number; metric: number } | null;
  pendingRunId: number | null;
  lastActivityAt: number | null;
  metricSeries: Array<{ runId: number; metric: number; kept: boolean }>;
}

export interface ExperimentRecord {
  id: number;
  name: string;
  goal: string | null;
  primaryMetric: string;
  metricUnit: string;
  direction: "lower" | "higher";
  preferredCommand: string | null;
  branch: string | null;
  baselineCommit: string | null;
  currentSegment: number;
  maxIterations: number | null;
  scopePaths: string[];
  offLimits: string[];
  constraints: string[];
  secondaryMetrics: string[];
  notes: string;
  createdAt: number;
  closedAt: number | null;
  progress: ExperimentProgress;
}

export interface ExperimentSource {
  cwd: string;
  key: string;
  dbPath: string;
}

export interface CheckoutExperiments {
  source: ExperimentSource | null;
  experiments: ExperimentRecord[];
  error: string | null;
}

export interface ProjectExperiments {
  projectCwd: string;
  repo: "git" | "none" | "jj-only";
  checkouts: Array<{
    cwd: string;
    tabId: string | null;
    branch: string | null;
    result: CheckoutExperiments;
  }>;
  pendingLaunches: Array<{ tabId: string; experiment: SessionExperiment }>;
}

export interface ExperimentDetail {
  record: ExperimentRecord | null;
  runs: ExperimentRun[];
  error: string | null;
}

export type RunLogResult =
  | { kind: "ok"; text: string; truncated: boolean }
  | { kind: "error"; error: string };
