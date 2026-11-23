// Renderer-side shapes for the omp 19.1 remote host controls (issue #1272).
// The wire grammar, version gate, and parsers live in @omp-ui/core/host-controls;
// this module holds only what the store and components share, so the store
// types never import a slice module directly.
import type { ModelPickerRow } from "@omp-ui/core/host-controls";

/**
 * One `get_model_picker` fetch as the dialog renders it: the rows for `query`
 * in omp's own order (`recent` counts the leading Recent block), plus the
 * in-flight/error state so a keystroke never paints a stale page.
 */
export interface ModelPickerView {
  query: string;
  rows: ModelPickerRow[];
  recent: number;
  total: number;
  loading: boolean;
  error: string | null;
}

/** omp's ctrl+p quick-role browse prefix (`@`). */
export const QUICK_ROLE_PREFIX = "@";
