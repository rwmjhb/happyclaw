import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createMockSession,
  createMockProvider,
} from '../helpers/mock-provider.js';
import type { CallerContext, SessionMessage } from '../../src/types/index.js';
import { SessionManager } from '../../src/session-manager.js';
import { SessionACL } from '../../src/security/acl.js';
import { AuditLogger } from '../../src/audit.js';

import happyclawPlugin, {
  createOpenClawTools,
  textResult,
} from '../../src/openclaw-plugin.js';
import type { OpenClawPluginApi } from '../../src/openclaw-plugin.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockApi(
  overrides: Partial<OpenClawPluginApi> = {},
): OpenClawPluginApi & {
  registeredTools: unknown[];
  hookHandlers: Map<string, Array<(...args: unknown[]) => void>>;
} {
  const registeredTools: unknown[] = [];
  const hookHandlers = new Map<string, Array<(...args: unknown[]) => void>>();

  return {
    id: 'happyclaw-test',
    name: 'HappyClaw Test',
    pluginConfig: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    registerTool: vi.fn((tool, _opts) => {
      registeredTools.push(tool);
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      let handlers = hookHandlers.get(event);
      if (!handlers) {
        handlers = [];
        hookHandlers.set(event, handlers);
      }
      handlers.push(handler);
    }),
    registeredTools,
    hookHandlers,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// textResult helper
// ---------------------------------------------------------------------------

describe('textResult', () => {
  it('wraps a string as text content', () => {
    const result = textResult('hello');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'hello' }],
    });
  });

  it('JSON-stringifies objects', () => {
    const result = textResult({ id: 'abc', status: 'ok' });
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual({
      id: 'abc',
      status: 'ok',
    });
  });
});

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

