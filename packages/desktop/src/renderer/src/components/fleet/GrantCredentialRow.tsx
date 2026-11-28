import { useState, type ReactNode } from "react";
import { Button, ChoiceCapsule } from "../ui";
import { SecretField } from "../settings/rows";

/**
 * The credential entry row every grant-raise surface shares (issue #1398):
 * secret-kind capsule, the secret field, and the submit/cancel buttons. The
 * secret lives only in this row's state and rides once into the caller's
 * submit — never stored, never prefilled. #1393's GrantRaiseCard can adopt
 * this instead of growing a third ceremony UI.
 */
export function GrantCredentialRow({
  kind,
  onKindChange,
  onSecretChange,
  onSubmit,
  onCancel,
  busy,
  canSubmit,
  submitLabel,
  children,
}: {
  kind: "password" | "token";
  onKindChange: (kind: "password" | "token") => void;
  onSecretChange: (secret: string) => void;
  onSubmit: (secret: string) => void;
  onCancel: () => void;
  busy: boolean;
  canSubmit: boolean;
  submitLabel: string;
  /** Extra controls between the capsule and the field (e.g. a rung capsule). */
  children?: ReactNode;
}) {
  const [secret, setSecret] = useState("");
  const submit = (): void => {
    const value = secret.trim();
    if (value === "" || busy) return;
    setSecret("");
    onSubmit(value);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {children}
      <ChoiceCapsule
        label="Sign in with"
        value={kind}
        options={[
          { value: "password", label: "Password" },
          { value: "token", label: "Access token" },
        ] as const}
        onChange={onKindChange}
        optionClassName="tab-label px-2"
      />
      <SecretField
        value={secret}
        label={kind === "token" ? "Access token" : "Password"}
        disabled={busy}
        className="min-w-[8rem] flex-1 basis-40"
        onChange={(value) => {
          setSecret(value);
          onSecretChange(value);
        }}
        onSave={submit}
      />
      <Button size="xs" variant="solid" disabled={!canSubmit || secret.trim() === "" || busy} onClick={submit}>
        {busy ? "Asking…" : submitLabel}
      </Button>
      <Button size="xs" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
