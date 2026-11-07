import { describe, expect, it } from "vitest";
import { CH, type RpcFrame } from "@omp-ui/core";
import { ForeignOmpTracker, launchesBareOmpSession } from "./foreign-omp-tracker";

function bash(command: string): RpcFrame {
  return { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command } } as RpcFrame;
}

function makeTracker(): { tracker: ForeignOmpTracker; notices: Record<string, unknown>[] } {
  const notices: Record<string, unknown>[] = [];
  const tracker = new ForeignOmpTracker({
    send: (channel, ...args) => {
      if (channel === CH.onRpcFrame) notices.push(args[1] as Record<string, unknown>);
    },
  });
  return { tracker, notices };
}

describe("ForeignOmpTracker (#1022)", () => {
  it("posts one warn notice for a bare omp launch", () => {
    const { tracker, notices } = makeTracker();
    tracker.onFrame("tab", bash("OMP_SESSION_LOG=x omp 'hi' && echo done"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "omp_ui_notice", level: "warn", reason: "foreign-omp-launch" });
    expect(String(notices[0]!.message)).toContain("invisible to omp-ui");
    expect(String(notices[0]!.message)).toContain("Let agents dispatch fleet work");
  });

  it("warns once per live process, and again after the process dies", () => {
    const { tracker, notices } = makeTracker();
    tracker.onFrame("tab", bash("omp run"));
    tracker.onFrame("tab", bash("omp run --again"));
    expect(notices).toHaveLength(1);
    tracker.onExit("tab");
    tracker.onFrame("tab", bash("omp run"));
    expect(notices).toHaveLength(2);
  });

  it("ignores commands where omp is only a substring or a path segment", () => {
    const { tracker, notices } = makeTracker();
    for (const command of [
      "npm install my-omp-helper",
      "python omp_tools.py",
      "cat /opt/omp-ui/bin/notes.md",
      "/usr/local/bin/omp --version",
    ]) {
      tracker.onFrame("tab", bash(command));
    }
    expect(notices).toHaveLength(0);
  });

  it("ignores non-bash tools and frames without a usable command", () => {
    const { tracker, notices } = makeTracker();
    tracker.onFrame("tab", { type: "tool_execution_start", toolCallId: "t1", toolName: "exec", args: { command: "omp" } } as RpcFrame);
    tracker.onFrame("tab", { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: null } as RpcFrame);
    tracker.onFrame("tab", { type: "turn_start" } as RpcFrame);
    expect(notices).toHaveLength(0);
  });
});

describe("launchesBareOmpSession: real launches (#1075)", () => {
  for (const command of [
    "omp",
    "omp 'implement the thing'",
    "omp -c",
    "omp --continue",
    "omp --resume abc123",
    "OMP_SESSION_LOG=x omp 'hi'",
    "echo ready && omp",
    "cd /repo; omp --model openrouter/openai/gpt-5.6 'fix it'",
    "(omp &)",
    "if omp; then echo ran; fi",
    "time -p omp 'prompt'",
    "env FOO=1 omp",
    "nohup omp 'long task' &",
    // A word-leading backtick expansion executes: the shell runs `omp is
    // nice` even though only its stdout feeds printf.
    "printf '%s\\n' `omp is nice`",
    // An escaped first letter still names the same command.
    "\\omp",
  ]) {
    it(`warns for \`${command}\``, () => {
      expect(launchesBareOmpSession(command)).toBe(true);
    });
  }
});

