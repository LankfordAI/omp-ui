import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import {
  DEVICE_PANE_DEFAULT_WIDTH,
  DEVICE_PANE_MIN_WIDTH,
} from "../../lib/panel-layout";
import { useT } from "../../lib/i18n";
import { useStore } from "../../store";
import { ResizeHandle } from "../ui";
import { useDesktopPanelWidths } from "../split-slot";
import { DevicePane } from "./DevicePane";

/** The desktop split: the device pane as a resizable column between the transcript and the inspector rail. */
export function DevicePaneSplit({ tabId }: { tabId: string }) {
  const t = useT();
  const resolved = useDesktopPanelWidths(tabId);
  const devicePaneWidth = useStore((s) => s.devicePaneWidth);
  const setDevicePaneWidth = useStore((s) => s.setDevicePaneWidth);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    setPreviewWidth(null);
  }, [devicePaneWidth]);

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
        label={t("device.split.resize")}
        edge="left"
        value={displayedWidth}
        min={DEVICE_PANE_MIN_WIDTH}
        max={resolved.splitAllowedMax}
        defaultValue={DEVICE_PANE_DEFAULT_WIDTH}
        onPreview={setPreviewWidth}
        onCommit={(width) => {
          setDevicePaneWidth(width);
          setPreviewWidth(null);
        }}
        onDraggingChange={setResizing}
      />
      <DevicePane tabId={tabId} posture="split" />
    </aside>
  );
}
