#!/usr/bin/env python3
"""List renderer chrome literals that may still need a t() key.

Read-only heuristic for issue #363. Review hits manually: brand names, hotkeys,
paths, commands, and data labels are intentionally outside localization.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "packages/desktop/src/renderer/src"
INLINE = re.compile(r">([^<>{}\n]*[A-Za-z][^<>{}\n]*)</")
BARE = re.compile(r"^\s*([A-Za-z][^<>{}\n]*?)\s*$")
ATTR = re.compile(r'\b(?:label|title|placeholder|aria-label|alt)="([^"]*[A-Za-z][^"]*)"')
CODE_CHARS = set(";()=:,`+&|!")


def candidates(path: Path):
    lines = path.read_text(encoding="utf-8").splitlines()
    in_comment = False
    for index, line in enumerate(lines):
        stripped = line.strip()
        if in_comment:
            in_comment = "*/" not in line
            continue
        if stripped.startswith("/*") or stripped.startswith("*"):
            in_comment = "*/" not in line
            continue
        if not stripped or stripped.startswith("//") or "{/*" in line:
            continue
        match = INLINE.search(line)
        if match and match.group(1).strip():
            yield index + 1, "inline", match.group(1).strip()
            continue
        match = BARE.match(line)
        following = lines[index + 1].lstrip() if index + 1 < len(lines) else ""
        if match and not (set(match.group(1)) & CODE_CHARS) and following.startswith("</"):
            yield index + 1, "line", match.group(1)
            continue
        for match in ATTR.finditer(line):
            yield index + 1, "attr", match.group(1)


def main() -> int:
    hits = 0
    for path in sorted(ROOT.rglob("*.tsx")):
        if path.name.endswith(".test.tsx"):
            continue
        for line, kind, text in candidates(path):
            print(f"{path.relative_to(ROOT)}:{line}: {kind}: {text}")
            hits += 1
    print(f"\n{hits} candidate(s)")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