describe("launchesBareOmpSession: prose, quotes, and data (#1075)", () => {
  for (const command of [
    // The issue's largest group: the word inside commit/issue text.
    'git commit -m "bump to omp\'s per-session spend caps (omp 18.13.0 …)"',
    'gh issue create --title "omp 18.x regression" --body "the omp agent did X"',
    'echo "kill omp $p"',
    "sed -i 's/currently omp 18\\.8\\.8)/now omp/' file.ts",
    // Quoted argument: data, not a launch.
    'grep -rn "omp" packages/ | head',
    'test -n "$(command -v omp)" && echo installed',
    // Directory/file names.
    "mkdir -p omp && tar xf bundle.tgz -C omp",
    'cp notes.md "my omp ideas.md"',
    "ls -la omp",
    // Heredoc bodies never reach a command position.
    "cat > /tmp/x <<'EOF'\nomp is nice\nsecond line\nEOF\necho done",
    'gh issue create --body "$(cat <<EOF\nthe agent runs omp by hand\nEOF\n)"',
    "python3 - <<PY\nprint('omp 18.17')\nPY",
    // Comments end the parse for their line.
    "# omp would orphan a child here\necho ok",
    "echo hi # run omp instead if needed",
    // Substrings and paths are never command words.
    "npm install my-omp-helper && cat /opt/omp-ui/bin/notes.md",
    "/usr/local/bin/omp --continue",
    "./omp-wrapper 'prompt'",
    // Redirect operands are files, not commands.
    "true; > omp",
    "echo x >> omp.log && grep omp omp.log",
    // Probes and session-free runs (below in their own group too).
    "which omp; omp --version",
    "omp --help | head -20",
    "omp config get session.maxCost",
    "omp models",
    "omp token openrouter",
    'omp --no-session -p "/mcp list"',
  ]) {
    it(`stays silent for \`${command.replace(/\n/g, "\\n")}\``, () => {
      expect(launchesBareOmpSession(command)).toBe(false);
    });
  }
});

describe("launchesBareOmpSession: probe-vs-launch boundaries (#1075)", () => {
  it("counts a later pipeline segment that launches, not the probe before it", () => {
    expect(launchesBareOmpSession("which omp; omp")).toBe(true);
    expect(launchesBareOmpSession("omp --version && omp")).toBe(true);
  });

  it("treats a flag value that names a subcommand as a value, not a subcommand", () => {
    expect(launchesBareOmpSession("omp --system-prompt config")).toBe(true);
    expect(launchesBareOmpSession("omp --session-dir models 'go'")).toBe(true);
  });

  it("counts a launch that executes inside a command substitution", () => {
    expect(launchesBareOmpSession("out=$(omp 'summarize') && echo $out")).toBe(true);
    expect(launchesBareOmpSession("x=`omp resume`")).toBe(true);
  });

  it("does not count a quoted word that merely begins a substitution", () => {
    // `"$(…)"` with no launch inside is data; the prose before it is too.
    expect(launchesBareOmpSession('echo "omp says $(hostname) here"')).toBe(false);
  });

  it("waives the notice for every no-session flag in any order", () => {
    expect(launchesBareOmpSession("omp --no-session")).toBe(false);
    expect(launchesBareOmpSession("omp -p 'hi' --model x")).toBe(false);
    expect(launchesBareOmpSession("omp --print 'hi'")).toBe(false);
    expect(launchesBareOmpSession("ls && omp --version")).toBe(false);
    expect(launchesBareOmpSession("omp -h")).toBe(false);
    expect(launchesBareOmpSession("omp config list --json")).toBe(false);
  });

  it("survives unbalanced quotes and unfinished syntax without throwing", () => {
    expect(() => launchesBareOmpSession('git commit -m "omp 18.13 unterminated')).not.toThrow();
    expect(launchesBareOmpSession('git commit -m "omp 18.13 unterminated')).toBe(false);
    expect(launchesBareOmpSession("echo $(omp")).toBe(true); // the launch still executes
    expect(() => launchesBareOmpSession("cat <<'EOF\nnever closed omp line")).not.toThrow();
    expect(launchesBareOmpSession("cat <<'EOF\nnever closed omp line")).toBe(false);
  });

  it("joins escaped characters and line continuations into one command word", () => {
    expect(launchesBareOmpSession("om\\\np --continue")).toBe(true);
    expect(launchesBareOmpSession("\\omp 'go'")).toBe(true);
    // An escaped `m` mid-word would still read as the same command name; a
    // quote still wins: quoted text is data.
    expect(launchesBareOmpSession("'\\omp' --continue")).toBe(false);
  });
});
