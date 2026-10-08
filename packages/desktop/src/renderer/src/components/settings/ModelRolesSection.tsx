import { useState } from "react";
import type { ModelCatalogSnapshot, OmpSettingEntry, OmpSettingValue } from "@omp-ui/core/types";
import {
  OMP_JUDGE_ROLE_ID,
  OMP_MODEL_ROLE_IDS,
  OMP_MODEL_ROLES_KEY,
} from "@omp-ui/core/omp-settings-keys";
import { useStore } from "../../store";
import { displayMessage } from "../../backend";
import { useT } from "../../lib/i18n";
import { Button, Label } from "../ui";
import { ModelPalette } from "../ModelSelector";
import { JudgeRoleRow } from "./JudgeRoleRow";
import { CommitField, layerBadge } from "./rows";

type ChatCatalogLoad =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; snapshot: ModelCatalogSnapshot };

/**
 * The omp page's model-roles section: ten free-text chat-role rows plus the
 * catalog-backed judge row. Every chat row also browses (issue #797): the
 * palette lists the installed binary's `omp models --kind chat` catalog —
 * never a curated omp-ui list (ADR-0027 lineage) — so the model that names
 * new sessions (omp's tiny title chain) is picked instead of typed.
 *
 * `omp config set modelRoles` is REPLACE-not-merge: every pick merges against
 * the GLOBAL-layer record (never the effective value, so a project layer is
 * not baked into the global file) and posts the WHOLE record; a cleared role
 * simply omits its key. Picking from the palette emits a bare `provider/id`
 * and drops any existing `:level` suffix on that role — the text field stays
 * for suffixes and for values outside the catalog.
 */
export function ModelRolesSection({
  entry,
  pendingKey,
  commit,
}: {
  entry: OmpSettingEntry;
  pendingKey: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
}) {
  const t = useT();
  const readChatModels = useStore((s) => s.readChatModels);
  const [paletteRole, setPaletteRole] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ChatCatalogLoad>({ status: "idle" });
  // Merge against the record the page merged against before extraction
  // (REPLACE-not-merge: a partial post would delete every sibling role).
  const rolesRecord: Record<string, unknown> =
    typeof entry.value === "object" && entry.value !== null && !Array.isArray(entry.value)
      ? (entry.value as Record<string, unknown>)
      : {};

  const commitRole = (role: string, raw: string): void => {
    const next = raw.trim();
    const merged: Record<string, unknown> = { ...rolesRecord };
    if (next === "") delete merged[role];
    else merged[role] = next;
    commit(OMP_MODEL_ROLES_KEY, merged);
  };

  const browse = (role: string): void => {
    setPaletteRole(role);
    // One probe per mount-session, like the judge row's probe-per-open: the
    // catalog belongs to the installed omp binary and the provider keys.
    if (catalog.status === "idle") {
      setCatalog({ status: "loading" });
      readChatModels().then(
        (snapshot) => setCatalog({ status: "loaded", snapshot }),
        (err: unknown) =>
          setCatalog({
            status: "loaded",
            snapshot: { models: [], discovered: false, error: displayMessage(err) },
          }),
      );
    }
  };

  const pending = pendingKey === OMP_MODEL_ROLES_KEY;

  return (
    <section className="px-4 pt-3">
      <div className="flex items-center gap-2">
        <Label>{t("settings.omp.modelRoles")}</Label>
        {layerBadge(entry.layer)}
      </div>
      {entry.description !== "" && (
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
          {entry.description}
        </p>
      )}
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
        {t("settings.omp.modelRolesHint")}
      </p>
      <div className="mt-1.5 divide-y divide-line-soft">
        {OMP_MODEL_ROLE_IDS.map((role) => (
          <div key={role} className="flex items-center gap-3 py-1.5">
            <span className="w-20 shrink-0 font-mono text-[11px] text-ink-mid">
              {role}
            </span>
            <CommitField
              current={
                typeof rolesRecord[role] === "string" ? (rolesRecord[role] as string) : ""
              }
              kind="text"
              label={t("settings.omp.modelRoleLabel", { role })}
              placeholder={t("settings.omp.modelRolePlaceholder")}
              disabled={pending}
              className="flex-1"
              onCommit={(raw) => commitRole(role, raw)}
            />
            <Button size="xs" disabled={pending} onClick={() => browse(role)}>
              {t("settings.omp.modelRoleBrowse")}
            </Button>
          </div>
        ))}
        <JudgeRoleRow
          value={
            typeof rolesRecord[OMP_JUDGE_ROLE_ID] === "string"
              ? (rolesRecord[OMP_JUDGE_ROLE_ID] as string)
              : ""
          }
          pending={pending}
          onCommit={(raw) => commitRole(OMP_JUDGE_ROLE_ID, raw)}
        />
      </div>
      {paletteRole !== null && catalog.status === "loading" && (
        <p className="mt-1.5 text-[11px] text-ink-faint">{t("settings.omp.modelRoleReading")}</p>
      )}
      {paletteRole !== null &&
        catalog.status === "loaded" &&
        !catalog.snapshot.discovered && (
          <p className="mt-1.5 text-[11px] text-ink-faint">
            {t("settings.omp.modelRoleCatalogFailed", { message: catalog.snapshot.error ?? "" })}
          </p>
        )}
      {paletteRole !== null && catalog.status === "loaded" && catalog.snapshot.discovered && (
        <ModelPalette
          variant="subagent"
          instanceId={null}
          models={catalog.snapshot.models}
          current={
            typeof rolesRecord[paletteRole] === "string"
              ? (rolesRecord[paletteRole] as string)
              : null
          }
          allowInherit={false}
          onClose={() => setPaletteRole(null)}
          onPick={(selector) => {
            const role = paletteRole;
            setPaletteRole(null);
            commitRole(role, selector ?? "");
          }}
        />
      )}
    </section>
  );
}
