import { describe, expect, it } from "vitest";
import type { VaultToolDetails } from "@omp-ui/core/vault-shared";
import type { RenderItem, ToolItem } from "./transcript";
import { touchedVaultNotes } from "./vault-notes";

function write(id: string, details: VaultToolDetails | undefined, status: ToolItem["status"] = "done"): ToolItem {
  return {
    kind: "tool",
    id,
    toolCallId: id,
    name: `omp-ui_vault_${details?.action ?? "create"}`,
    args: {},
    status,
    vault: details,
  };
}

function details(fields: Partial<VaultToolDetails> & Pick<VaultToolDetails, "action">): VaultToolDetails {
  return { vaultName: "Notes", vaultId: null, path: "omp-ui/A.md", createdByOmpUi: true, ...fields };
}

describe("touchedVaultNotes", () => {
  it("dedupes by vault and path, latest action wins, rows keep first-touch order", () => {
    const items: RenderItem[] = [
      write("c1", details({ action: "create", path: "omp-ui/A.md" })),
      write("a1", details({ action: "append", path: "omp-ui/B.md", createdByOmpUi: false })),
      write("e1", details({ action: "edit", path: "omp-ui/A.md" })),
    ];
    expect(touchedVaultNotes(items)).toEqual([
      { vaultName: "Notes", vaultId: null, path: "omp-ui/A.md", title: "A", action: "edit", itemId: "e1", createdByOmpUi: true },
      { vaultName: "Notes", vaultId: null, path: "omp-ui/B.md", title: "B", action: "append", itemId: "a1", createdByOmpUi: false },
    ]);
  });

  it("keeps the same path in two vaults as two rows", () => {
    const items: RenderItem[] = [
      write("w1", details({ action: "append", vaultName: "Notes" })),
      write("w2", details({ action: "append", vaultName: "Work", vaultId: "0123456789abcdef" })),
    ];
    const rows = touchedVaultNotes(items);
    expect(rows.map((r) => [r.vaultName, r.path, r.itemId])).toEqual([
      ["Notes", "omp-ui/A.md", "w1"],
      ["Work", "omp-ui/A.md", "w2"],
    ]);
    expect(rows[1]?.vaultId).toBe("0123456789abcdef");
  });

  it("touches the Index note a create updated as an omp-ui edit", () => {
    const indexNotePath = "omp-ui/proj/proj Index.md";
    const create = write("c1", details({ action: "create", path: "omp-ui/proj/Plan.md", title: "Plan", indexNotePath }));

    expect(touchedVaultNotes([create])).toEqual([
      { vaultName: "Notes", vaultId: null, path: "omp-ui/proj/Plan.md", title: "Plan", action: "create", itemId: "c1", createdByOmpUi: true },
      { vaultName: "Notes", vaultId: null, path: indexNotePath, title: "proj Index", action: "edit", itemId: "c1", createdByOmpUi: true },
    ]);

    const append = write("a1", details({ action: "append", path: indexNotePath }));
    const rows = touchedVaultNotes([create, append]);
    expect(rows.map((r) => r.path)).toEqual(["omp-ui/proj/Plan.md", indexNotePath]);
    expect(rows[1]).toMatchObject({ path: indexNotePath, action: "append", itemId: "a1" });
  });

  it("skips unsettled, failed, read-only, non-vault, pathless and non-tool items", () => {
    const items: RenderItem[] = [
      write("r1", details({ action: "create" }), "running"),
      write("x1", details({ action: "append" }), "error"),
      write("rd1", details({ action: "read" })),
      write("b1", undefined),
      write("n1", details({ action: "edit", path: null })),
      { kind: "user", id: "u1", text: "omp-ui/A.md" },
    ];
    expect(touchedVaultNotes(items)).toEqual([]);
  });
});
