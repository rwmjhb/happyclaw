/**
 * Full-stack integration test.
 *
 * Tests the complete flow: register providers -> spawn -> send -> read -> stop
 * with multi-session management and ACL enforcement across providers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createMockSession,
  createMockProvider,
} from '../helpers/mock-provider.js';
import { SessionManager } from '../../src/session-manager.js';
import { SessionACL } from '../../src/security/acl.js';
import { createPluginTools } from '../../src/plugin.js';
import { EventBus } from '../../src/event-bus.js';
import { parseCommand } from '../../src/commands.js';
import { formatForTelegram, formatForDiscord } from '../../src/formatters/index.js';
import { HealthChecker } from '../../src/health.js';
import { summarizeSession } from '../../src/summary.js';
import type {
  CallerContext,
  SessionEvent,
  SessionMessage,
} from '../../src/types/index.js';

describe('Full-stack integration', () => {
  let manager: SessionManager;
  let acl: SessionACL;
  let claudeProvider: ReturnType<typeof createMockProvider>;
  let geminiProvider: ReturnType<typeof createMockProvider>;
  let tools: ReturnType<typeof createPluginTools>;
  let eventBus: EventBus;

  const alice: CallerContext = { userId: 'alice', channelId: 'ch-1' };
  const bob: CallerContext = { userId: 'bob', channelId: 'ch-2' };

  beforeEach(() => {
    vi.useFakeTimers();
    acl = new SessionACL();
    eventBus = new EventBus({ debounceMs: 50, maxBatchSize: 10 });

    manager = new SessionManager({
      acl,
      cwdWhitelist: [],
      maxSessions: 10,
      drainTimeoutMs: 100,
      headless: false,
    });

    claudeProvider = createMockProvider('claude');
    geminiProvider = createMockProvider('gemini');

    manager.registerProvider(claudeProvider);
    manager.registerProvider(geminiProvider);

    tools = createPluginTools(manager);
  });

  afterEach(() => {
    eventBus.dispose();
    vi.useRealTimers();
  });

  describe('spawn -> send -> read -> stop flow', () => {
    it('completes full lifecycle for a single session', async () => {
      // 1. Spawn
      const mockSession = createMockSession({ id: 'flow-test' });
      claudeProvider._setNextSession(mockSession);

      const sessionInfo = await tools['session.spawn'].handler(
        { provider: 'claude', cwd: '/tmp/project', mode: 'remote' },
        alice,
      );
      expect(sessionInfo.id).toBe('flow-test');
      expect(sessionInfo.provider).toBe('claude');

      // 2. Send
      const sendResult = await tools['session.send'].handler(
        { sessionId: 'flow-test', input: 'Write tests for the module' },
        alice,
      );
      expect(sendResult.handled).toBe(false);
      expect(mockSession.send).toHaveBeenCalledWith('Write tests for the module');

      // 3. Read (simulate messages in buffer via manager)
      const readResult = await tools['session.read'].handler(
        { sessionId: 'flow-test' },
        alice,
      );
      expect(readResult.messages).toBeDefined();
      expect(readResult.nextCursor).toBeDefined();

      // 4. Stop
      const spy = vi.spyOn(manager, 'stop').mockResolvedValue(undefined);
      await tools['session.stop'].handler(
        { sessionId: 'flow-test' },
        alice,
      );
      expect(spy).toHaveBeenCalledWith('flow-test', undefined);
      spy.mockRestore();
    });
  });

  describe('multi-session management', () => {
    it('manages sessions across multiple providers', async () => {
      // Spawn claude session for alice
      const cs = createMockSession({ id: 'claude-1', provider: 'claude' });
      claudeProvider._setNextSession(cs);
      await tools['session.spawn'].handler(
        { provider: 'claude', cwd: '/tmp/a', mode: 'remote' },
        alice,
      );

      // Spawn gemini session for bob
      const gs = createMockSession({ id: 'gemini-1', provider: 'gemini' });
      geminiProvider._setNextSession(gs);
      await tools['session.spawn'].handler(
        { provider: 'gemini', cwd: '/tmp/b', mode: 'remote' },
        bob,
      );

      // Alice lists — only sees her session
      const aliceSessions = await tools['session.list'].handler({}, alice);
      expect(aliceSessions).toHaveLength(1);
      expect(aliceSessions[0].id).toBe('claude-1');

      // Bob lists — only sees his session
      const bobSessions = await tools['session.list'].handler({}, bob);
      expect(bobSessions).toHaveLength(1);
      expect(bobSessions[0].id).toBe('gemini-1');

      // Total sessions in manager
      expect(manager.size).toBe(2);
    });

    it('tracks session count correctly across spawn/stop', async () => {
      const s1 = createMockSession({ id: 's1' });
      const s2 = createMockSession({ id: 's2' });

      claudeProvider._setNextSession(s1);
      await manager.spawn('claude', { cwd: '/tmp', mode: 'remote' });
      expect(manager.size).toBe(1);

      claudeProvider._setNextSession(s2);
      await manager.spawn('claude', { cwd: '/tmp', mode: 'remote' });
      expect(manager.size).toBe(2);

      await manager.stop('s1');
      expect(manager.size).toBe(1);

      await manager.stop('s2');
      expect(manager.size).toBe(0);
    });
  });

  describe('ACL enforcement', () => {
    it('prevents cross-user session access', async () => {
      const cs = createMockSession({ id: 'alice-session' });
      claudeProvider._setNextSession(cs);
      await tools['session.spawn'].handler(
        { provider: 'claude', cwd: '/tmp', mode: 'remote' },
        alice,
      );

      // Bob tries to send to alice's session
      await expect(
        tools['session.send'].handler(
          { sessionId: 'alice-session', input: 'hack' },
          bob,
        ),
      ).rejects.toThrow(/denied|not own/i);

      // Bob tries to read alice's session
      await expect(
        tools['session.read'].handler(
          { sessionId: 'alice-session' },
          bob,
        ),
      ).rejects.toThrow(/denied|not own/i);

      // Bob tries to stop alice's session
      await expect(
        tools['session.stop'].handler(
          { sessionId: 'alice-session' },
          bob,
        ),
      ).rejects.toThrow(/denied|not own/i);
    });
  });

  describe('slash command integration', () => {
    it('/clear goes through plugin send handler', async () => {
      const cs = createMockSession({ id: 'cmd-test' });
      claudeProvider._setNextSession(cs);
      await tools['session.spawn'].handler(
        { provider: 'claude', cwd: '/tmp', mode: 'remote' },
        alice,
      );

      const result = await tools['session.send'].handler(
        { sessionId: 'cmd-test', input: '/clear' },
        alice,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toContain('cleared');
      expect(cs.send).toHaveBeenCalledWith('/clear');
    });

    it('regular input passes through to provider', async () => {
      const cs = createMockSession({ id: 'cmd-test-2' });
      claudeProvider._setNextSession(cs);
      await tools['session.spawn'].handler(
        { provider: 'claude', cwd: '/tmp', mode: 'remote' },
        alice,
      );

      const result = await tools['session.send'].handler(
        { sessionId: 'cmd-test-2', input: 'explain this code' },
        alice,
      );

      expect(result.handled).toBe(false);
      expect(cs.send).toHaveBeenCalledWith('explain this code');
    });
  });

  describe('event bus integration', () => {
    it('routes events from manager to event bus subscribers', async () => {
      const cs = createMockSession({ id: 'evt-test' });
      claudeProvider._setNextSession(cs);
      await manager.spawn('claude', { cwd: '/tmp', mode: 'remote' }, 'alice');

      const received: SessionEvent[][] = [];
      eventBus.subscribe('evt-test', (events) => received.push(events));

      // Forward manager events to event bus
      manager.on('event', (event: SessionEvent) => {
        eventBus.publish(event);
      });

      // Simulate a permission request event
      cs._emitEvent({
        type: 'permission_request',
        severity: 'urgent',
        summary: 'Tool needs approval',
        sessionId: 'evt-test',
        timestamp: Date.now(),
        permissionDetail: {
          requestId: 'req-1',
          toolName: 'Write',
          input: { file_path: '/tmp/test.txt' },
        },
      });

      // permission_request bypasses debounce
      expect(received).toHaveLength(1);
      expect(received[0][0].type).toBe('permission_request');
    });

    it('batches non-urgent events', async () => {
      const cs = createMockSession({ id: 'batch-test' });
      claudeProvider._setNextSession(cs);
      await manager.spawn('claude', { cwd: '/tmp', mode: 'remote' }, 'alice');

      const received: SessionEvent[][] = [];
      eventBus.subscribe('batch-test', (events) => received.push(events));

      manager.on('event', (event: SessionEvent) => {
        eventBus.publish(event);
      });

      // Emit multiple info events
      cs._emitEvent({
        type: 'ready',
        severity: 'info',
        summary: 'Ready 1',
        sessionId: 'batch-test',
        timestamp: Date.now(),
      });
      cs._emitEvent({
        type: 'ready',
        severity: 'info',
        summary: 'Ready 2',
        sessionId: 'batch-test',
        timestamp: Date.now(),
      });

      // Not yet delivered (in debounce window)
      expect(received).toHaveLength(0);

      // Advance past debounce
      vi.advanceTimersByTime(100);

      // Both events delivered as single batch
      expect(received).toHaveLength(1);
      expect(received[0]).toHaveLength(2);
    });
  });

  describe('formatter integration', () => {
    it('formats session messages for Telegram', () => {
      const messages: SessionMessage[] = [
        { type: 'text', content: 'Hello from Claude!', timestamp: Date.now() },
      ];

      const chunks = formatForTelegram(messages);
      expect(chunks).toBeDefined();
      expect(chunks.length).toBeGreaterThan(0);
      // Each chunk should respect Telegram limit
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(4000);
      }
    });

    it('formats session messages for Discord', () => {
      const messages: SessionMessage[] = [
        {
          type: 'code',
          content: 'console.log("hello")',
          timestamp: Date.now(),
          metadata: { language: 'javascript' },
        },
      ];

      const chunks = formatForDiscord(messages);
      expect(chunks).toBeDefined();
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(1900);
      }
    });
  });

  describe('message pagination across sessions', () => {
    it('each session has independent message buffers', async () => {
      const s1 = createMockSession({ id: 'pag-1' });
      const s2 = createMockSession({ id: 'pag-2' });

      claudeProvider._setNextSession(s1);
      await manager.spawn('claude', { cwd: '/tmp', mode: 'remote' }, 'alice');

      claudeProvider._setNextSession(s2);
      await manager.spawn('claude', { cwd: '/tmp', mode: 'remote' }, 'alice');

      // Emit messages to s1 only
      s1._emitMessage({
        type: 'text',
        content: 'Message for s1',
        timestamp: Date.now(),
      });

      const r1 = manager.readMessages('pag-1');
      expect(r1.messages).toHaveLength(1);
      expect(r1.messages[0].content).toBe('Message for s1');

      const r2 = manager.readMessages('pag-2');
      expect(r2.messages).toHaveLength(0);
    });
  });

  describe('health checker integration', () => {
    it('auto-cleans dead sessions via health checker', async () => {
      const alive = createMockSession({ id: 'alive-int', pid: process.pid });
      const dead = createMockSession({ id: 'dead-int', pid: 999999999 });

      claudeProvider._setNextSession(alive);
      await manager.spawn('claude', { cwd: '/tmp', mode: 'remote' }, 'alice');
      claudeProvider._setNextSession(dead);
      await manager.spawn('claude', { cwd: '/tmp', mode: 'remote' }, 'alice');

      expect(manager.size).toBe(2);

      const checker = new HealthChecker(manager, { intervalMs: 500 });
      checker.start();

      await vi.advanceTimersByTimeAsync(600);

      // Dead session should be cleaned up
      expect(manager.size).toBe(1);
      expect(() => manager.get('alive-int')).not.toThrow();
      expect(() => manager.get('dead-int')).toThrow(/not found/i);

      checker.stop();
    });
  });

  describe('session.summary tool integration', () => {
    it('returns structured summary via plugin tool', async () => {
      const cs = createMockSession({ id: 'summary-int' });
      claudeProvider._setNextSession(cs);
      await tools['session.spawn'].handler(
        { provider: 'claude', cwd: '/tmp', mode: 'remote' },
        alice,
      );

      // Simulate messages
      cs._emitMessage({ type: 'text', content: 'Hello', timestamp: 1000 });
      cs._emitMessage({
        type: 'tool_use',
        content: 'Reading file',
        timestamp: 2000,
        metadata: { tool: 'Read', file: '/src/main.ts' },
      });
      cs._emitMessage({ type: 'result', content: 'Done', timestamp: 5000 });

      const summary = await tools['session.summary'].handler(
        { sessionId: 'summary-int' },
        alice,
      );

      expect(summary.totalMessages).toBe(3);
      expect(summary.toolsUsed).toContain('Read');
      expect(summary.filesModified).toContain('/src/main.ts');
      expect(summary.status).toBe('completed');
      expect(summary.durationMs).toBe(4000);
    });

    it('enforces ACL on session.summary', async () => {
      const cs = createMockSession({ id: 'sum-acl' });
      claudeProvider._setNextSession(cs);
      await tools['session.spawn'].handler(
        { provider: 'claude', cwd: '/tmp', mode: 'remote' },
        alice,
      );

      await expect(
        tools['session.summary'].handler(
          { sessionId: 'sum-acl' },
          bob,
        ),
      ).rejects.toThrow(/denied|not own/i);
    });
  });

  describe('audit logging integration', () => {
    it('creates plugin tools with audit logger option', () => {
      // Verify the createPluginTools accepts the auditLogger option
      const toolsWithAudit = createPluginTools(manager, {
        auditLogger: undefined,
      });
      expect(toolsWithAudit['session.spawn']).toBeDefined();
      expect(toolsWithAudit['session.summary']).toBeDefined();
    });
  });
});
