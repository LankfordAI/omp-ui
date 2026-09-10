/**
 * The persistent host (issue #442). Release P: the authoritative application
 * and its verifier are constructed by Electron main; `serve` is the host
 * binary's boot sequence, built and live-tested but wired to no shipped `bin`
 * until Release C.
 */
// application
export {
  HostApplication,
  IPC_CONNECTION_ID,
  omitUnless,
  type ClientAppUpdate,
  type ClientEffects,
  type DesktopClientFacts,
  type HostApplicationDeps,
  type HostPaths,
} from "./host-application";
export { SessionManager, type SessionManagerDependencies } from "./session/session-manager";
export { gateSelector, NO_GATE, parseSpawnGate, type SpawnGate } from "./session/spawn-gate";
export { AttentionTracker, type AttentionSink } from "./session/trackers/attention-tracker";
export { readConfinedPlanFile, type ConfinedPlanRead } from "./verifier/plan-file";
export { OmpUpdater, type OmpUpdaterDeps } from "./update/omp-update";
export { UpdateController, type UpdateControllerDeps } from "./update/update-controller";
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
export {
  deleteHostRecord,
  hostRecordPath,
  mintControlCredential,
  mintDesktopCredential,
  readHostRecord,
  writeHostRecord,
  type HostConnectionRecordV1,
} from "./control/connection-record";
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
export {
  consumeCutoverHandoff,
  cutoverHandoffPath,
  writeCutoverHandoff,
  CUTOVER_HANDOFF_MAX_AGE_MS,
  type ConsumeCutoverDeps,
  type CutoverHandoffV1,
} from "./migration/cutover-handoff";
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
  claimLegacyElectronAuthority,
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
// serve
export { serve, type ServeDeps, type ServeOptions } from "./serve";
