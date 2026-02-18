/**
 * HappyClaw — OpenClaw slash command registration.
 *
 * Registers `/sessions-*` commands that let users control sessions
 * directly from TG/Discord without consuming agent tokens.
 *
 * These supplement (not replace) the existing session_* tools.
 */

import type { SessionManager } from './session-manager.js';
import type { AuditLogger } from './audit.js';
import type { TelegramPushAdapter } from './push/telegram-push-adapter.js';
import type { CallerContext, SessionMessage } from './types/index.js';
import { summarizeSession, formatSummaryText } from './summary.js';
import { parseCommand } from './commands.js';

// ---------------------------------------------------------------------------
// OpenClaw command types (minimal, avoid hard dependency)
// ---------------------------------------------------------------------------

interface PluginCommandContext {
  senderId?: string;
  channel: string;
  isAuthorizedSender: boolean;
  args?: string;
  commandBody: string;
}

interface PluginCommandResult {
  text?: string;
  isError?: boolean;
}

interface PluginCommandDefinition {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
}

interface CommandRegistrar {
  registerCommand: (command: PluginCommandDefinition) => void;
}

// ---------------------------------------------------------------------------
// Args parsing helpers
// ---------------------------------------------------------------------------

/**
 * Split args string by spaces, treating the rest after N tokens as one chunk.
 * e.g. splitArgs("abc ~/proj fix the bug", 2) => ["abc", "~/proj", "fix the bug"]
 */
function splitArgs(args: string, maxTokens: number): string[] {
  const trimmed = args.trim();
  if (!trimmed) return [];

  const result: string[] = [];
  let remaining = trimmed;

  for (let i = 0; i < maxTokens - 1; i++) {
    const spaceIdx = remaining.indexOf(' ');
    if (spaceIdx === -1) {
      result.push(remaining);
      return result;
    }
    result.push(remaining.slice(0, spaceIdx));
    remaining = remaining.slice(spaceIdx + 1).trimStart();
  }

  if (remaining) {
    result.push(remaining);
  }
  return result;
}

function callerFromCtx(ctx: PluginCommandContext): CallerContext {
  return {
    userId: ctx.senderId ?? 'anonymous',
    channelId: ctx.channel ?? 'unknown',
  };
}

