import { useCallback, type ReactNode } from "react";
import { useStore } from "../store";
import { RoutineFocusContext } from "./MarkdownRoutineContext";

/** App-root provider: every transcript shares the one Routines surface. */
export function RoutineFocusProvider({ children }: { children: ReactNode }) {
  const focusRoutine = useStore((s) => s.focusRoutine);
  const focus = useCallback((id: string) => focusRoutine(id), [focusRoutine]);
  return <RoutineFocusContext.Provider value={focus}>{children}</RoutineFocusContext.Provider>;
}
