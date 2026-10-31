/**
 * Fleet member legs for the headless lite host (issue #1010): the channel
 * wiring a composition root merges into its ChannelTable, the seam
 * interfaces it injects, and the production adapters (the single
 * TODO_INTEGRATION file) that build those seams on plain node plus the
 * electron-free desktop fleet modules.
 */
export { registerFleetLegs } from "./register-fleet-legs.js";
export type {
  FleetExecCommandSpec,
  FleetExecLegs,
  FleetHostReportLegs,
  FleetLegsDeps,
  FleetLegsHandle,
  FleetLegsRegistry,
  FleetLegsSettingKey,
  FleetLegsSettings,
  FleetProjectLegs,
  FleetProviderKeyLegs,
  FleetSessionLegs,
  FleetTerminalLegs,
} from "./types.js";
