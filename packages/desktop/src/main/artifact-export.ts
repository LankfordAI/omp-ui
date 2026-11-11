/** Sanitize agent-authored text for a suggested save-dialog filename. */
export function sanitizeExportName(value: string): string {
  const stripped = value
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    // Leading dots/spaces would suggest hidden or traversal-ish names; keep dots only inside.
    .replace(/^[\s.]+/, "")
    .trim();
  return (stripped || "artifact").slice(0, 120);
}
