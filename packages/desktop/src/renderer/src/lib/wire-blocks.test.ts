import { describe, expect, it } from "vitest";
import { withArtifactReferenceContext, withArtifactRefreshContext } from "@omp-ui/core/artifact-references";
import type { ArtifactReference, ArtifactRefreshEntry } from "@omp-ui/core/artifacts";
import type { SessionReference } from "@omp-ui/core/types";
import { withAnnotationContext } from "./annotations";
import { splitWireBlockStack } from "./wire-blocks";
import { withSessionReferenceContext } from "./session-references";

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionRef: SessionReference = {
  sessionId: uuid(1),
  title: "Fix the deploy pipeline",
  machine: "austin-desktop",
  path: "/home/a/.omp/agent/sessions/lineage/x.jsonl",
};
const artifactRef: ArtifactReference = { version: 1, referenceId: uuid(2), ownerInstanceId: uuid(3), artifactId: uuid(4), codeRevisionId: uuid(5), dataSnapshotId: uuid(6), title: "Budget", machine: "desk-main", snapshotAt: "2026-11-09T06:00:00.000Z", includeData: false, manifestUri: `omp-ui://artifacts/reference/${uuid(2)}/manifest`, definitionUri: `omp-ui://artifacts/reference/${uuid(2)}/definition` };
const refresh: ArtifactRefreshEntry = { version: 1, refreshRequestId: uuid(7), artifactId: uuid(4), title: "Budget", datasetIds: ["rows"] };
const annotation = { quote: "q", comment: "c" };
/** `promptWireText`'s wrap order (session-params.ts): annotations innermost, refresh outermost. */
const fullStack = (message: string): string =>
  withArtifactRefreshContext(
    withSessionReferenceContext(
      withArtifactReferenceContext(withAnnotationContext(message, [annotation]), [artifactRef]),
      [sessionRef],
    ),
    [refresh],
  );

describe("splitWireBlockStack", () => {
  it("peels the whole composed stack in one pass leaving only prose", () => {
    expect(splitWireBlockStack(fullStack("refresh the numbers"))).toEqual({
      text: "refresh the numbers",
      refreshes: [refresh],
      references: [sessionRef],
      artifactReferences: [artifactRef],
      annotations: [annotation],
      legacyRefreshRequestId: null,
    });
  });

  it("leaves bare prose untouched", () => {
    expect(splitWireBlockStack("just words")).toEqual({
      text: "just words",
      refreshes: [],
      references: [],
      artifactReferences: [],
      annotations: [],
      legacyRefreshRequestId: null,
    });
  });

  it("peels a legacy refresh wire under a leading references block", () => {
    // The pre-ADR-0092 form wrapped its paragraph and terminal block INSIDE
    // the references blocks; the end-anchored legacy peel runs after the
    // reference peels, so this composition recognizes both halves at once.
    const legacy = `Refresh the requested datasets for this accepted artifact in this ordinary session.\nrows\ntotals\n<artifact refresh>\nrefresh-request: ${uuid(7)}\n</artifact refresh>`;
    expect(splitWireBlockStack(withSessionReferenceContext(withArtifactReferenceContext(legacy, [artifactRef]), [sessionRef]))).toEqual({
      text: "",
      refreshes: [],
      references: [sessionRef],
      artifactReferences: [artifactRef],
      annotations: [],
      legacyRefreshRequestId: uuid(7),
    });
  });

  it("recognizes a bare legacy wire with no blocks around it", () => {
    const legacy = `Refresh the requested datasets for this accepted artifact in this ordinary session.\nrows\n<artifact refresh>\nrefresh-request: ${uuid(7)}\n</artifact refresh>`;
    expect(splitWireBlockStack(legacy).legacyRefreshRequestId).toBe(uuid(7));
  });

  it("keeps a refresh lookalike typed mid-message as prose", () => {
    const block = withArtifactRefreshContext("", [refresh]);
    const text = `quoting ${block} back to you`;
    expect(splitWireBlockStack(text).text).toBe(text);
  });

  it("keeps every misplaced or half-formed block as prose", () => {
    const refreshBlock = withArtifactRefreshContext("", [refresh]);
    const refBlock = withArtifactReferenceContext("", [artifactRef]);
    const sessionBlock = withSessionReferenceContext("", [sessionRef]);
    const legacyHalf = `<artifact refresh>\nrefresh-request: ${uuid(7)}\n</artifact refresh>`;
    for (const text of [
      `intro\n\n${refreshBlock}`,
      // A block glued to trailing text never parses as a leading block.
      `${refBlock}trailing`,
      // A renamed field defeats the block's own parse.
      refBlock.replace("  owner: ", "  who: "),
      // A swapped hint line is not a grammar the splitter recognizes.
      refreshBlock.replace(/The user requested[^\n]*/, "something else"),
      "<artifact refresh>\nnever closed",
      `intro\n\n${refBlock}`,
      `intro\n\n${sessionBlock}`,
      // Legacy halves alone stay prose; only paragraph-plus-terminal pairs.
      legacyHalf,
      "Refresh the requested datasets for this accepted artifact in this ordinary session.\nand nothing else",
      // An old-form paragraph that trails other prose stays prose too.
      `note\n\nRefresh the requested datasets for this accepted artifact in this ordinary session.\n${legacyHalf}`,
    ]) {
      expect(splitWireBlockStack(text)).toEqual({
        text,
        refreshes: [],
        references: [],
        artifactReferences: [],
        annotations: [],
        legacyRefreshRequestId: null,
      });
    }
  });
});
