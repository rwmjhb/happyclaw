import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createMockSession,
  createMockProvider,
} from '../helpers/mock-provider.js';
import { SessionManager } from '../../src/session-manager.js';
import { SessionACL } from '../../src/security/acl.js';

describe('SessionManager', () => {
  let manager: SessionManager;
  let acl: SessionACL;
  let mockProvider: ReturnType<typeof createMockProvider>;

  beforeEach(() => {
    acl = new SessionACL();
    manager = new SessionManager({
      acl,
      cwdWhitelist: [],
      maxSessions: 3,
    });
    mockProvider = createMockProvider('claude');
    manager.registerProvider(mockProvider);
  });

  describe('spawn', () => {
    it('creates a session and stores it in the map', async () => {
      const mockSession = createMockSession({ id: 'sess-1' });
      mockProvider._setNextSession(mockSession);

      const session = await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      expect(session.id).toBe('sess-1');
      expect(manager.get('sess-1')).toBe(session);
    });

    it('sets owner before events are forwarded', async () => {
      const mockSession = createMockSession({ id: 'sess-2' });
      mockProvider._setNextSession(mockSession);

      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      expect(acl.getOwner('sess-2')).toBe('user-1');
    });

    it('rejects when over maxSessions limit', async () => {
      for (let i = 0; i < 3; i++) {
        const s = createMockSession({ id: `sess-${i}` });
        mockProvider._setNextSession(s);
        await manager.spawn(
          'claude',
          { cwd: '/tmp/test', mode: 'remote' },
          'user-1',
        );
      }

      const s4 = createMockSession({ id: 'sess-4' });
      mockProvider._setNextSession(s4);
      await expect(
        manager.spawn(
          'claude',
          { cwd: '/tmp/test', mode: 'remote' },
          'user-1',
        ),
      ).rejects.toThrow(/limit/i);
    });

    it('rejects cwd not in whitelist', async () => {
      const restricted = new SessionManager({
        acl,
        cwdWhitelist: ['/allowed-dir'],
        maxSessions: 10,
      });
      restricted.registerProvider(mockProvider);

      await expect(
        restricted.spawn(
          'claude',
          { cwd: '/not-allowed', mode: 'remote' },
          'user-1',
        ),
      ).rejects.toThrow(/whitelist/i);
    });

    it('rejects unknown provider', async () => {
      await expect(
        manager.spawn(
          'unknown-provider',
          { cwd: '/tmp/test', mode: 'remote' },
          'user-1',
        ),
      ).rejects.toThrow(/unknown provider/i);
    });

    it('attaches event and message listeners', async () => {
      const mockSession = createMockSession({ id: 'listener-test' });
      mockProvider._setNextSession(mockSession);

      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      // Session's onEvent and onMessage should have been called
      expect(mockSession.onEvent).toHaveBeenCalled();
      expect(mockSession.onMessage).toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('returns the session by id', async () => {
      const mockSession = createMockSession({ id: 'sess-get' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      expect(manager.get('sess-get').id).toBe('sess-get');
    });

    it('throws on not found', () => {
      expect(() => manager.get('nonexistent')).toThrow(/not found/i);
    });
  });

  describe('list', () => {
    it('returns all sessions without filter', async () => {
      const s1 = createMockSession({ id: 'list-1', cwd: '/a' });
      mockProvider._setNextSession(s1);
      await manager.spawn(
        'claude',
        { cwd: '/a', mode: 'remote' },
        'user-1',
      );

      const codexProvider = createMockProvider('codex');
      const s2 = createMockSession({ id: 'list-2', cwd: '/b', provider: 'codex' });
      codexProvider._setNextSession(s2);
      manager.registerProvider(codexProvider);
      await manager.spawn(
        'codex',
        { cwd: '/b', mode: 'remote' },
        'user-1',
      );

      expect(manager.list()).toHaveLength(2);
    });

    it('filters by provider', async () => {
      const s1 = createMockSession({ id: 'prov-1', provider: 'claude' });
      mockProvider._setNextSession(s1);
      await manager.spawn(
        'claude',
        { cwd: '/tmp', mode: 'remote' },
        'user-1',
      );

      const codexProvider = createMockProvider('codex');
      const s2 = createMockSession({ id: 'prov-2', provider: 'codex' });
      codexProvider._setNextSession(s2);
      manager.registerProvider(codexProvider);
      await manager.spawn(
        'codex',
        { cwd: '/tmp', mode: 'remote' },
        'user-1',
      );

      const claudeOnly = manager.list({ provider: 'claude' });
      expect(claudeOnly).toHaveLength(1);
      expect(claudeOnly[0].provider).toBe('claude');
    });
  });

  describe('readMessages', () => {
    it('returns empty for new session', async () => {
      const mockSession = createMockSession({ id: 'read-test' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      const result = manager.readMessages('read-test');
      expect(result.messages).toEqual([]);
      expect(result.nextCursor).toBe('0');
    });

    it('returns buffered messages with cursor pagination', async () => {
      const mockSession = createMockSession({ id: 'read-cursor' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      // Simulate messages arriving via the onMessage handler
      const msgs = [
        { type: 'text' as const, content: 'Hello', timestamp: Date.now() },
        { type: 'text' as const, content: 'World', timestamp: Date.now() },
        { type: 'code' as const, content: 'console.log(1)', timestamp: Date.now() },
      ];
      for (const msg of msgs) {
        mockSession._emitMessage(msg);
      }

      const first = manager.readMessages('read-cursor', { limit: 2 });
      expect(first.messages).toHaveLength(2);
      expect(first.messages[0].content).toBe('Hello');
      expect(first.nextCursor).toBe('2');

      const second = manager.readMessages('read-cursor', {
        cursor: first.nextCursor,
        limit: 2,
      });
      expect(second.messages).toHaveLength(1);
      expect(second.messages[0].content).toBe('console.log(1)');
    });

    it('throws for unknown session', () => {
      expect(() => manager.readMessages('nonexistent')).toThrow(
        /no message buffer/i,
      );
    });
  });

  describe('switchMode', () => {
    it('transitions running -> draining -> switching -> running on success', async () => {
      const mockSession = createMockSession({ id: 'switch-1' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      const resumedSession = createMockSession({
        id: 'switch-1',
        mode: 'local',
      });
      (mockProvider.resume as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        resumedSession,
      );

      await manager.switchMode('switch-1', 'local');

      expect(manager.get('switch-1')).toBe(resumedSession);
      expect(manager.getSwitchState('switch-1')).toBe('running');
    });

    it('error recovery: sets error state and deletes from map', async () => {
      const mockSession = createMockSession({ id: 'switch-err' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      (mockProvider.resume as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('resume failed'),
      );

      await manager.switchMode('switch-err', 'local');

      expect(() => manager.get('switch-err')).toThrow(/not found/i);
      expect(manager.getSwitchState('switch-err')).toBe('error');
    });

    it('emits error event on switch failure', async () => {
      const mockSession = createMockSession({ id: 'switch-evt' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      (mockProvider.resume as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('resume failed'),
      );

      const events: SessionEvent[] = [];
      manager.on('event', (e: SessionEvent) => events.push(e));

      await manager.switchMode('switch-evt', 'local');

      const errEvent = events.find(
        (e) => e.type === 'error' && e.severity === 'urgent',
      );
      expect(errEvent).toBeDefined();
      expect(errEvent!.summary).toContain('Mode switch failed');
    });

    it('rejects when not in running state', async () => {
      const mockSession = createMockSession({ id: 'switch-reject' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      // Force error state by failing resume
      (mockProvider.resume as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('fail'),
      );
      await manager.switchMode('switch-reject', 'local');

      // Session is now removed — trying to switch should fail with not found
      await expect(
        manager.switchMode('switch-reject', 'remote'),
      ).rejects.toThrow(/not found/i);
    });

    it('no-ops when already in target mode', async () => {
      const mockSession = createMockSession({ id: 'no-op', mode: 'remote' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      await manager.switchMode('no-op', 'remote');

      // Should still be in running state — no transition happened
      expect(manager.getSwitchState('no-op')).toBe('running');
      expect(mockSession.switchMode).not.toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('stops session and cleans up', async () => {
      const mockSession = createMockSession({ id: 'stop-1' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      await manager.stop('stop-1');

      expect(() => manager.get('stop-1')).toThrow(/not found/i);
      expect(mockSession.stop).toHaveBeenCalled();
      expect(acl.getOwner('stop-1')).toBeUndefined();
    });

    it('throws for unknown session', async () => {
      await expect(manager.stop('nonexistent')).rejects.toThrow(
        /not found/i,
      );
    });
  });

  describe('reconcileOnStartup', () => {
    it('classifies dead PIDs correctly', async () => {
      const result = await manager.reconcileOnStartup([
        {
          id: 'dead-1',
          provider: 'claude',
          cwd: '/tmp',
          pid: 999999999, // Almost certainly a dead PID
          ownerId: 'user-1',
          mode: 'remote',
          createdAt: Date.now(),
        },
      ]);

      expect(result.dead).toHaveLength(1);
      expect(result.dead[0].id).toBe('dead-1');
    });
  });

  describe('size', () => {
    it('reflects active session count', async () => {
      expect(manager.size).toBe(0);

      const s1 = createMockSession({ id: 'size-1' });
      mockProvider._setNextSession(s1);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      expect(manager.size).toBe(1);
    });
  });

  describe('retryResume', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries with exponential backoff and succeeds', async () => {
      const mockSession = createMockSession({ id: 'retry-ok', mode: 'remote' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      const resumedSession = createMockSession({ id: 'retry-ok', mode: 'remote' });

      // Fail first, succeed second
      (mockProvider.resume as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockResolvedValueOnce(resumedSession);

      const promise = manager.retryResume('retry-ok', {
        maxRetries: 3,
        baseDelayMs: 100,
      });

      // Advance through first delay (100ms * 2^0 = 100ms)
      await vi.advanceTimersByTimeAsync(150);
      // Advance through second delay (100ms * 2^1 = 200ms)
      await vi.advanceTimersByTimeAsync(250);

      const session = await promise;
      expect(session.id).toBe('retry-ok');
    });

    it('exhausts retries and throws', async () => {
      const mockSession = createMockSession({ id: 'retry-fail', mode: 'remote' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      // Fail all attempts
      (mockProvider.resume as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error('persistent failure'));

      const events: SessionEvent[] = [];
      manager.on('event', (e: SessionEvent) => events.push(e));

      const promise = manager.retryResume('retry-fail', {
        maxRetries: 2,
        baseDelayMs: 50,
      });

      // Attach catch handler immediately to prevent unhandled rejection
      const resultPromise = promise.catch((err: Error) => err);

      // Advance through all delays
      await vi.advanceTimersByTimeAsync(50);  // attempt 1 (50ms)
      await vi.advanceTimersByTimeAsync(100); // attempt 2 (100ms)
      await vi.advanceTimersByTimeAsync(200); // extra time

      const error = await resultPromise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/after 2 retries/i);

      // Should have emitted retry attempt events
      const retryEvents = events.filter((e) =>
        e.summary.includes('Retry attempt'),
      );
      expect(retryEvents).toHaveLength(2);

      // Should have emitted exhaustion event
      const exhausted = events.find((e) =>
        e.summary.includes('retry attempts exhausted'),
      );
      expect(exhausted).toBeDefined();
      expect(exhausted!.severity).toBe('urgent');
    });

    it('emits info events for each retry attempt', async () => {
      const mockSession = createMockSession({ id: 'retry-evt', mode: 'remote' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      const resumedSession = createMockSession({ id: 'retry-evt', mode: 'remote' });
      (mockProvider.resume as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce(resumedSession);

      const events: SessionEvent[] = [];
      manager.on('event', (e: SessionEvent) => events.push(e));

      const promise = manager.retryResume('retry-evt', {
        maxRetries: 3,
        baseDelayMs: 50,
      });

      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(200);

      await promise;

      const retryInfoEvents = events.filter(
        (e) => e.summary.includes('Retry attempt'),
      );
      expect(retryInfoEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('readMessages with redaction', () => {
    it('redacts sensitive content in messages', async () => {
      const mockSession = createMockSession({ id: 'redact-test' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      mockSession._emitMessage({
        type: 'text',
        content: 'Bearer mysecrettoken123',
        timestamp: Date.now(),
      });

      const result = manager.readMessages('redact-test');
      expect(result.messages[0].content).toContain('Bearer [REDACTED]');
      expect(result.messages[0].content).not.toContain('mysecrettoken123');
    });
  });

  // -------------------------------------------------------------------------
  // waitForMessages (blocking read)
  // -------------------------------------------------------------------------

  describe('waitForMessages', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns immediately when messages exist past cursor', async () => {
      const mockSession = createMockSession({ id: 'wait-buffered' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      // Pre-fill buffer with messages
      mockSession._emitMessage({
        type: 'text',
        content: 'Already here',
        timestamp: Date.now(),
      });
      mockSession._emitMessage({
        type: 'text',
        content: 'Also here',
        timestamp: Date.now(),
      });

      // cursor '0' means start from beginning — messages exist
      const result = await manager.waitForMessages('wait-buffered', {
        cursor: '0',
        timeoutMs: 5000,
      });

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].content).toContain('Already here');
      expect(result.timedOut).toBe(false);
    });

    it('waits and resolves when a message arrives', async () => {
      const mockSession = createMockSession({ id: 'wait-arrive' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      // Start waiting (no messages in buffer yet)
      const promise = manager.waitForMessages('wait-arrive', {
        cursor: '0',
        timeoutMs: 10_000,
      });

      // Simulate a message arriving after a small delay
      await vi.advanceTimersByTimeAsync(100);
      mockSession._emitMessage({
        type: 'text',
        content: 'Arrived during wait',
        timestamp: Date.now(),
      });

      const result = await promise;

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toContain('Arrived during wait');
      expect(result.timedOut).toBe(false);
    });

    it('returns with timedOut flag on timeout', async () => {
      const mockSession = createMockSession({ id: 'wait-timeout' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      const promise = manager.waitForMessages('wait-timeout', {
        cursor: '0',
        timeoutMs: 3000,
      });

      // No messages arrive, advance past timeout
      await vi.advanceTimersByTimeAsync(3500);

      const result = await promise;

      expect(result.messages).toHaveLength(0);
      expect(result.timedOut).toBe(true);
    });

    it('resolves cleanly when session dies during wait', async () => {
      const mockSession = createMockSession({ id: 'wait-death' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      const promise = manager.waitForMessages('wait-death', {
        cursor: '0',
        timeoutMs: 10_000,
      });

      // Simulate session death via process exit event
      await vi.advanceTimersByTimeAsync(100);
      mockSession._emitEvent({
        type: 'error',
        severity: 'urgent',
        sessionId: 'wait-death',
        timestamp: Date.now(),
        summary: 'Process exited with code 1',
      });

      const result = await promise;

      // Should resolve (not reject) — sessionEnd triggered, not a timeout
      expect(result.messages).toBeDefined();
      expect(result.timedOut).toBe(false);
    });

    it('handles concurrent waits on same session', async () => {
      const mockSession = createMockSession({ id: 'wait-concurrent' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      // Two concurrent waits with different cursors
      const promise1 = manager.waitForMessages('wait-concurrent', {
        cursor: '0',
        timeoutMs: 10_000,
      });
      const promise2 = manager.waitForMessages('wait-concurrent', {
        cursor: '0',
        timeoutMs: 10_000,
      });

      // A message arrives — both should resolve
      await vi.advanceTimersByTimeAsync(100);
      mockSession._emitMessage({
        type: 'text',
        content: 'Shared message',
        timestamp: Date.now(),
      });

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1.messages).toHaveLength(1);
      expect(result2.messages).toHaveLength(1);
    });

    it('respects cursor for incremental reads with wait', async () => {
      const mockSession = createMockSession({ id: 'wait-cursor' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      // Pre-fill 2 messages
      mockSession._emitMessage({
        type: 'text',
        content: 'Old message 1',
        timestamp: Date.now(),
      });
      mockSession._emitMessage({
        type: 'text',
        content: 'Old message 2',
        timestamp: Date.now(),
      });

      // Wait with cursor='2' (past existing messages) — should block
      const promise = manager.waitForMessages('wait-cursor', {
        cursor: '2',
        timeoutMs: 10_000,
      });

      // New message arrives
      await vi.advanceTimersByTimeAsync(100);
      mockSession._emitMessage({
        type: 'text',
        content: 'New message 3',
        timestamp: Date.now(),
      });

      const result = await promise;

      // Should only return the new message (after cursor=2)
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toContain('New message 3');
      expect(result.nextCursor).toBe('3');
    });

    it('cleans up listener and timer after resolve', async () => {
      const mockSession = createMockSession({ id: 'wait-cleanup' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      const listenersBefore = manager.listenerCount('message');

      const promise = manager.waitForMessages('wait-cleanup', {
        cursor: '0',
        timeoutMs: 10_000,
      });

      // Verify listener was added
      expect(manager.listenerCount('message')).toBeGreaterThan(
        listenersBefore,
      );

      // Resolve by sending a message
      await vi.advanceTimersByTimeAsync(100);
      mockSession._emitMessage({
        type: 'text',
        content: 'Done',
        timestamp: Date.now(),
      });

      await promise;

      // Verify listener was cleaned up
      expect(manager.listenerCount('message')).toBe(listenersBefore);
    });

    it('cleans up listener and timer after timeout', async () => {
      const mockSession = createMockSession({ id: 'wait-cleanup-timeout' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      const listenersBefore = manager.listenerCount('message');

      const promise = manager.waitForMessages('wait-cleanup-timeout', {
        cursor: '0',
        timeoutMs: 2000,
      });

      await vi.advanceTimersByTimeAsync(2500);
      await promise;

      // Verify listener was cleaned up after timeout
      expect(manager.listenerCount('message')).toBe(listenersBefore);
    });

    it('throws for non-existent session', () => {
      expect(() =>
        manager.waitForMessages('nonexistent', { timeoutMs: 1000 }),
      ).toThrow(/no message buffer/i);
    });

    it('uses default timeout when not specified', async () => {
      const mockSession = createMockSession({ id: 'wait-default' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      const promise = manager.waitForMessages('wait-default', {
        cursor: '0',
      });

      // Default timeout should be 30s — advance past it
      await vi.advanceTimersByTimeAsync(31_000);

      const result = await promise;
      expect(result.timedOut).toBe(true);
    });

    it('applies redaction to waited messages', async () => {
      const mockSession = createMockSession({ id: 'wait-redact' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      const promise = manager.waitForMessages('wait-redact', {
        cursor: '0',
        timeoutMs: 5000,
      });

      await vi.advanceTimersByTimeAsync(100);
      mockSession._emitMessage({
        type: 'text',
        content: 'Authorization: Bearer secret123abc',
        timestamp: Date.now(),
      });

      const result = await promise;

      expect(result.messages[0].content).toContain('Bearer [REDACTED]');
      expect(result.messages[0].content).not.toContain('secret123abc');
    });

    it('respects limit parameter', async () => {
      const mockSession = createMockSession({ id: 'wait-limit' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      // Pre-fill buffer with many messages
      for (let i = 0; i < 10; i++) {
        mockSession._emitMessage({
          type: 'text',
          content: `Message ${i}`,
          timestamp: Date.now(),
        });
      }

      const result = await manager.waitForMessages('wait-limit', {
        cursor: '0',
        limit: 3,
        timeoutMs: 5000,
      });

      expect(result.messages).toHaveLength(3);
      expect(result.nextCursor).toBe('3');
    });

    it('clamps timeout to minimum bound (1000ms)', async () => {
      const mockSession = createMockSession({ id: 'wait-clamp-min' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      const promise = manager.waitForMessages('wait-clamp-min', {
        cursor: '0',
        timeoutMs: 100, // Below minimum of 1000ms
      });

      // At 500ms it should NOT have timed out yet (clamped to 1000ms)
      await vi.advanceTimersByTimeAsync(500);

      // At 1100ms it should have timed out (clamped to 1000ms min)
      await vi.advanceTimersByTimeAsync(600);

      const result = await promise;
      expect(result.timedOut).toBe(true);
    });

    it('clamps timeout to maximum bound (120000ms)', async () => {
      const mockSession = createMockSession({ id: 'wait-clamp-max' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      const promise = manager.waitForMessages('wait-clamp-max', {
        cursor: '0',
        timeoutMs: 300_000, // Above maximum of 120000ms
      });

      // At 120s it should time out (clamped to max)
      await vi.advanceTimersByTimeAsync(121_000);

      const result = await promise;
      expect(result.timedOut).toBe(true);
    });

    it('ignores messages for other sessions', async () => {
      const session1 = createMockSession({ id: 'wait-ignore-1' });
      mockProvider._setNextSession(session1);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      const session2 = createMockSession({ id: 'wait-ignore-2' });
      mockProvider._setNextSession(session2);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      // Wait on session 1
      const promise = manager.waitForMessages('wait-ignore-1', {
        cursor: '0',
        timeoutMs: 3000,
      });

      // Message arrives on session 2 — should NOT wake up the wait
      await vi.advanceTimersByTimeAsync(100);
      session2._emitMessage({
        type: 'text',
        content: 'Wrong session',
        timestamp: Date.now(),
      });

      // Wait should still be pending — advance to timeout
      await vi.advanceTimersByTimeAsync(3500);

      const result = await promise;
      // Should have timed out since no messages arrived on session 1
      expect(result.timedOut).toBe(true);
      expect(result.messages).toHaveLength(0);
    });

    it('cleans up sessionEnd listener after resolve', async () => {
      const mockSession = createMockSession({ id: 'wait-cleanup-end' });
      mockProvider._setNextSession(mockSession);
      await manager.spawn(
        'claude',
        { cwd: '/tmp/test', mode: 'remote' },
        'user-1',
      );

      const endListenersBefore = manager.listenerCount('sessionEnd');

      const promise = manager.waitForMessages('wait-cleanup-end', {
        cursor: '0',
        timeoutMs: 10_000,
      });

      // Verify sessionEnd listener was added
      expect(manager.listenerCount('sessionEnd')).toBeGreaterThan(
        endListenersBefore,
      );

      // Resolve by sending a message
      await vi.advanceTimersByTimeAsync(100);
      mockSession._emitMessage({
        type: 'text',
        content: 'Done',
        timestamp: Date.now(),
      });

      await promise;

      // Verify sessionEnd listener was cleaned up
      expect(manager.listenerCount('sessionEnd')).toBe(endListenersBefore);
    });
  });
});

// Import SessionEvent type for event handler typing
import type { SessionEvent } from '../../src/types/index.js';
