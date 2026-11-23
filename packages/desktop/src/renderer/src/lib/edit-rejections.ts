/** omp's edit `errorKind` vocabulary (native `editErrorKinds()`, omp 18.13.2) → display label. */
const EDIT_ERROR_KIND_LABEL: Partial<Record<string, string>> = {
  parse: "parse error",
  apply: "apply failed",
  invalid_utf8: "invalid UTF-8",
  no_match: "no match",
  plan_mode: "plan mode",
  unresolved_url: "unresolved URL",
  io: "I/O error",
  write_failed: "write failed",
  stale_tag: "stale tag",
  unknown_tag: "unknown tag",
  other_file_tag: "other file's tag",
  missing_tag: "missing tag",
  header_only: "header only",
  unseen_lines: "unseen lines",
  out_of_range: "out of range",
  ambiguous_boundary: "ambiguous boundary",
  no_change: "no change",
  file_not_found: "file not found",
};

/**
 * Display label for an omp edit `errorKind`. A kind this build does not know
 * (a newer omp) is data: it prints with underscores as spaces, as omp's own
 * `/session` does.
 */
export function editErrorKindLabel(kind: string): string {
  return EDIT_ERROR_KIND_LABEL[kind] ?? kind.replaceAll("_", " ");
}
