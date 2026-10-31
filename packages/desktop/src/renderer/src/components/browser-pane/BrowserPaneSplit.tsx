import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import {
  BROWSER_PANE_DEFAULT_WIDTH,
  BROWSER_PANE_MIN_WIDTH,
} from "../../lib/panel-layout";
import { useT } from "../../lib/i18n";
import { useStore } from "../../store";
import { ResizeHandle } from "../ui";
import { useDesktopPanelWidths } from "../split-slot";
import { BrowserPane } from "./BrowserPane";

/** The desktop split: the pane as a resizable column between the transcript and the inspector rail. */
export function BrowserPaneSplit({ tabId }: { tabId: string }) {
  const t = useT();
  const resolved = useDesktopPanelWidths(tabId);
  const browserPaneWidth = useStore((s) => s.browserPaneWidth);
  const setBrowserPaneWidth = useStore((s) => s.setBrowserPaneWidth);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    setPreviewWidth(null);
  }, [browserPaneWidth]);

  const displayedWidth = previewWidth ?? resolved.splitWidth;

  return (
    <aside
     
      className={cn(
        "relative flex shrink-0 flex-col border-l border-line",
        !resizing && "transition-[width] duration-200 ease-out-quint",
      )}
      style={{ width: displayedWidth }}
    >
      <ResizeHandle
        label={t("browser.split.resize")}
        edge="left"
        value={displayedWidth}
        min={BROWSER_PANE_MIN_WIDTH}
        max={resolved.splitAllowedMax}
        defaultValue={BROWSER_PANE_DEFAULT_WIDTH}
        onPreview={setPreviewWidth}
        onCommit={(width) => {
          setBrowserPaneWidth(width);
          setPreviewWidth(null);
        }}
        onDraggingChange={setResizing}
      />
      <BrowserPane tabId={tabId} posture="split" />
    </aside>
  );
}
