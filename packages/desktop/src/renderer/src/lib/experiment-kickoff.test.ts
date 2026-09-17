import { describe, expect, it } from "vitest";
import type { NewExperimentSpec } from "../store/types";
import { experimentKickoff } from "./experiment-kickoff";

const spec = (patch: Partial<NewExperimentSpec> = {}): NewExperimentSpec => ({
  goal: "reduce p95 latency of /search",
  metric: "p95_ms",
  unit: "ms",
  direction: "lower",
  command: null,
  scopePaths: [],
  offLimits: [],
  constraints: [],
  maxIterations: null,
  model: null,
  worktree: null,
  ...patch,
});

describe("experimentKickoff", () => {
  it("asks the agent to write the harness when no benchmark command is given", () => {
    const text = experimentKickoff(spec(), "reduce-p95-latency-of-search");
    expect(text).toBe(
      [
        "Autoresearch experiment: reduce p95 latency of /search",
        "",
        "Primary metric: p95_ms (ms), lower is better.",
        "No benchmark command yet: write ./autoresearch.sh so it runs the benchmark, exits 0, and prints `METRIC p95_ms=<value>`.",
        "",
        'Phase 1 — harness: make ./autoresearch.sh exit 0 and print `METRIC p95_ms=<value>`; validate it with `bash autoresearch.sh`. Then call init_experiment with name "reduce-p95-latency-of-search", goal, primary_metric "p95_ms", metric_unit "ms", direction "lower".',
        "Phase 2 — loop: run the baseline with run_experiment and log it with log_experiment, then form a hypothesis, change one thing, run, and log — keep only what improves p95_ms. Record ideas with update_notes.",
      ].join("\n"),
    );
  });

  it("carries a benchmark command, lists and the cap into both the brief and init_experiment", () => {
    const text = experimentKickoff(
      spec({
        unit: "",
        direction: "higher",
        command: "npm run bench",
        scopePaths: ["src/", "bench/"],
        offLimits: ["src/vendor"],
        constraints: ["no new deps"],
        maxIterations: 12,
      }),
      "slug",
    );
    expect(text).toContain("Primary metric: p95_ms, higher is better.\nBenchmark command: `npm run bench`\n");
    expect(text).toContain(
      "Scope paths: src/, bench/\nOff-limits: src/vendor\nConstraints: no new deps\nMax iterations per segment: 12\n",
    );
    expect(text).toContain(
      'direction "higher", preferred_command "npm run bench", scope_paths ["src/","bench/"], off_limits ["src/vendor"], constraints ["no new deps"], max_iterations 12.',
    );
    expect(text).not.toContain("No benchmark command yet");
  });

  it("omits optional lines and arguments rather than blanking them", () => {
    const text = experimentKickoff(spec({ command: "   " }), "slug");
    expect(text).not.toMatch(/Scope paths|Off-limits|Constraints|Max iterations/);
    expect(text).not.toMatch(/preferred_command|scope_paths|off_limits|constraints|max_iterations/);
    expect(text).toContain("No benchmark command yet");
  });
});
