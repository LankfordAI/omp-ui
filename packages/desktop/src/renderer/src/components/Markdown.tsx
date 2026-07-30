import { useMemo, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { isSafeHref, parseMarkdown, type MdBlock, type MdSpan } from "../lib/markdown";
import { CopyButton } from "./ui";

/**
 * Renders parsed Markdown as React elements. There is deliberately no HTML
 * path — every node below is constructed, never interpreted, so untrusted
 * agent output cannot inject markup.
 */

const HEADING_CLASS: Record<number, string> = {
  1: "text-base",
  2: "text-[15px]",
  3: "text-sm",
  4: "text-sm",
  5: "text-[13px]",
  6: "text-[13px]",
};

const HEADING_TAG = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

function Spans({ spans }: { spans: MdSpan[] }) {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.kind) {
          case "code":
            return (
              <code key={i} className="rounded bg-overlay px-1 font-mono text-[0.9em] text-ink">
                {span.text}
              </code>
            );
          case "strong":
            return (
              <strong key={i} className="font-semibold text-ink">
                {span.text}
              </strong>
            );
          case "em":
            return (
              <em key={i} className="italic">
                {span.text}
              </em>
            );
          case "link":
            // No `href` attribute at all: the renderer must never navigate, and
            // its absence also kills middle-click and drag-to-navigate.
            return isSafeHref(span.href) ? (
              <a
                key={i}
                role="link"
                tabIndex={0}
                title={span.href}
                onClick={() => window.open(span.href, "_blank", "noopener,noreferrer")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    window.open(span.href, "_blank", "noopener,noreferrer");
                  }
                }}
                className="cursor-pointer text-iris underline decoration-iris-dim underline-offset-2 hover:decoration-iris"
              >
                {span.text}
              </a>
            ) : (
              // A rejected scheme becomes plain text with no tooltip: echoing
              // the target back would still put `javascript:…` on screen as if
              // it were a real destination.
              <span key={i}>{span.text}</span>
            );
          default:
            return <span key={i}>{span.text}</span>;
        }
      })}
    </>
  );
}

/** `trailing` is the streaming caret; it rides the last block so it never orphans. */
function Block({ block, trailing }: { block: MdBlock; trailing?: ReactNode }) {
  switch (block.kind) {
    case "code":
      return (
        <div className="overflow-hidden rounded-md border border-line bg-sunken">
          <div className="flex items-center justify-between border-b border-line-soft px-2 py-0.5">
            <span className="font-mono text-[10px] lowercase text-ink-dim">
              {block.lang ?? "text"}
            </span>
            <CopyButton text={block.text} />
          </div>
          <pre
            data-selectable
            className="overflow-x-auto px-3 py-2 font-mono text-[11.5px] leading-[1.55] text-ink-mid"
          >
            {block.text}
            {trailing}
          </pre>
        </div>
      );

    case "heading": {
      // Real heading tags: assistant answers are documents, and AT users
      // navigate them by outline rather than by scrolling.
      const Tag = HEADING_TAG[Math.min(Math.max(block.level, 1), 6) - 1] ?? "h3";
      return (
        <Tag
          className={cn(
            "font-display font-semibold text-ink",
            HEADING_CLASS[block.level] ?? "text-sm",
            block.level >= 4 && "text-ink-mid",
          )}
        >
          <Spans spans={block.spans} />
          {trailing}
        </Tag>
      );
    }

    case "list":
      return (
        <ul className="space-y-1">
          {block.items.map((spans, i) => (
            <li key={i} className="flex gap-2">
              <span
                className={cn(
                  "shrink-0 select-none text-ink-dim",
                  block.ordered ? "min-w-[1.4em] text-right tabular-nums" : "min-w-[1em]",
                )}
              >
                {block.ordered ? `${i + 1}.` : "•"}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed">
                <Spans spans={spans} />
                {i === block.items.length - 1 && trailing}
              </span>
            </li>
          ))}
        </ul>
      );

    case "quote":
      return (
        <blockquote className="border-l-2 border-line-strong pl-3 text-ink-mid">
          <p className="whitespace-pre-wrap break-words leading-relaxed">
            <Spans spans={block.spans} />
            {trailing}
          </p>
        </blockquote>
      );

    case "rule":
      return (
        <div>
          <hr className="h-px border-0 bg-line" />
          {trailing}
        </div>
      );

    default:
      return (
        <p className="whitespace-pre-wrap break-words leading-relaxed">
          <Spans spans={block.spans} />
          {trailing}
        </p>
      );
  }
}

export function Markdown({
  text,
  className,
  trailing,
}: {
  text: string;
  className?: string;
  /** Appended inside the final block — used for the streaming caret. */
  trailing?: ReactNode;
}) {
  // Streaming re-renders this on every delta, and the parse is the cost.
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  if (blocks.length === 0) return trailing ? <div className={className}>{trailing}</div> : null;
  return (
    <div className={cn("space-y-2 text-sm", className)} data-selectable>
      {blocks.map((block, i) => (
        <Block key={i} block={block} trailing={i === blocks.length - 1 ? trailing : undefined} />
      ))}
    </div>
  );
}
