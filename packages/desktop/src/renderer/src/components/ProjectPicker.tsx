import { useT } from "../lib/i18n";
import { useCompactShell } from "../lib/responsive";
import { findInstance, useStore } from "../store";
import { DirectoryPicker } from "./DirectoryPicker";

/** "Add project" (issue #16): the shared DirectoryPicker wired to the project registry. */
export function ProjectPicker() {
  const t = useT();
  const closeProjectPicker = useStore((s) => s.closeProjectPicker);
  const addProject = useStore((s) => s.addProject);
  const newSession = useStore((s) => s.newSession);
  // Registering on a joined remote instance (issue #416): the listing comes
  // from that host's filesystem and the registration lands in its registry.
  const instanceId = useStore((s) => s.projectPickerInstanceId);
  const nickname = useStore((s) =>
    s.projectPickerInstanceId === null ? null : (findInstance(s.state, s.projectPickerInstanceId)?.nickname ?? null),
  );
  const compact = useCompactShell();

  const submit = async (path: string): Promise<void> => {
    // Store closes the picker on success; compact registration continues into
    // a live session because a newly tracked project otherwise leaves a phone
    // at an empty shell. Desktop keeps registration and creation separate.
    await addProject(path, instanceId);
    if (compact) await newSession(path, undefined, instanceId);
  };

  return (
    <DirectoryPicker
      mode="project"
      instanceId={instanceId}
      banner={nickname === null ? null : t("remoteinstances.picker.title", { nickname })}
      onClose={closeProjectPicker}
      onSubmit={submit}
    />
  );
}
