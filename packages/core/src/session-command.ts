export interface SessionCommandDescriptor {
  lateAck: boolean;
}

/** One policy owner for every renderer-issued rpc session command. */
export const SESSION_COMMANDS = {
  prompt: { lateAck: false },
  abort: { lateAck: true },
  abort_and_prompt: { lateAck: true },
  compact: { lateAck: true },
  handoff: { lateAck: true },
  export_html: { lateAck: true },
  login: { lateAck: true },
  new_session: { lateAck: true },
  switch_session: { lateAck: true },
  branch: { lateAck: true },
  set_model: { lateAck: true },
  cycle_model: { lateAck: true },
  get_available_models: { lateAck: true },
  bash: { lateAck: true },
  get_state: { lateAck: false },
  get_messages: { lateAck: false },
  get_available_commands: { lateAck: false },
  get_session_stats: { lateAck: false },
  get_subagents: { lateAck: false },
  get_subagent_messages: { lateAck: false },
  set_subagent_subscription: { lateAck: false },
  set_thinking_level: { lateAck: false },
  set_steering_mode: { lateAck: false },
  set_follow_up_mode: { lateAck: false },
  set_interrupt_mode: { lateAck: false },
  set_auto_compaction: { lateAck: false },
  set_auto_retry: { lateAck: false },
  abort_retry: { lateAck: false },
  set_session_name: { lateAck: false },
  set_todos: { lateAck: false },
} as const satisfies Record<string, SessionCommandDescriptor>;

export type SessionCommandType = keyof typeof SESSION_COMMANDS;
export type SessionCommand = { type: SessionCommandType } & Record<string, unknown>;

export function sessionCommandHasLateAck(type: SessionCommandType): boolean {
  return SESSION_COMMANDS[type].lateAck;
}
