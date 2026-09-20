import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const coreRoot = path.resolve(import.meta.dirname, "..");
const desktopSrc = path.resolve(coreRoot, "../desktop/src");
const exportsMap = JSON.parse(fs.readFileSync(path.join(coreRoot, "package.json"), "utf8")).exports as Record<
  string,
  string
>;

function sourceFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}

function resolveCoreImport(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith("@omp-ui/core/")) {
    const exported = exportsMap[`./${specifier.slice("@omp-ui/core/".length)}`];
    return exported === undefined ? null : path.resolve(coreRoot, exported);
  }
  if (!specifier.startsWith(".")) return null;
  const target = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [target, `${target}.ts`, `${target}.tsx`, path.join(target, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function importsOf(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyNamedTypes =
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly);
      if (clause === undefined || (!clause.isTypeOnly && !onlyNamedTypes)) {
        imports.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return imports;
}

describe("renderer-consumed core export graphs", () => {
  it("contain no Node built-ins or node-pty imports", () => {
    const rendererFiles = [
      ...sourceFiles(path.join(desktopSrc, "renderer")),
      ...sourceFiles(path.join(desktopSrc, "web")),
    ];
    const roots = new Set<string>();
    for (const file of rendererFiles) {
      for (const specifier of importsOf(file)) {
        if (!specifier.startsWith("@omp-ui/core/")) continue;
        const resolved = resolveCoreImport(file, specifier);
        expect(resolved, `unexported renderer core import ${specifier}`).not.toBeNull();
        roots.add(resolved!);
      }
    }

    const pending = [...roots];
    const visited = new Set<string>();
    const violations: string[] = [];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith("node:") || specifier === "node-pty") {
          violations.push(`${path.relative(coreRoot, file)} -> ${specifier}`);
          continue;
        }
        const resolved = resolveCoreImport(file, specifier);
        if (resolved !== null && resolved.startsWith(`${coreRoot}${path.sep}`)) pending.push(resolved);
      }
    }

    expect(roots.size).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
