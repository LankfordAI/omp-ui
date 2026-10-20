import type { SessionSummary } from "@omp-ui/core/types";
import { useT } from "../lib/i18n";
import { useStore } from "../store";
import { SessionRow } from "./SessionRow";
import { Button, Empty, IconButton, IconLock, IconPlus, Label } from "./ui";

/** Three pulsing bars — the honest "we have not heard from the backend yet". */
export function SkeletonRows() {
  return (
    <div className="space-y-2 px-3 py-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="animate-pulse space-y-1.5" style={{ animationDelay: `${i * 120}ms` }}>
          <div className="h-2.5 rounded bg-line-soft" style={{ width: `${72 - i * 14}%` }} />
          <div className="h-2 w-1/3 rounded bg-line-soft" />
        </div>
      ))}
    </div>
  );
}

/** Case-insensitive title match; an empty query keeps every chat. */
export function filterChats(chats: readonly SessionSummary[], query: string): SessionSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...chats];
  return chats.filter((chat) => chat.title.toLowerCase().includes(q));
}

/** The sidebar's Chat mode: project-free sessions, host-local and ungrouped (issue #894). */
export function ChatList({ query, onActivate }: { query: string; onActivate: () => void }) {
  const t = useT();
  const state = useStore((st) => st.state);
  const newChat = useStore((st) => st.newChat);

  if (state === null) return <SkeletonRows />;
  const chats = state.chats;
  const shown = filterChats(chats, query);

  return (
    <div>
      <div className="flex items-center gap-1 px-3 pt-2 pb-1">
        <Label className="flex-1">{t("sidebar.chats.heading")}</Label>
        <IconButton label={t("sidebar.chats.newPrivate")} onClick={() => { void newChat({ private: true }); onActivate(); }}>
          <IconLock />
        </IconButton>
        <IconButton label={t("sidebar.chats.new")} onClick={() => { void newChat(); onActivate(); }}>
          <IconPlus />
        </IconButton>
      </div>
      {chats.length === 0 ? (
        <Empty
          title={t("sidebar.chats.empty")}
          hint={t("sidebar.chats.emptyHint")}
          action={
            <Button variant="solid" onClick={() => { void newChat(); onActivate(); }}>
              {t("sidebar.chats.new")}
            </Button>
          }
        />
      ) : shown.length === 0 ? (
        <Empty title={t("sidebar.chats.noMatches", { query: query.trim() })} />
      ) : (
        shown.map((chat) => <SessionRow key={chat.tabId} s={chat} onActivate={onActivate} />)
      )}
    </div>
  );
}
