/**
 * HappyClaw — OpenClaw Plugin Entry Point.
 *
 * Bridges AI CLI sessions (Claude Code, Codex) into OpenClaw's tool system,
 * enabling mobile control from Telegram or Discord.
 *
 * Install: openclaw plugins install --link /path/to/happyclaw
 *
 * Reference: docs/technical-proposal.md
 */

import { Type } from '@sinclair/typebox';
import { SessionManager } from './session-manager.js';
import { ClaudeSDKProvider, CodexMCPProvider } from './providers/index.js';
import { EventBus } from './event-bus.js';
import { AuditLogger } from './audit.js';
import { HealthChecker } from './health.js';
import { TelegramPushAdapter } from './push/telegram-push-adapter.js';
import { summarizeSession, formatSummaryText } from './summary.js';
import { parseCommand } from './commands.js';
import type { CallerContext, SessionMessage } from './types/index.js';

// ---------------------------------------------------------------------------
// Minimal OpenClaw Plugin SDK types (avoid hard dependency on openclaw)
// ---------------------------------------------------------------------------

interface OpenClawPluginApi {
  id: string;
  name: string;
  pluginConfig?: Record<string, unknown>;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  registerTool: (
    tool: unknown,
    opts?: { optional?: boolean; name?: string },
  ) => void;
  on: (
    hookName: string,
    handler: (...args: unknown[]) => void,
  ) => void;
}

interface OpenClawPluginToolContext {
  agentAccountId?: string;
  messageChannel?: string;
  workspaceDir?: string;
  agentId?: string;
  sessionKey?: string;
  sandboxed?: boolean;
}

// ---------------------------------------------------------------------------
// Tool result helper
// ---------------------------------------------------------------------------

function textResult(data: unknown) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const happyclawPlugin = {
  id: 'happyclaw',
  name: 'HappyClaw',
  description:
    'AI CLI session bridge — spawn, control, and switch between Claude/Codex sessions from Telegram or Discord.',

  register(api: OpenClawPluginApi) {
    const logger = api.logger;
    const config = api.pluginConfig ?? {};

    // --- Shared infrastructure ---
    const manager = new SessionManager({
      maxSessions: (config.maxSessions as number) ?? 10,
      cwdWhitelist: (config.cwdWhitelist as string[]) ?? [],
      headless: true, // OpenClaw gateway is always headless
    });

    // Register available providers
    try {
      manager.registerProvider(new ClaudeSDKProvider());
      logger.info('Registered Claude SDK provider');
    } catch (err) {
      logger.warn(`Failed to register Claude SDK provider: ${err}`);
    }

    try {
      manager.registerProvider(new CodexMCPProvider());
      logger.info('Registered Codex MCP provider');
    } catch (err) {
      logger.warn(`Failed to register Codex MCP provider: ${err}`);
    }

    // EventBus for event batching/routing
    const eventBus = new EventBus();
    manager.on('event', (event) => eventBus.publish(event));

    // Audit logger
    const auditLogger = new AuditLogger();

    // Health checker
    const healthChecker = new HealthChecker(manager, { intervalMs: 30_000 });
    healthChecker.start();

    // Telegram push adapter (direct push, zero agent token)
    let pushAdapter: TelegramPushAdapter | undefined;
    const tgBotToken = config.telegramBotToken as string | undefined;
    const tgChatId = config.telegramDefaultChatId as string | undefined;

    if (tgBotToken && tgChatId) {
      pushAdapter = new TelegramPushAdapter(
        {
          botToken: tgBotToken,
          defaultChatId: tgChatId,
          debounceMs: (config.telegramDebounceMs as number) ?? 1500,
        },
        logger,
      );

      // Wire: SessionManager messages → push adapter
      manager.on('message', (sessionId: string, msg: SessionMessage) => {
        pushAdapter!.handleMessage(sessionId, msg);
      });

      // Wire: EventBus events → push adapter
      eventBus.subscribeAll((events) => {
        pushAdapter!.handleEvents(events);
      });

      logger.info(
        `Telegram push enabled → chat ${tgChatId}`,
      );
    }

    // --- Register tools via factory (captures per-agent caller context) ---
    api.registerTool(
      (ctx: OpenClawPluginToolContext) => {
        const caller: CallerContext = {
          userId: ctx.agentAccountId ?? 'anonymous',
          channelId: ctx.messageChannel ?? 'unknown',
        };
        return createOpenClawTools(manager, auditLogger, caller, pushAdapter);
      },
    );

    // --- Block exec/process for Claude/Codex CLI (force session_* usage) ---
    // OpenClaw hook event shape: { toolName: string, params: Record<string, unknown> }
    // Return shape: { block?: boolean, blockReason?: string, params?: Record<string, unknown> }
    api.on('before_tool_call', (event: unknown) => {
      const e = event as {
        toolName?: string;
        params?: Record<string, unknown>;
      };
      const toolName = e?.toolName;
      const params = e?.params ?? {};

      if (toolName === 'exec') {
        const cmd = String(params.command ?? params.cmd ?? '').trim();
        if (/^(claude|codex)\b/i.test(cmd)) {
          logger.warn(
            `Blocked exec("${cmd.slice(0, 80)}") — use session_spawn instead`,
          );
          return {
            block: true,
            blockReason:
              'Blocked: do not use exec to start Claude/Codex CLI. ' +
              'Use session_spawn(provider, cwd) from the HappyClaw plugin instead. ' +
              'See the happyclaw-sessions skill for details.',
          };
        }
      }

      if (toolName === 'process') {
        const pid = params.pid ?? params.processId;
        const action = String(params.action ?? '').toLowerCase();
        if (pid && ['write', 'poll', 'kill', 'log'].includes(action)) {
          logger.info(
            `Hint: prefer session_send/read/stop over process(${action})`,
          );
        }
      }
    });

    // --- Cleanup on gateway shutdown ---
    api.on('gateway_stop', async () => {
      healthChecker.stop();
      pushAdapter?.dispose();
      eventBus.dispose();
      const sessions = manager.list();
      for (const session of sessions) {
        try {
          await manager.stop(session.id);
        } catch {
          // best effort
        }
      }
      logger.info('HappyClaw shutdown complete');
    });

    logger.info('HappyClaw plugin registered');
  },
};

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