function usage(command: string, args: string, description: string): PluginCommandResult {
  return { text: `Usage: /${command} ${args}\n${description}`, isError: true };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSessionCommands(
  api: CommandRegistrar,
  manager: SessionManager,
  audit: AuditLogger,
  pushAdapter?: TelegramPushAdapter,
): void {
  /** Fire-and-forget audit */
  const log = (
    userId: string,
    action: string,
    sessionId: string,
    details?: Record<string, unknown>,
  ) => {
    audit
      .log({ timestamp: Date.now(), userId, action, sessionId, details })
      .catch(() => {});
  };

  // /sessions-list
  api.registerCommand({
    name: 'sessions-list',
    description: 'List active AI CLI sessions',
    acceptsArgs: false,
    requireAuth: true,
    handler: (ctx) => {
      const caller = callerFromCtx(ctx);
      const sessions = manager
        .list()
        .filter((s) => manager.acl.canAccess(caller.userId, s.id));

      log(caller.userId, 'list', '*', { count: sessions.length });

      if (sessions.length === 0) {
        return { text: 'No active sessions. Use /sessions-spawn to start one.' };
      }

      const lines = sessions.map((s) => {
        const status = manager.getSwitchState(s.id);
        return `- ${s.id} | ${s.provider} | ${s.cwd} | ${s.mode} | ${status}`;
      });
      return { text: `Active sessions (${sessions.length}):\n${lines.join('\n')}` };
    },
  });

  // /sessions-spawn <provider> <cwd> <task...>
  api.registerCommand({
    name: 'sessions-spawn',
    description: 'Start a new AI CLI session',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const parts = splitArgs(ctx.args ?? '', 3);
      if (parts.length < 3) {
        return usage('sessions-spawn', '<provider> <cwd> <task...>', 'Example: /sessions-spawn claude ~/project fix the login bug');
      }

      const [provider, cwd, task] = parts;
      const caller = callerFromCtx(ctx);

      try {
        const session = await manager.spawn(
          provider,
          { cwd, mode: 'remote', initialPrompt: task },
          caller.userId,
        );

        pushAdapter?.bindSession(session.id);
        log(caller.userId, 'spawn', session.id, { provider, cwd });

        return {
          text: `Session started: ${session.id}\nProvider: ${session.provider} | CWD: ${session.cwd} | PID: ${session.pid}` +
            (pushAdapter ? '\nOutput will be pushed to Telegram.' : ''),
        };
      } catch (err) {
        return { text: `Spawn failed: ${(err as Error).message}`, isError: true };
      }
    },
  });

  // /sessions-resume <id> <task...>
  api.registerCommand({
    name: 'sessions-resume',
    description: 'Resume a stopped session',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const parts = splitArgs(ctx.args ?? '', 2);
      if (parts.length < 2) {
        return usage('sessions-resume', '<sessionId> <task...>', 'Example: /sessions-resume abc123 continue working on auth');
      }

      const [sessionId, task] = parts;
      const caller = callerFromCtx(ctx);

      try {
        manager.acl.assertOwner(caller.userId, sessionId);
        const session = await manager.resume(sessionId, {
          mode: 'remote',
          initialPrompt: task,
        });

        pushAdapter?.bindSession(session.id);
        log(caller.userId, 'resume', sessionId);

        return {
          text: `Session resumed: ${session.id}\nProvider: ${session.provider} | CWD: ${session.cwd}`,
        };
      } catch (err) {
        return { text: `Resume failed: ${(err as Error).message}`, isError: true };
      }
    },
  });

  // /sessions-send <id> <text...>
  api.registerCommand({
    name: 'sessions-send',
    description: 'Send input to a running session',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const parts = splitArgs(ctx.args ?? '', 2);
      if (parts.length < 2) {
        return usage('sessions-send', '<sessionId> <text...>', 'Example: /sessions-send abc123 run npm test');
      }

      const [sessionId, input] = parts;
      const caller = callerFromCtx(ctx);

      try {
        manager.acl.assertOwner(caller.userId, sessionId);
        const session = manager.get(sessionId);

        // Intercept slash commands (same as the tool)
        const cmdResult = await parseCommand(session, input);
        if (cmdResult.handled) {
          return { text: cmdResult.response ?? 'Command handled.' };
        }

        await session.send(input);
        log(caller.userId, 'send', sessionId);
        return { text: `Sent to ${sessionId}.` };
      } catch (err) {
        return { text: `Send failed: ${(err as Error).message}`, isError: true };
      }
    },
  });

  // /sessions-read <id>
  api.registerCommand({
    name: 'sessions-read',
    description: 'Read recent output from a session',
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => {
      const sessionId = (ctx.args ?? '').trim();
      if (!sessionId) {
        return usage('sessions-read', '<sessionId>', 'Example: /sessions-read abc123');
      }

      const caller = callerFromCtx(ctx);

      try {
        manager.acl.assertOwner(caller.userId, sessionId);
        const { messages } = manager.readMessages(sessionId, { limit: 20 });

        log(caller.userId, 'read', sessionId);

        if (messages.length === 0) {
          return { text: `No recent output from ${sessionId}.` };
        }

        const formatted = messages
          .map((m: SessionMessage) => `[${m.type}] ${m.content}`)
          .join('\n');
        return { text: `Output from ${sessionId} (${messages.length} messages):\n${formatted}` };
      } catch (err) {
        return { text: `Read failed: ${(err as Error).message}`, isError: true };
      }
    },
  });

  // /sessions-approve <id> <requestId>
  api.registerCommand({
    name: 'sessions-approve',
    description: 'Approve a permission request',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const parts = splitArgs(ctx.args ?? '', 2);
      if (parts.length < 2) {
        return usage('sessions-approve', '<sessionId> <requestId>', 'Example: /sessions-approve abc123 tool_xyz');
      }

      const [sessionId, requestId] = parts;
      const caller = callerFromCtx(ctx);

      try {
        manager.acl.assertOwner(caller.userId, sessionId);
        const session = manager.get(sessionId);
        await session.respondToPermission(requestId, true);
        log(caller.userId, 'respond', sessionId, { requestId, approved: true });
        return { text: `Approved: ${requestId}` };
      } catch (err) {
        return { text: `Approve failed: ${(err as Error).message}`, isError: true };
      }
    },
  });

  // /sessions-deny <id> <requestId>
  api.registerCommand({
    name: 'sessions-deny',
    description: 'Deny a permission request',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const parts = splitArgs(ctx.args ?? '', 2);
      if (parts.length < 2) {
        return usage('sessions-deny', '<sessionId> <requestId>', 'Example: /sessions-deny abc123 tool_xyz');
      }

      const [sessionId, requestId] = parts;
      const caller = callerFromCtx(ctx);

      try {
        manager.acl.assertOwner(caller.userId, sessionId);
        const session = manager.get(sessionId);
        await session.respondToPermission(requestId, false);
        log(caller.userId, 'respond', sessionId, { requestId, approved: false });
        return { text: `Denied: ${requestId}` };
      } catch (err) {
        return { text: `Deny failed: ${(err as Error).message}`, isError: true };
      }
    },
  });

  // /sessions-switch <id> <mode>
  api.registerCommand({
    name: 'sessions-switch',
    description: 'Switch session mode (local/remote)',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const parts = splitArgs(ctx.args ?? '', 2);
      if (parts.length < 2 || !['local', 'remote'].includes(parts[1])) {
        return usage('sessions-switch', '<sessionId> <local|remote>', 'Example: /sessions-switch abc123 local');
      }

      const [sessionId, mode] = parts;
      const caller = callerFromCtx(ctx);

      try {
        manager.acl.assertOwner(caller.userId, sessionId);
        await manager.switchMode(sessionId, mode as 'local' | 'remote');
        log(caller.userId, 'switch', sessionId, { mode });
        return { text: `Session ${sessionId} switched to ${mode} mode.` };
      } catch (err) {
        return { text: `Switch failed: ${(err as Error).message}`, isError: true };
      }
    },
  });

  // /sessions-stop <id> [--force]
  api.registerCommand({
    name: 'sessions-stop',
    description: 'Stop a running session',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const argsStr = (ctx.args ?? '').trim();
      if (!argsStr) {
        return usage('sessions-stop', '<sessionId> [--force]', 'Example: /sessions-stop abc123');
      }

      const parts = argsStr.split(/\s+/);
      const sessionId = parts[0];
      const force = parts.includes('--force');
      const caller = callerFromCtx(ctx);

      try {
        manager.acl.assertOwner(caller.userId, sessionId);
        await manager.stop(sessionId, force);
        pushAdapter?.unbindSession(sessionId);
        log(caller.userId, 'stop', sessionId, { force });
        return { text: `Session ${sessionId} stopped${force ? ' (forced)' : ''}.` };
      } catch (err) {
        return { text: `Stop failed: ${(err as Error).message}`, isError: true };
      }
    },
  });

  // /sessions-summary <id>
  api.registerCommand({
    name: 'sessions-summary',
    description: 'Get session summary (messages, tools, files, duration)',
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => {
      const sessionId = (ctx.args ?? '').trim();
      if (!sessionId) {
        return usage('sessions-summary', '<sessionId>', 'Example: /sessions-summary abc123');
      }

      const caller = callerFromCtx(ctx);

      try {
        manager.acl.assertOwner(caller.userId, sessionId);
        const { messages } = manager.readMessages(sessionId);
        const summary = summarizeSession(messages);
        log(caller.userId, 'summary', sessionId);
        return { text: formatSummaryText(summary) };
      } catch (err) {
        return { text: `Summary failed: ${(err as Error).message}`, isError: true };
      }
    },
  });
}
