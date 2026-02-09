/**
 * HappyClaw — OpenClaw Session Bridge Plugin entry point.
 *
 * Creates and wires the SessionManager, providers, and plugin tools.
 */

export { SessionManager } from './session-manager.js';
export type { SessionManagerOptions } from './session-manager.js';

export { createPluginTools } from './plugin.js';
export type {
  PluginTool,
  SessionInfo,
  SessionListParams,
  SessionSpawnParams,
  SessionResumeParams,
  SessionSendParams,
  SessionReadParams,
  SessionRespondParams,
  SessionSwitchParams,
  SessionStopParams,
} from './plugin.js';

export { ClaudeSDKProvider } from './providers/index.js';
export { SessionACL, CwdWhitelist } from './security/index.js';
export { SessionPersistence } from './persistence.js';
export { EventBus } from './event-bus.js';
export type { EventBusOptions } from './event-bus.js';
export { parseCommand, listCommands } from './commands.js';
export type { CommandResult } from './commands.js';
export { formatForTelegram, formatForDiscord } from './formatters/index.js';

// Re-export core types
export type {
  SessionMode,
  SessionMessage,
  SessionMessageType,
  SessionEvent,
  SessionEventType,
  SessionEventSeverity,
  SessionProvider,
  ProviderSession,
  SpawnOptions,
  CallerContext,
  ReadResult,
  SwitchState,
  PersistedSession,
  PermissionDetail,
  EventHandler,
  MessageHandler,
} from './types/index.js';

export { AsyncQueue } from './types/index.js';
