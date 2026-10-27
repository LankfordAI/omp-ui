import { t, type MessageKey } from "./i18n";

/** omp's edit `errorKind` vocabulary (native `editErrorKinds()`, omp 18.13.2) → catalog key. */
const EDIT_ERROR_KIND_KEY: Partial<Record<string, MessageKey>> = {
  parse: "editError.parse",
  apply: "editError.apply",
  invalid_utf8: "editError.invalidUtf8",
  no_match: "editError.noMatch",
  plan_mode: "editError.planMode",
  unresolved_url: "editError.unresolvedUrl",
  io: "editError.io",
  write_failed: "editError.writeFailed",
  stale_tag: "editError.staleTag",
  unknown_tag: "editError.unknownTag",
  other_file_tag: "editError.otherFileTag",
  missing_tag: "editError.missingTag",
  header_only: "editError.headerOnly",
  unseen_lines: "editError.unseenLines",
  out_of_range: "editError.outOfRange",
  ambiguous_boundary: "editError.ambiguousBoundary",
  no_change: "editError.noChange",
  file_not_found: "editError.fileNotFound",
};

/**
 * Display label for an omp edit `errorKind`. A kind this build does not know
 * (a newer omp) is data: it prints with underscores as spaces, as omp's own
 * `/session` does. Callers render inside a component that calls `useT()`, so
 * a locale switch re-renders them.
 */
export function editErrorKindLabel(kind: string): string {
  const key = EDIT_ERROR_KIND_KEY[kind];
  return key === undefined ? kind.replaceAll("_", " ") : t(key);
}
