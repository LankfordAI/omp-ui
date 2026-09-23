import { useEffect, useState } from "react";
import { formatBrowserClock } from "@omp-ui/core/browser-pane";
import { currentLocaleId, useT } from "../../lib/i18n";

/** The current time, re-read on each wall-clock minute boundary. */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer = 0;
    const schedule = (): void => {
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, 60_000 - (Date.now() % 60_000));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);
  return now;
}

/** The browser clock strip atop the pane (see CONTEXT.md "Browser clock"), GNOME top-bar style. */
export function BrowserPaneClock() {
  const t = useT();
  const now = useMinuteClock();
  const { date, time } = formatBrowserClock(now, currentLocaleId());
  return (
    <time
      dateTime={now.toISOString()}
      aria-label={t("browser.clock.label")}
      className="flex h-5 shrink-0 items-center justify-center gap-4 bg-void text-[11px] font-semibold tabular-nums text-ink"
    >
      <span>{date}</span>
      <span>{time}</span>
    </time>
  );
}
