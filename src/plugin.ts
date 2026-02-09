/**
 * HappyClaw Plugin tools — OpenClaw session.* tool handlers.
 *
 * Each handler receives CallerContext (injected by OpenClaw Gateway)
 * and validates ownership via SessionACL before performing operations.
 *
 * Phase 2 enhancements:
 * - Enriched SessionInfo with runtime, status, lastActivity
 * - Slash command interception in session.send
 * - Multi-session selection hints
 *
 * Reference: docs/technical-proposal.md §3.4, §3.5
 */

import type { SessionManager } from './session-manager.js';
import type {
  CallerContext,
  SessionMode,
  SwitchState,
} from './types/index.js';
import { parseCommand } from './commands.js';

// ---------------------------------------------------------------------------
// Tool parameter / result types
// ---------------------------------------------------------------------------

export interface SessionListParams {
  cwd?: string;
  provider?: string;
}

export interface SessionSpawnParams {
  provider: string;
  cwd: string;
  mode?: SessionMode;
}

export interface SessionResumeParams {
  sessionId: string;
  mode?: SessionMode;
}

export interface SessionSendParams {
  sessionId: string;
  input: string;
}

export interface SessionReadParams {
  sessionId: string;
  cursor?: string;
  limit?: number;
}

export interface SessionRespondParams {
  sessionId: string;
  requestId: string;
  approved: boolean;
}

export interface SessionSwitchParams {
  sessionId: string;
  mode: SessionMode;
}

export interface SessionStopParams {
  sessionId: string;
  force?: boolean;
}

export interface SessionInfo {
  id: string;
  provider: string;
  cwd: string;
  mode: SessionMode;
  pid: number;
  /** Switch state (running, draining, switching, error) */
  status?: SwitchState;
  /** Session runtime in seconds (if known) */
  runtimeSeconds?: number;
  /** Timestamp of last message activity (if known) */
  lastActivity?: number;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export interface PluginTool<P, R> {
  description: string;
  handler: (params: P, caller: CallerContext) => Promise<R>;
}

/**
 * Create the session.* plugin tools bound to a SessionManager instance.
 */
export function createPluginTools(manager: SessionManager) {
  return {
    'session.list': {
      description: 'List active AI CLI sessions on this machine',
      handler: async (
        params: SessionListParams,
        caller: CallerContext,
      ): Promise<SessionInfo[]> => {
        const sessions = manager
          .list({ cwd: params.cwd, provider: params.provider })
          .filter((s) => manager.acl.canAccess(caller.userId, s.id));

        return sessions.map((s) => ({
          id: s.id,
          provider: s.provider,
          cwd: s.cwd,
          mode: s.mode,
          pid: s.pid,
          status: manager.getSwitchState(s.id),
          lastActivity: manager.getLastActivity(s.id),
        }));
      },
    } satisfies PluginTool<SessionListParams, SessionInfo[]>,

    'session.spawn': {
      description: 'Start a new AI CLI session',
      handler: async (
        params: SessionSpawnParams,
        caller: CallerContext,
      ): Promise<SessionInfo> => {
        const session = await manager.spawn(
          params.provider,
          { cwd: params.cwd, mode: params.mode ?? 'remote' },
          caller.userId,
        );

        return {
          id: session.id,
          provider: session.provider,
          cwd: session.cwd,
          mode: session.mode,
          pid: session.pid,
        };
      },
    } satisfies PluginTool<SessionSpawnParams, SessionInfo>,

    'session.resume': {
      description: 'Resume an existing CLI session (loads conversation history via --resume)',
      handler: async (
        params: SessionResumeParams,
        caller: CallerContext,
      ): Promise<SessionInfo> => {
        manager.acl.assertOwner(caller.userId, params.sessionId);

        const session = await manager.resume(params.sessionId, {
          mode: params.mode ?? 'remote',
        });

        return {
          id: session.id,
          provider: session.provider,
          cwd: session.cwd,
          mode: session.mode,
          pid: session.pid,
        };
      },
    } satisfies PluginTool<SessionResumeParams, SessionInfo>,

    'session.send': {
      description: 'Send input to a CLI session (slash commands like /clear, /compact, /cost are intercepted)',
      handler: async (
        params: SessionSendParams,
        caller: CallerContext,
      ): Promise<{ handled: boolean; response?: string }> => {
        manager.acl.assertOwner(caller.userId, params.sessionId);
        const session = manager.get(params.sessionId);

        // Intercept slash commands
        const cmdResult = await parseCommand(session, params.input);
        if (cmdResult.handled) {
          return cmdResult;
        }

        // Regular input — forward to session
        await session.send(params.input);
        return { handled: false };
      },
    } satisfies PluginTool<SessionSendParams, { handled: boolean; response?: string }>,

    'session.read': {
      description: 'Read CLI session output (supports cursor pagination)',
      handler: async (
        params: SessionReadParams,
        caller: CallerContext,
      ) => {
        manager.acl.assertOwner(caller.userId, params.sessionId);
        return manager.readMessages(params.sessionId, {
          cursor: params.cursor,
          limit: params.limit,
        });
      },
    } satisfies PluginTool<SessionReadParams, { messages: unknown[]; nextCursor: string }>,

    'session.respond': {
      description: 'Respond to a permission confirmation request',
      handler: async (
        params: SessionRespondParams,
        caller: CallerContext,
      ): Promise<void> => {
        manager.acl.assertOwner(caller.userId, params.sessionId);
        const session = manager.get(params.sessionId);
        await session.respondToPermission(params.requestId, params.approved);
      },
    } satisfies PluginTool<SessionRespondParams, void>,

    'session.switch': {
      description: 'Switch session between local and remote modes',
      handler: async (
        params: SessionSwitchParams,
        caller: CallerContext,
      ): Promise<void> => {
        manager.acl.assertOwner(caller.userId, params.sessionId);
        await manager.switchMode(params.sessionId, params.mode);
      },
    } satisfies PluginTool<SessionSwitchParams, void>,

    'session.stop': {
      description: 'Stop a CLI session',
      handler: async (
        params: SessionStopParams,
        caller: CallerContext,
      ): Promise<void> => {
        manager.acl.assertOwner(caller.userId, params.sessionId);
        await manager.stop(params.sessionId, params.force);
      },
    } satisfies PluginTool<SessionStopParams, void>,
  };
}
