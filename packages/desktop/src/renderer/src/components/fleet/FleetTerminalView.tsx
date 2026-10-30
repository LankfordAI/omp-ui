import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import type { FleetTerminalRecord } from "@omp-ui/core/fleet";
import { backend } from "../../backend";
import { useFontFamily } from "../../lib/font-families";
import { useT } from "../../lib/i18n";
import { applyTerminalAppearance, createPtyResizePusher, createTerminal, type CreatedTerminal } from "../../lib/terminal";
import { useTheme } from "../../lib/themes";
import { findInstance, registerFleetTerminalWriter, useStore } from "../../store";
import { useTerminalCopyMenu } from "../useTerminalCopyMenu";
import { Button, Chip, Dot, IconButton, IconClose, Label } from "../ui";

/**
 * One fleet terminal (issue #991, ADR-0084): a login shell running on a fleet
 * member, shown in the main pane in place of the tabs. The PTY lives on the
 * member; this view is its xterm. Terminal construction mirrors the console
 * drawer. Closing ends the member's shell; Back to Fleet only hides the view,
 * and the shell keeps running until it is closed, exits, or this app quits.
 */
export function FleetTerminalView({ terminal }: { terminal: FleetTerminalRecord }) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<CreatedTerminal | null>(null);
  const theme = useTheme();
  const font = useFontFamily();
  const copyMenu = useTerminalCopyMenu(termRef);
  const openFleet = useStore((s) => s.openFleet);
  const closeFleetTerminal = useStore((s) => s.closeFleetTerminal);
  const memberJoined = useStore((s) => findInstance(s.state, terminal.machineKey)?.status === "joined");
  const ended = terminal.exitCode !== null;
  const { terminalId } = terminal;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const { term, fit } = createTerminal(host, theme, font);
    termRef.current = { term, fit };
    const dataSub = term.onData((data) => backend.fleetTerminalInput(terminalId, data));
    const unregister = registerFleetTerminalWriter(terminalId, (data) => term.write(data));
    const pushResize = createPtyResizePusher(term, (cols, rows) => backend.fleetTerminalResize(terminalId, cols, rows));
    const observer = new ResizeObserver(() => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fit.fit();
      pushResize();
    });
    observer.observe(host);
    term.focus();
    return () => {
      observer.disconnect();
      dataSub.dispose();
      unregister();
      term.dispose();
      termRef.current = null;
    };
    // Theme and font restyle the live terminal below; rebuilding would drop the scrollback.
  }, [terminalId]);

  useEffect(() => {
    const term = termRef.current?.term;
    if (term) applyTerminalAppearance(term, theme, font);
  }, [theme, font]);

  return (
    <div className="absolute inset-0 flex flex-col bg-void text-ink" data-fleet-terminal={terminalId}>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line chrome-void px-3">
        <Dot tone={ended ? "neutral" : memberJoined ? "signal" : "rose"} />
        <Label>{t("fleet.terminal.title", { machine: terminal.nickname })}</Label>
        {ended && (
          <Chip tone="neutral">
            {terminal.exitCode === -1 ? t("fleet.terminal.lost") : t("fleet.terminal.exited", { code: terminal.exitCode ?? 0 })}
          </Chip>
        )}
        {!ended && !memberJoined && <Chip tone="rose">{t("fleet.terminal.unreachable", { machine: terminal.nickname })}</Chip>}
        <span className="flex-1" />
        <Button size="xs" variant="ghost" onClick={openFleet}>
          {t("fleet.terminal.back")}
        </Button>
        <IconButton label={t("fleet.terminal.close")} onClick={() => void closeFleetTerminal(terminalId)}>
          <IconClose />
        </IconButton>
      </header>
      <div className="ambient relative min-h-0 flex-1 bg-surface p-2">
        <div ref={hostRef} className="h-full w-full" onContextMenu={copyMenu.onContextMenu} />
        {copyMenu.menu}
      </div>
    </div>
  );
}