function createOpenClawTools(
  manager: SessionManager,
  audit: AuditLogger,
  caller: CallerContext,
  pushAdapter?: TelegramPushAdapter,
) {
  /** Fire-and-forget audit */
  const log = (
    action: string,
    sessionId: string,
    details?: Record<string, unknown>,
  ) => {
    audit
      .log({
        timestamp: Date.now(),
        userId: caller.userId,
        action,
        sessionId,
        details,
      })
      .catch(() => {});
  };

  return [
    // session_list
    {
      name: 'session_list',
      label: 'List AI sessions',
      description:
        'List active AI CLI sessions. Returns session ID, provider, working directory, mode, and status.',
      parameters: Type.Object({
        cwd: Type.Optional(
          Type.String({ description: 'Filter by working directory' }),
        ),
        provider: Type.Optional(
          Type.String({
            description: 'Filter by provider name (claude, codex)',
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const sessions = manager
          .list({
            cwd: params.cwd as string | undefined,
            provider: params.provider as string | undefined,
          })
          .filter((s) => manager.acl.canAccess(caller.userId, s.id));

        const result = sessions.map((s) => ({
          id: s.id,
          provider: s.provider,
          cwd: s.cwd,
          mode: s.mode,
          pid: s.pid,
          status: manager.getSwitchState(s.id),
          lastActivity: manager.getLastActivity(s.id),
        }));

        log('list', '*', { count: result.length });

        if (result.length === 0) {
          return textResult(
            'No active sessions. Use session_spawn to start one.',
          );
        }
        return textResult(result);
      },
    },

    // session_spawn
    {
      name: 'session_spawn',
      label: 'Start AI session',
      description:
        'Start a new AI CLI session. Specify provider, working directory, and task. ' +
        'The task is sent immediately so Claude starts working right away.',
      parameters: Type.Object({
        provider: Type.String({
          description: 'Provider name: "claude" or "codex"',
        }),
        cwd: Type.String({
          description: 'Working directory for the session',
        }),
        task: Type.String({
          description:
            'Initial task/prompt to send to the session. Required to start the session.',
        }),
        mode: Type.Optional(
          Type.String({
            description: 'Session mode: "remote" (default) or "local"',
          }),
        ),
        permissionMode: Type.Optional(
          Type.String({
            description:
              'Permission mode. For Claude: SDK permissionMode. ' +
              'For Codex: maps to approval-policy + sandbox execution policy ' +
              '(default→untrusted+workspace-write, bypassPermissions→never+danger-full-access, ' +
              'acceptEdits→on-request+workspace-write, plan→untrusted+read-only). ' +
              'Values: "default", "bypassPermissions", "acceptEdits", "plan", "dontAsk".',
          }),
        ),
        model: Type.Optional(
          Type.String({
            description:
              'Claude model to use, e.g. "claude-sonnet-4-5-20250929", "claude-opus-4-20250514"',
          }),
        ),
        maxTurns: Type.Optional(
          Type.Number({
            description: 'Max conversation turns before stopping (default: no limit)',
          }),
        ),
        maxBudgetUsd: Type.Optional(
          Type.Number({
            description: 'Max budget in USD before stopping (default: no limit)',
          }),
        ),
        allowedTools: Type.Optional(
          Type.Array(Type.String(), {
            description:
              'Tool names to auto-allow without permission prompts (e.g. ["Bash","Edit","Write"])',
          }),
        ),
        disallowedTools: Type.Optional(
          Type.Array(Type.String(), {
            description:
              'Tool names to completely disallow (e.g. ["WebFetch"])',
          }),
        ),
        continueSession: Type.Optional(
          Type.Boolean({
            description:
              'Continue the most recent conversation in cwd instead of starting fresh (default: false)',
          }),
        ),
        additionalDirectories: Type.Optional(
          Type.Array(Type.String(), {
            description:
              'Additional absolute directory paths Claude can access beyond cwd',
          }),
        ),
        agent: Type.Optional(
          Type.String({
            description:
              'Agent name for the main thread (must be defined in agents param or in settings)',
          }),
        ),
        agents: Type.Optional(
          Type.Unsafe({
            type: 'object',
            description: 'Programmatic sub-agent definitions keyed by name',
            additionalProperties: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                prompt: { type: 'string' },
                tools: { type: 'array', items: { type: 'string' } },
                disallowedTools: { type: 'array', items: { type: 'string' } },
                model: { type: 'string' },
                maxTurns: { type: 'number' },
              },
              required: ['description', 'prompt'],
            },
          }),
        ),
        mcpServers: Type.Optional(
          Type.Unsafe({
            type: 'object',
            description:
              'MCP server configs keyed by name. stdio: {command,args,env} or http: {type:"http",url}',
            additionalProperties: {
              type: 'object',
              properties: {
                command: { type: 'string' },
                args: { type: 'array', items: { type: 'string' } },
                env: { type: 'object', additionalProperties: { type: 'string' } },
                type: { type: 'string' },
                url: { type: 'string' },
              },
            },
          }),
        ),
        plugins: Type.Optional(
          Type.Array(Type.Object({
            type: Type.Literal('local'),
            path: Type.String(),
          }), {
            description:
              'Plugins to load, e.g. [{"type":"local","path":"./my-plugin"}]',
          }),
        ),
        enableFileCheckpointing: Type.Optional(
          Type.Boolean({
            description:
              'Enable file checkpointing — allows rewinding files to previous state (default: false)',
          }),
        ),
        sandbox: Type.Optional(
          Type.Object({
            enabled: Type.Optional(Type.Boolean()),
            autoAllowBashIfSandboxed: Type.Optional(Type.Boolean()),
            network: Type.Optional(Type.Object({
              allowedDomains: Type.Optional(Type.Array(Type.String())),
              allowLocalBinding: Type.Optional(Type.Boolean()),
            })),
          }, {
            description:
              'Sandbox settings for command execution isolation',
          }),
        ),
        debug: Type.Optional(
          Type.Boolean({
            description: 'Enable verbose debug logging',
          }),
        ),
        debugFile: Type.Optional(
          Type.String({
            description: 'Write debug logs to this file path',
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const session = await manager.spawn(
          params.provider as string,
          {
            cwd: params.cwd as string,
            mode: (params.mode as 'local' | 'remote') ?? 'remote',
            initialPrompt: params.task as string,
            permissionMode: params.permissionMode as string | undefined,
            model: params.model as string | undefined,
            maxTurns: params.maxTurns as number | undefined,
            maxBudgetUsd: params.maxBudgetUsd as number | undefined,
            allowedTools: params.allowedTools as string[] | undefined,
            disallowedTools: params.disallowedTools as string[] | undefined,
            continueSession: params.continueSession as boolean | undefined,
            additionalDirectories: params.additionalDirectories as string[] | undefined,
            agent: params.agent as string | undefined,
            agents: params.agents as Record<string, unknown> | undefined,
            mcpServers: params.mcpServers as Record<string, unknown> | undefined,
            plugins: params.plugins as Array<{ type: 'local'; path: string }> | undefined,
            enableFileCheckpointing: params.enableFileCheckpointing as boolean | undefined,
            sandbox: params.sandbox as Record<string, unknown> | undefined,
            debug: params.debug as boolean | undefined,
            debugFile: params.debugFile as string | undefined,
          },
          caller.userId,
        );

        // Bind push adapter so Claude output goes directly to TG
        pushAdapter?.bindSession(session.id);

        log('spawn', session.id, {
          provider: params.provider,
          cwd: params.cwd,
        });
        return textResult({
          id: session.id,
          provider: session.provider,
          cwd: session.cwd,
          mode: session.mode,
          pid: session.pid,
          pushEnabled: !!pushAdapter,
          message: pushAdapter
            ? 'Session started. Claude output will be pushed directly to Telegram.'
            : 'Session started. Use session_send to interact.',
        });
      },
    },

    // session_resume
    {
      name: 'session_resume',
      label: 'Resume AI session',
      description:
        'Resume an existing CLI session that was previously stopped or paused. ' +
        'Provide a task/prompt so the SDK stream starts immediately.',
      parameters: Type.Object({
        sessionId: Type.String({ description: 'Session ID to resume' }),
        task: Type.String({
          description:
            'Prompt to send immediately upon resume so the SDK stream starts.',
        }),
        mode: Type.Optional(
          Type.String({
            description: 'Session mode: "remote" (default) or "local"',
          }),
        ),
        permissionMode: Type.Optional(
          Type.String({
            description:
              'Permission mode: "default", "bypassPermissions", "acceptEdits", "plan", or "dontAsk"',
          }),
        ),
        model: Type.Optional(
          Type.String({
            description: 'Claude model to use',
          }),
        ),
        forkSession: Type.Optional(
          Type.Boolean({
            description: 'Fork to a new session ID instead of continuing the same one (default: false)',
          }),
        ),
        debug: Type.Optional(
          Type.Boolean({
            description: 'Enable verbose debug logging',
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const sessionId = params.sessionId as string;
        manager.acl.assertOwner(caller.userId, sessionId);

        const session = await manager.resume(sessionId, {
          mode: (params.mode as 'local' | 'remote') ?? 'remote',
          permissionMode: params.permissionMode as string | undefined,
          model: params.model as string | undefined,
          initialPrompt: params.task as string,
        });

        pushAdapter?.bindSession(session.id);

        log('resume', sessionId);
        return textResult({
          id: session.id,
          provider: session.provider,
          cwd: session.cwd,
          mode: session.mode,
          pid: session.pid,
          pushEnabled: !!pushAdapter,
          message: 'Session resumed.',
        });
      },
    },

    // session_send
    {
      name: 'session_send',
      label: 'Send to AI session',
      description:
        'Send input text to a running AI CLI session. Slash commands (/clear, /compact, /cost) are intercepted.',
      parameters: Type.Object({
        sessionId: Type.String({ description: 'Target session ID' }),
        input: Type.String({ description: 'Text to send to the session' }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const sessionId = params.sessionId as string;
        manager.acl.assertOwner(caller.userId, sessionId);
        const session = manager.get(sessionId);

        // Intercept slash commands
        const cmdResult = await parseCommand(session, params.input as string);
        if (cmdResult.handled) {
          return textResult({
            handled: true,
            response: cmdResult.response,
          });
        }

        await session.send(params.input as string);
        log('send', sessionId);
        return textResult({
          handled: false,
          message: 'Input sent to session.',
        });
      },
    },

    // session_read
    {
      name: 'session_read',
      label: 'Read AI session output',
      description:
        'Read output from a CLI session. Supports cursor-based pagination. ' +
        'Set wait=true to block until new messages arrive or timeout.',
      parameters: Type.Object({
        sessionId: Type.String({ description: 'Session ID to read from' }),
        cursor: Type.Optional(
          Type.String({
            description: 'Pagination cursor from previous read',
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: 'Maximum messages to return (default: 50)',
          }),
        ),
        wait: Type.Optional(
          Type.Boolean({
            description:
              'Block until new messages arrive or timeout (default: false)',
          }),
        ),
        timeout: Type.Optional(
          Type.Number({
            description:
              'Wait timeout in ms (default: 30000, min: 1000, max: 120000). Only used when wait=true.',
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const sessionId = params.sessionId as string;
        manager.acl.assertOwner(caller.userId, sessionId);

        const wait = params.wait as boolean | undefined;
        const readOpts = {
          cursor: params.cursor as string | undefined,
          limit: params.limit as number | undefined,
        };

        let result;
        let timedOut = false;

        if (wait) {
          const waitResult = await manager.waitForMessages(sessionId, {
            ...readOpts,
            timeoutMs: params.timeout as number | undefined,
          });
          result = waitResult;
          timedOut = waitResult.timedOut;
        } else {
          result = manager.readMessages(sessionId, readOpts);
        }

        log('read', sessionId, { wait: !!wait, timedOut });

        const formatted = result.messages
          .map((m: SessionMessage) => `[${m.type}] ${m.content}`)
          .join('\n');

        return textResult({
          messageCount: result.messages.length,
          nextCursor: result.nextCursor,
          output: formatted || '(no new output)',
          ...(wait ? { timedOut } : {}),
        });
      },
    },

    // session_respond
    {
      name: 'session_respond',
      label: 'Respond to permission',
      description:
        'Approve or deny a permission request from a CLI session (e.g., file edit, command execution).',
      parameters: Type.Object({
        sessionId: Type.String({ description: 'Session ID' }),
        requestId: Type.String({
          description: 'Permission request ID (from the permission event)',
        }),
        approved: Type.Boolean({
          description: 'true to approve, false to deny',
        }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const sessionId = params.sessionId as string;
        manager.acl.assertOwner(caller.userId, sessionId);
        const session = manager.get(sessionId);

        await session.respondToPermission(
          params.requestId as string,
          params.approved as boolean,
        );

        log('respond', sessionId, {
          requestId: params.requestId,
          approved: params.approved,
        });

        return textResult({
          message: params.approved
            ? 'Permission approved.'
            : 'Permission denied.',
        });
      },
    },

    // session_switch
    {
      name: 'session_switch',
      label: 'Switch session mode',
      description:
        'Switch a session between "local" and "remote" modes. Local = terminal, remote = headless.',
      parameters: Type.Object({
        sessionId: Type.String({ description: 'Session ID' }),
        mode: Type.String({
          description: 'Target mode: "local" or "remote"',
        }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const sessionId = params.sessionId as string;
        manager.acl.assertOwner(caller.userId, sessionId);

        await manager.switchMode(
          sessionId,
          params.mode as 'local' | 'remote',
        );

        log('switch', sessionId, { mode: params.mode });
        return textResult({
          message: `Session switched to ${params.mode} mode.`,
        });
      },
    },

    // session_stop
    {
      name: 'session_stop',
      label: 'Stop AI session',
      description:
        'Stop a running CLI session. Use force=true to immediately kill.',
      parameters: Type.Object({
        sessionId: Type.String({ description: 'Session ID to stop' }),
        force: Type.Optional(
          Type.Boolean({
            description: 'Force kill (SIGKILL) instead of graceful stop',
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const sessionId = params.sessionId as string;
        manager.acl.assertOwner(caller.userId, sessionId);

        await manager.stop(sessionId, params.force as boolean | undefined);

        // Unbind push adapter (flushes remaining messages)
        pushAdapter?.unbindSession(sessionId);

        log('stop', sessionId, { force: params.force });
        return textResult({ message: 'Session stopped.' });
      },
    },

    // session_summary
    {
      name: 'session_summary',
      label: 'Session summary',
      description:
        'Get a structured summary of a session: message counts, tools used, files modified, duration.',
      parameters: Type.Object({
        sessionId: Type.String({ description: 'Session ID' }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const sessionId = params.sessionId as string;
        manager.acl.assertOwner(caller.userId, sessionId);

        const { messages } = manager.readMessages(sessionId);
        const summary = summarizeSession(messages);

        log('summary', sessionId);

        return textResult({
          ...summary,
          formatted: formatSummaryText(summary),
        });
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default happyclawPlugin;

/** Export for testing */
export { createOpenClawTools, textResult };
export type { OpenClawPluginApi, OpenClawPluginToolContext };
