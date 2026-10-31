/**
 * Credential protection for the headless lite fleet member (issue #1010):
 * a `LiteKeyCipher` over AES-256-GCM with a machine key sourced from an
 * operator key file, a (deferred) Linux Secret Service probe, or a 0600
 * `machine.key` under the data directory. No Electron, no native deps.
 */
export {
  LiteCipherIntegrityError,
  LiteCipherVersionError,
  LiteKeyCipher,
  LITE_KEY_BYTES,
  LITE_SEAL_PREFIX,
} from "./lite-key-cipher.js";
export {
  keyFileProtector,
  LITE_KEY_FILE_ENV,
  LiteKeyFileFormatError,
  LiteKeyFilePermissionError,
  machineKeyProtector,
  MACHINE_KEY_FILE,
  generateLiteMachineKey,
  openLiteKeyCipher,
  openLiteKeyCipherFor,
  selectLiteKeyProtector,
} from "./protector.js";
export type { LiteKeyProtector, SecretServiceProtector, SelectProtectorOptions } from "./protector.js";
export { LITE_SECRET_SCHEMA, probeLiteSecretService } from "./secret-service.js";
