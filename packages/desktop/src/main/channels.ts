/** Channel map shared between main and preload (single source of truth). */
export const CH = {
  stateGet: "state:get",
  projectAdd: "project:add",
  projectRemove: "project:remove",
  projectSetAdvisor: "project:setAdvisor",
  settingsSetDefaultMode: "settings:setDefaultMode",
  sessionSpawn: "session:spawn",
  sessionTerminate: "session:terminate",
  sessionSwitchMode: "session:switchMode",
  sessionRemove: "session:remove",
  ptyWrite: "pty:write",
  ptyResize: "pty:resize",
  rpcSend: "rpc:send",
  ptyData: "pty:data",
  ptyExit: "pty:exit",
  rpcFrame: "rpc:frame",
  stateChanged: "state:changed",
} as const;
