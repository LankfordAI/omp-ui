import type { CatchupDigest, CatchupFile, CatchupOutcome } from "../lib/catchup";
import { useStore } from "../store";
import { compactNum, formatCost } from "./SessionHud";
import { Button, Chip, IconButton, Panel } from "./ui";

/** "2h 14m" / "14m" — the header's away-duration readout. */
function formatAway(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${minutes}m`;
}

const TURN_GLYPH: Record<CatchupOutcome, string> = {
  completed: "✓", error: "✗", interrupted: "⏸", truncated: "⚠", running: "◌",
};
const TURN_CLASS: Record<CatchupOutcome, string> = {
  completed: "text-ink-faint", error: "text-rose",
  interrupted: "text-copper", truncated: "text-copper", running: "text-ink-faint",
};
const OP_LETTER: Record<CatchupFile["op"], string> = { write: "W", edit: "E", read: "R" };
const OP_TONE: Record<CatchupFile["op"], "copper" | "iris" | "neutral"> = {
  write: "copper", edit: "iris", read: "neutral",
};

export function CatchupCard({ tabId }: { tabId: string }) {
  const entry = useStore((s) => s.catchup[tabId]);
  const dismissCatchup = useStore((s) => s.dismissCatchup);
  const showPlanReview = useStore((s) => s.showPlanReview);
  const digest: CatchupDigest | null = entry?.settled === true ? entry.digest : null;
  if (digest === null) return null;
  const hasTokens = digest.tokens.input + digest.tokens.output + digest.tokens.cacheRead > 0;
  const hasSpend = digest.cost > 0 || hasTokens;
  return (
    <div className="px-3 pt-2">
      <Panel tone="neutral" className="animate-rise flex flex-col gap-1.5 px-2.5 py-2">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink">
            While you were away — {formatAway(digest.awayMs)}
          </p>
          <IconButton label="dismiss catch-up summary" onClick={() => dismissCatchup(tabId)}>✕</IconButton>
        </div>
        {digest.pendingPlan !== null && (
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[11px] text-ink" title={digest.pendingPlan.title}>
              <span className="font-medium text-copper">Plan awaiting review: </span>
              {digest.pendingPlan.title}
            </p>
            <Button size="xs" variant="solid" tone="copper" onClick={() => showPlanReview(tabId)}>
              Review plan
            </Button>
          </div>
        )}
        {digest.turnsOmitted > 0 && (
          <p className="text-[10px] text-ink-dim">{digest.turnsOmitted} earlier turns</p>
        )}
        {digest.turns.map((t, i) => (
          <p key={i} className="flex items-baseline gap-1.5 text-[11px]">
            <span className={TURN_CLASS[t.outcome]}>{TURN_GLYPH[t.outcome]}</span>
            <span className="min-w-0 truncate text-ink-mid" title={t.prompt}>{t.prompt}</span>
          </p>
        ))}
        {digest.files.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {digest.files.map((f) => (
              <Chip key={f.path} mono tone={OP_TONE[f.op]} title={`${f.path} (${f.op})`}>
                {OP_LETTER[f.op]} {f.path}
              </Chip>
            ))}
            {digest.filesOmitted > 0 && (
              <span className="text-[10px] text-ink-dim">+{digest.filesOmitted} more</span>
            )}
          </div>
        )}
        {(hasSpend || digest.advisor !== null) && (
          <p className="font-mono text-[10px] tabular-nums text-ink-mid">
            {hasSpend && (
              <>
                {formatCost(digest.cost)} · {compactNum(digest.tokens.input + digest.tokens.output + digest.tokens.cacheRead)} tok since you left
              </>
            )}
            {digest.advisor !== null && (
              <>
                {hasSpend && " · "}
                adv {formatCost(digest.advisor.cost)} · {compactNum(digest.advisor.tokens)} tok (session)
              </>
            )}
          </p>
        )}
        {digest.lifecycle.length > 0 && (
          <p className="text-[10px] text-ink-dim">
            {digest.lifecycle.join(" · ")}
            {digest.lifecycleOmitted > 0 ? ` · +${digest.lifecycleOmitted} more` : ""}
          </p>
        )}
      </Panel>
    </div>
  );
}
