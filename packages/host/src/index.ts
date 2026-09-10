/**
 * The persistent host (issue #442; ADR-0029): the sole authoritative
 * composition root. `omp-ui serve` (cli-main.ts, bundled into the SEA) is the
 * one process that constructs `HostApplication`; this index exists for the
 * package's own tests and scripts — no other workspace depends on it.
 */
// application
export {
  HostApplication,
  omitUnless,
  type HostApplicationDeps,
  type HostPaths,
  type HostUpdateHandoverDeps,
} from "./host-application";
export { SessionManager, type SessionManagerDependencies } from "./session/session-manager";
export { gateSelector, NO_GATE, parseSpawnGate, type SpawnGate } from "./session/spawn-gate";
export { AttentionTracker, type AttentionSink } from "./session/trackers/attention-tracker";
export { readConfinedPlanFile, type ConfinedPlanRead } from "./verifier/plan-file";
export { OmpUpdater, type OmpUpdaterDeps } from "./update/omp-update";
// verifier
export {
  PlanVerifier,
  PLAN_VERIFY_TOTAL_DEADLINE_MS,
  type PlanVerifierDeps,
  type VerifierPage,
  type VerifyArgs,
  type VerifierHealth,
  type VerifyPhase,
} from "./verifier/plan-verifier";
export { PLAN_ARTIFACT_BYTE_LIMIT, PLAN_PREPARED_BYTE_LIMIT } from "./verifier/limits";
export { ChromeVerifierPage, type ChromeVerifierPageDeps } from "./verifier/chrome-verifier-page";
export { startVerifierOrigin, type VerifierOrigin } from "./verifier/static-origin";
export {
  resolveVerifierPayload,
  VERIFIER_BROWSER_ENV,
  type VerifierPayload,
  type VerifierUnavailable,
} from "./verifier/payload";
// control
export { startLocalControl, type LocalControl, type LocalControlDeps } from "./control/local-control";
// migration
export {
  MigrationConflict,
  MigrationJournal,
  migrationJournalPath,
  type ItemEvidence,
  type ItemStatus,
  type JournalStep,
  type JournalStepId,
} from "./migration/journal";
export {
  legacyUserDataDir,
  relocateAuthorityStores,
  RELOCATED_ITEMS,
  type GitResult,
  type RelocatedItem,
  type RelocateOptions,
} from "./migration/relocate";
export {
  handoffCredentials,
  type CredentialHandoffOptions,
  type ElectronBlobReader,
} from "./migration/credential-handoff";
export { consumeCutoverHandoff, type ConsumeCutoverDeps } from "./migration/cutover-handoff";
export {
  readElectronSafeStorage as readLinuxSafeStorage,
  LINUX_BASIC_PASSWORD,
  type LinuxSafeStorageDeps,
} from "./migration/linux-electron";
export {
  readElectronSafeStorage as readMacosSafeStorage,
  keychainSafeStoragePassword,
  MACOS_ITERATIONS,
  type MacosSafeStorageDeps,
  type SecurityExec,
} from "./migration/macos-electron";
export {
  readElectronSafeStorage as readWindowsSafeStorage,
  readLocalStateEncryptedKey,
  WINDOWS_KEY_PREFIX,
  type WindowsSafeStorageDeps,
} from "./migration/windows-electron";
// cli
export {
  defaultIsDesktopInstalled,
  defaultLaunchDesktop,
  desktopArtifactPath,
  EXIT,
  HELP as CLI_HELP,
  runCli,
  type CliDeps,
  type CliIo,
  type DesktopLaunchDeps,
  type ExitCode,
} from "./cli";
// credentials
export {
  CREDENTIAL_STORE_UNAVAILABLE,
  DekTimeout,
  HANDOFF_ENVELOPE_VERSION,
  HandoffIncomplete,
  HOST_ENVELOPE_VERSION,
  isHostEnvelope,
  KEY_LOST,
  openHostKeyCipher,
  raceDeadline,
  type DegradedCipher,
  type KeyProtector,
  type OpenHostKeyCipherOptions,
  type RunInWorker,
} from "./credentials/host-key-cipher";
export {
  DEK_WORKER_TIMEOUT_MS,
  runProtectorInWorker,
  type NativeBackend,
  type ProtectorOp,
  type ProtectorSpec,
  type WorkerEntry,
} from "./credentials/dek-worker";
export { selectProtector, type SelectProtectorDeps } from "./credentials/protector";
export {
  linuxSecretServiceProtector,
  SECRET_SCHEMA,
  type LinuxSecretServiceDeps,
  type SecretServiceAddon,
} from "./credentials/linux-secret-service";
export {
  KEYCHAIN_SERVICE,
  macosKeychainProtector,
  type EntryFactory,
  type KeychainEntry,
  type MacosKeychainDeps,
} from "./credentials/macos-keychain";
export {
  MASTER_KEY_FILE,
  windowsDpapiProtector,
  type DpapiBindings,
  type WindowsDpapiDeps,
} from "./credentials/windows-dpapi";
// authority
export {
  AuthorityConflict,
  claimAuthority,
  LOCK_ASSERT_INTERVAL_MS,
  LOCK_LOST_EXIT_CODE,
  type AuthorityConflictReason,
  type AuthorityDeps,
  type AuthorityToken,
  type ClaimedAuthority,
} from "./authority/authority";
export {
  acquireHostLock,
  lockPath,
  readOwnerRecord,
  type HostLock,
  type HostLockDeps,
  type OwnerRecordV1,
} from "./authority/lock";
export {
  ChildrenLedger,
  LedgerUnresolved,
  ledgerPath,
  type ChildEntry,
  type ChildrenLedgerDeps,
} from "./authority/children-ledger";
export {
  ownProcessStartMs,
  processAlive,
  readBootId,
  sameBoot,
  START_TIME_TOLERANCE_MS,
  type ProcessIdentityDeps,
  type ProcessLiveness,
} from "./authority/process-identity";
// supervisor
export {
  LAUNCHD_LABEL,
  LaunchdAgentSupervisor,
  selectSupervisor,
  SYSTEMD_UNIT_NAME,
  systemdRunArgs,
  SystemdUserSupervisor,
  WINDOWS_TASK_NAME,
  WindowsTaskSupervisor,
  type LaunchdDeps,
  type RenderOpts,
  type RunCommand,
  type RunResult,
  type Supervisor,
  type SupervisorDeps,
  type SupervisorFs,
  type SupervisorId,
  type SupervisorStatus,
  type SystemdDeps,
  type UninstallOpts,
  type WindowsTaskDeps,
} from "./supervisor";
// update
export {
  HOST_UPDATE_ACK_TIMEOUT_MS,
  HOST_UPDATE_DEFERRAL_CEILING_MS,
  HOST_UPDATE_DEFERRAL_LIMIT,
  HOST_UPDATE_GRACE_MS,
  HostUpdater,
  hostUpdatePaths,
  readHostUpdateDisk,
  type HostRelease,
  type HostUpdateDisk,
  type HostUpdateLimits,
  type HostUpdatePaths,
  type HostUpdaterDeps,
  type StagedHostChild,
} from "./update/host-update";
export {
  downloadHostArchive,
  fetchHostFeed,
  HOST_RELEASE_BASE,
  hostFeedName,
  normalizeSha512,
  parseHostFeed,
  sha512File,
  spawnStagedHost,
  switchCurrent,
  unpackHostArchive,
  type SpawnStagedDeps,
  type SwitchCurrentDeps,
} from "./update/host-update-deps";
// serve
export { serve, type ServeDeps, type ServeHandoverDeps, type ServeOptions } from "./serve";
