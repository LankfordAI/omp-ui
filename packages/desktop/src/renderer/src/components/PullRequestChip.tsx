import type { PullRequestLink } from "@omp-ui/core/types";
import { useT, type MessageKey } from "../lib/i18n";
import { cn } from "../lib/cn";
import { TONE_BORDER_OUTLINE_HOVER, TONE_CHIP, type Tone } from "./ui/tone";

/**
 * A linked pull request's face (issue #985). Failing checks outrank an open
 * or draft state: that is the state that wants attention. A merged or closed
 * PR shows its state whatever its last checks said.
 */
export function pullRequestFace(link: PullRequestLink): { tone: Tone; labelKey: MessageKey } {
  if ((link.state === "open" || link.state === "draft") && link.checks === "failing") {
    return { tone: "rose", labelKey: "pullRequest.state.failing" };
  }
  switch (link.state) {
    case "open":
      return { tone: "signal", labelKey: "pullRequest.state.open" };
    case "draft":
      return { tone: "neutral", labelKey: "pullRequest.state.draft" };
    case "merged":
      return { tone: "iris", labelKey: "pullRequest.state.merged" };
    case "closed":
      return { tone: "copper", labelKey: "pullRequest.state.closed" };
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
  const t = useT();
  const first = links[0];
  if (first === undefined) return null;
  const face = pullRequestFace(first);
  const title = links
    .map((link) => t("pullRequest.chip.title", { number: link.number, state: t(pullRequestFace(link).labelKey) }))
    .join("\n");
  const body = (
    <>
      <span className="tabular-nums">#{first.number}</span>
      <span>{t(face.labelKey)}</span>
      {links.length > 1 && <span className="text-ink-faint">+{links.length - 1}</span>}
    </>
  );
  const chipClass = cn(
    "inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-px font-mono text-[10px] leading-4",
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
      title={`${title}\n${t("pullRequest.chip.open")}`}
      aria-label={t("pullRequest.chip.openNamed", { number: first.number, state: t(face.labelKey) })}
      onClick={() => openPullRequest(first)}
    >
      {body}
    </button>
  );
}