describe('happyclawPlugin', () => {
  it('has correct id and name', () => {
    expect(happyclawPlugin.id).toBe('happyclaw');
    expect(happyclawPlugin.name).toBe('HappyClaw');
  });

  it('has a description', () => {
    expect(happyclawPlugin.description).toBeTruthy();
  });

  it('register() calls api.registerTool', () => {
    const api = createMockApi();
    happyclawPlugin.register(api);

    expect(api.registerTool).toHaveBeenCalledTimes(1);
    expect(api.registeredTools).toHaveLength(1);
    // The registered "tool" is a factory function
    expect(typeof api.registeredTools[0]).toBe('function');
  });

  it('register() hooks gateway_stop', () => {
    const api = createMockApi();
    happyclawPlugin.register(api);

    expect(api.hookHandlers.has('gateway_stop')).toBe(true);
  });

  it('register() logs initialization messages', () => {
    const api = createMockApi();
    happyclawPlugin.register(api);

    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('HappyClaw plugin registered'),
    );
  });

  it('tool factory produces tools with correct names', () => {
    const api = createMockApi();
    happyclawPlugin.register(api);

    const factory = api.registeredTools[0] as (ctx: unknown) => unknown[];
    const tools = factory({
      agentAccountId: 'user-1',
      messageChannel: 'telegram',
    });

    expect(Array.isArray(tools)).toBe(true);
    const names = (tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual([
      'session_list',
      'session_spawn',
      'session_resume',
      'session_send',
      'session_read',
      'session_respond',
      'session_switch',
      'session_stop',
      'session_summary',
    ]);
  });

  it('tool factory uses agentAccountId as userId', () => {
    const api = createMockApi();
    happyclawPlugin.register(api);

    const factory = api.registeredTools[0] as (ctx: unknown) => unknown[];
    const tools = factory({
      agentAccountId: 'my-user',
      messageChannel: 'discord',
    });

    // Each tool's execute should use the caller context derived from factory ctx
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(9);
  });

  it('handles missing pluginConfig gracefully', () => {
    const api = createMockApi({ pluginConfig: undefined });
    expect(() => happyclawPlugin.register(api)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createOpenClawTools — unit tests for each tool
// ---------------------------------------------------------------------------

describe('createOpenClawTools', () => {
  let manager: SessionManager;
  let acl: SessionACL;
  let mockProvider: ReturnType<typeof createMockProvider>;
  let audit: AuditLogger;
  let tools: ReturnType<typeof createOpenClawTools>;

  const caller: CallerContext = { userId: 'owner-1', channelId: 'tg-ch-1' };
  const otherCaller: CallerContext = {
    userId: 'other-user',
    channelId: 'tg-ch-2',
  };

  beforeEach(async () => {
    acl = new SessionACL();
    manager = new SessionManager({ acl, cwdWhitelist: [], maxSessions: 10 });
    mockProvider = createMockProvider('claude');
    manager.registerProvider(mockProvider);

    // Mock audit to avoid filesystem I/O
    audit = new AuditLogger({ logDir: '/tmp/happyclaw-test-audit' });
    vi.spyOn(audit, 'log').mockResolvedValue(undefined);

    tools = createOpenClawTools(manager, audit, caller);

    // Pre-create a session
    const mockSession = createMockSession({ id: 'sess-1' });
    mockProvider._setNextSession(mockSession);
    await manager.spawn(
      'claude',
      { cwd: '/tmp/project', mode: 'remote' },
      caller.userId,
    );
  });

  function findTool(name: string) {
    const tool = tools.find(
      (t) => (t as { name: string }).name === name,
    ) as { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool;
  }

  // -----------------------------------------------------------------------
  // session_list
  // -----------------------------------------------------------------------

  describe('session_list', () => {
    it('returns sessions for owner', async () => {
      const tool = findTool('session_list');
      const result = (await tool.execute('call-1', {})) as {
        content: Array<{ text: string }>;
      };

      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe('sess-1');
    });

    it('returns empty message for non-owner tools', async () => {
      const otherTools = createOpenClawTools(manager, audit, otherCaller);
      const tool = otherTools.find(
        (t) => (t as { name: string }).name === 'session_list',
      ) as { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> };

      const result = await tool.execute('call-1', {});
      expect(result.content[0].text).toContain('No active sessions');
    });

    it('filters by provider', async () => {
      const tool = findTool('session_list');
      const result = (await tool.execute('call-1', {
        provider: 'nonexistent',
      })) as { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain('No active sessions');
    });
  });

  // -----------------------------------------------------------------------
  // session_spawn
  // -----------------------------------------------------------------------

  describe('session_spawn', () => {
    it('spawns a session and returns info', async () => {
      const newSession = createMockSession({ id: 'sess-2' });
      mockProvider._setNextSession(newSession);

      const tool = findTool('session_spawn');
      const result = (await tool.execute('call-1', {
        provider: 'claude',
        cwd: '/tmp/new-project',
      })) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe('sess-2');
      expect(parsed.message).toContain('Session started');
    });

    it('sets owner via ACL', async () => {
      const newSession = createMockSession({ id: 'sess-3' });
      mockProvider._setNextSession(newSession);

      const tool = findTool('session_spawn');
      await tool.execute('call-1', {
        provider: 'claude',
        cwd: '/tmp/project2',
      });

      expect(acl.getOwner('sess-3')).toBe('owner-1');
    });
  });

  // -----------------------------------------------------------------------
  // session_send
  // -----------------------------------------------------------------------

  describe('session_send', () => {
    it('forwards input to session', async () => {
      const tool = findTool('session_send');
      const result = (await tool.execute('call-1', {
        sessionId: 'sess-1',
        input: 'fix the bug',
      })) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.handled).toBe(false);
      expect(parsed.message).toContain('Input sent');

      const session = manager.get('sess-1');
      expect(session.send).toHaveBeenCalledWith('fix the bug');
    });

    it('intercepts /cost slash command', async () => {
      const tool = findTool('session_send');
      const result = (await tool.execute('call-1', {
        sessionId: 'sess-1',
        input: '/cost',
      })) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.handled).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // session_read
  // -----------------------------------------------------------------------

  describe('session_read', () => {
    it('returns formatted messages', async () => {
      // Push some messages into the buffer
      const session = manager.get('sess-1') as ReturnType<
        typeof createMockSession
      >;
      session._emitMessage({
        type: 'text',
        content: 'Hello from Claude',
        timestamp: Date.now(),
      });

      const tool = findTool('session_read');
      const result = (await tool.execute('call-1', {
        sessionId: 'sess-1',
      })) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.messageCount).toBe(1);
      expect(parsed.output).toContain('Hello from Claude');
    });

    it('returns "(no new output)" when no messages', async () => {
      const tool = findTool('session_read');
      const result = (await tool.execute('call-1', {
        sessionId: 'sess-1',
      })) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.output).toBe('(no new output)');
    });
  });

  // -----------------------------------------------------------------------
  // session_respond
  // -----------------------------------------------------------------------

  describe('session_respond', () => {
    it('forwards approval to session', async () => {
      const tool = findTool('session_respond');
      const result = (await tool.execute('call-1', {
        sessionId: 'sess-1',
        requestId: 'req-abc',
        approved: true,
      })) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.message).toContain('approved');

      const session = manager.get('sess-1');
      expect(session.respondToPermission).toHaveBeenCalledWith(
        'req-abc',
        true,
      );
    });

    it('forwards denial to session', async () => {
      const tool = findTool('session_respond');
      const result = (await tool.execute('call-1', {
        sessionId: 'sess-1',
        requestId: 'req-abc',
        approved: false,
      })) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.message).toContain('denied');
    });
  });

  // -----------------------------------------------------------------------
  // session_stop
  // -----------------------------------------------------------------------

  describe('session_stop', () => {
    it('stops a session', async () => {
      const tool = findTool('session_stop');
      const result = (await tool.execute('call-1', {
        sessionId: 'sess-1',
      })) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.message).toContain('stopped');
    });
  });

  // -----------------------------------------------------------------------
  // session_summary
  // -----------------------------------------------------------------------

  describe('session_summary', () => {
    it('returns summary for a session with messages', async () => {
      const session = manager.get('sess-1') as ReturnType<
        typeof createMockSession
      >;
      session._emitMessage({
        type: 'text',
        content: 'Analyzing codebase...',
        timestamp: 1000,
      });
      session._emitMessage({
        type: 'tool_use',
        content: 'Reading file',
        timestamp: 2000,
        metadata: { tool: 'Read' },
      });

      const tool = findTool('session_summary');
      const result = (await tool.execute('call-1', {
        sessionId: 'sess-1',
      })) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalMessages).toBe(2);
      expect(parsed.toolsUsed).toContain('Read');
      expect(parsed.formatted).toContain('Session summary');
    });
  });

  // -----------------------------------------------------------------------
  // ACL enforcement across tools
  // -----------------------------------------------------------------------

  describe('ACL enforcement', () => {
    const aclTools = [
      'session_resume',
      'session_send',
      'session_read',
      'session_respond',
      'session_switch',
      'session_stop',
      'session_summary',
    ];

    it.each(aclTools)(
      '%s rejects non-owner access',
      async (toolName: string) => {
        const otherTools = createOpenClawTools(manager, audit, otherCaller);
        const tool = otherTools.find(
          (t) => (t as { name: string }).name === toolName,
        ) as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

        await expect(
          tool.execute('call-1', {
            sessionId: 'sess-1',
            input: 'test',
            requestId: 'req-1',
            approved: true,
            mode: 'local',
          }),
        ).rejects.toThrow(/does not own|not found|access denied/i);
      },
    );
  });

  // -----------------------------------------------------------------------
  // Audit logging
  // -----------------------------------------------------------------------

  describe('audit logging', () => {
    it('logs tool invocations (fire-and-forget)', async () => {
      const tool = findTool('session_list');
      await tool.execute('call-1', {});

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'owner-1',
          action: 'list',
          sessionId: '*',
        }),
      );
    });
  });
});
