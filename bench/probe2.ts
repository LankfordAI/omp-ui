import { Registry, ProviderKeys, resolveOmpBinary } from "@omp-ui/core";
import { SessionManager } from "../packages/desktop/src/main/session-manager";
import { parseSpawnGate } from "../packages/desktop/src/main/spawn-gate";
console.log(typeof Registry, typeof resolveOmpBinary, typeof SessionManager, typeof parseSpawnGate);
