import type { PullRequestLink } from "@omp-ui/core/types";
import { cn } from "../lib/cn";
import { TONE_BORDER_OUTLINE_HOVER, TONE_CHIP, type Tone } from "./ui/tone";

/**
 * A linked pull request's face (issue #985). Failing checks outrank an open
 * or draft state: that is the state that wants attention. A merged or closed
 * PR shows its state whatever its last checks said.
 */
export function pullRequestFace(link: PullRequestLink): { tone: Tone; label: string } {
  if ((link.state === "open" || link.state === "draft") && link.checks === "failing") {
    return { tone: "rose", label: "CI failing" };
  }
  switch (link.state) {
    case "open":
      return { tone: "signal", label: "open" };
    case "draft":
      return { tone: "neutral", label: "draft" };
    case "merged":
      return { tone: "iris", label: "merged" };
    case "closed":
      return { tone: "copper", label: "closed" };
  }
}

/** Opens a PR page; main's window-open handler routes it through openExternalSafe. */
export function openPullRequest(link: PullRequestLink): void {
  window.open(link.url, "_blank", "noopener,noreferrer");
}

/**
 * The session's newest linked pull request as a chip: `#985 merged`, plus
 * `+N` when the branch has more. `interactive` renders a button that opens
 * the PR; the sidebar row passes false because the row is already a button.
 */
export function PullRequestChip({
  links,
  interactive,
  className,
}: {
  links: readonly PullRequestLink[];
  interactive: boolean;
  className?: string;
}) {
  const first = links[0];
  if (first === undefined) return null;
  const face = pullRequestFace(first);
  const title = links
    .map((link) => `pull request #${link.number}: ${pullRequestFace(link).label}`)
    .join("\n");
  const body = (
    <>
      <span className="tabular-nums">#{first.number}</span>
      <span>{face.label}</span>
      {links.length > 1 && <span className="text-ink-faint">+{links.length - 1}</span>}
    </>
  );
  const chipClass = cn(
    "inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-px font-mono text-xs leading-4",
    TONE_CHIP[face.tone],
    className,
  );
  if (!interactive) {
    return (
      <span className={chipClass} title={title}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cn(chipClass, "transition-colors", TONE_BORDER_OUTLINE_HOVER[face.tone])}
      title={`${title}\n${"open it in the browser"}`}
      aria-label={`Open pull request #${first.number} (${face.label})`}
      onClick={() => openPullRequest(first)}
    >
      {body}
    </button>
  );
}
