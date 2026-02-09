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
  PluginToolsOptions,
  SessionInfo,
  SessionListParams,
  SessionSpawnParams,
  SessionResumeParams,
  SessionSendParams,
  SessionReadParams,
  SessionRespondParams,
  SessionSwitchParams,
  SessionStopParams,
  SessionSummaryParams,
} from './plugin.js';

export { ClaudeSDKProvider } from './providers/index.js';
export { SessionACL, CwdWhitelist } from './security/index.js';
export { SessionPersistence } from './persistence.js';
export { EventBus } from './event-bus.js';
export type { EventBusOptions } from './event-bus.js';
export { HealthChecker } from './health.js';
export type { HealthCheckerOptions } from './health.js';
export { redactSensitive } from './redact.js';
export type { RedactionConfig, RedactionPattern } from './redact.js';
export { AuditLogger } from './audit.js';
export type { AuditEntry, AuditLoggerOptions, AuditReadOptions } from './audit.js';
export { summarizeSession, formatSummaryText } from './summary.js';
export type { SessionSummary } from './summary.js';
export { parseCommand, listCommands } from './commands.js';
export type { CommandResult } from './commands.js';
export {
  formatForTelegram,
  formatForDiscord,
  formatAsEmbed,
  formatPermissionEmbed,
} from './formatters/index.js';
export type { DiscordEmbed } from './formatters/index.js';

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

// OpenClaw plugin entry
export { default as happyclawPlugin } from './openclaw-plugin.js';
