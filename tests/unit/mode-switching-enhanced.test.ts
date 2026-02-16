import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  createMockSession,
  createMockProvider,
} from '../helpers/mock-provider.js';
import { SessionManager } from '../../src/session-manager.js';
import { SessionACL } from '../../src/security/acl.js';
import type { SessionEvent, SwitchState } from '../../src/types/index.js';

describe('Mode switching (enhanced)', () => {
  let manager: SessionManager;
  let acl: SessionACL;
  let mockProvider: ReturnType<typeof createMockProvider>;

  beforeEach(() => {
    vi.useFakeTimers();
    acl = new SessionACL();
    manager = new SessionManager({
      acl,
      cwdWhitelist: [],
      maxSessions: 10,
      drainTimeoutMs: 100, // Short timeout for fast tests
      headless: false,
    });
    mockProvider = createMockProvider('claude');
    manager.registerProvider(mockProvider);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function spawnSession(id: string = 'switch-session') {
    const session = createMockSession({ id });
    mockProvider._setNextSession(session);
    await manager.spawn('claude', { cwd: '/tmp/test', mode: 'remote' }, 'owner-1');
    return session;
  }

  describe('drain timeout', () => {
    it('forces switch when drain times out', async () => {
      const session = await spawnSession();

      // switchMode on the mock session never resolves (simulates hang)
      session.switchMode = vi.fn(
        () => new Promise<void>(() => {}), // Never resolves
      );

      // Prepare a new session for post-switch resume
      const newSession = createMockSession({ id: 'switch-session', mode: 'local' });
      mockProvider._setNextSession(newSession);

      const switchPromise = manager.switchMode('switch-session', 'local');

      // Advance past drain timeout
      await vi.advanceTimersByTimeAsync(150);

      await switchPromise;

      // Should have transitioned through states and settled on 'running'
      expect(manager.getSwitchState('switch-session')).toBe('running');
    });

    it('emits warning event when drain times out', async () => {
      const session = await spawnSession();
      session.switchMode = vi.fn(() => new Promise<void>(() => {}));

      const newSession = createMockSession({ id: 'switch-session', mode: 'local' });
      mockProvider._setNextSession(newSession);

      const events: SessionEvent[] = [];
      manager.on('event', (e: SessionEvent) => events.push(e));

      const switchPromise = manager.switchMode('switch-session', 'local');
      await vi.advanceTimersByTimeAsync(150);
      await switchPromise;

      const warningEvent = events.find(
        (e) => e.severity === 'warning' && e.summary.includes('Drain'),
      );
      expect(warningEvent).toBeDefined();
      expect(warningEvent!.type).toBe('error');
    });

    it('proceeds normally when drain completes before timeout', async () => {
      const session = await spawnSession();

      // switchMode resolves immediately
      session.switchMode = vi.fn().mockResolvedValue(undefined);

      const newSession = createMockSession({ id: 'switch-session', mode: 'local' });
      mockProvider._setNextSession(newSession);

      await manager.switchMode('switch-session', 'local');

      expect(manager.getSwitchState('switch-session')).toBe('running');
    });
  });

  describe('state transitions', () => {
    it('emits stateTransition events during successful switch', async () => {
      const session = await spawnSession();
      session.switchMode = vi.fn().mockResolvedValue(undefined);

      const newSession = createMockSession({ id: 'switch-session', mode: 'local' });
      mockProvider._setNextSession(newSession);

      const transitions: { from: SwitchState; to: SwitchState }[] = [];
      manager.on('stateTransition', (t: { sessionId: string; from: SwitchState; to: SwitchState }) => {
        transitions.push({ from: t.from, to: t.to });
      });

      await manager.switchMode('switch-session', 'local');

      // Should see: running -> draining -> switching -> running
      expect(transitions).toEqual(
        expect.arrayContaining([
          { from: 'running', to: 'draining' },
          { from: 'draining', to: 'switching' },
          { from: 'switching', to: 'running' },
        ]),
      );
    });

    it('transitions to error on resume failure', async () => {
      const session = await spawnSession();
      session.switchMode = vi.fn().mockResolvedValue(undefined);

      // Provider.resume throws
      (mockProvider.resume as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Resume failed'),
      );

      const events: SessionEvent[] = [];
      manager.on('event', (e: SessionEvent) => events.push(e));

      await manager.switchMode('switch-session', 'local');

      // Should be in error state
      expect(manager.getSwitchState('switch-session')).toBe('error');

      // Should emit urgent error event
      const errorEvent = events.find(
        (e) => e.severity === 'urgent' && e.summary.includes('Mode switch failed'),
      );
      expect(errorEvent).toBeDefined();
    });

    it('removes session from map on switch failure', async () => {
      const session = await spawnSession();
      session.switchMode = vi.fn().mockResolvedValue(undefined);

      (mockProvider.resume as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Resume failed'),
      );

      await manager.switchMode('switch-session', 'local');

      // Session should be removed from active management
      expect(() => manager.get('switch-session')).toThrow(/not found/i);
    });

    it('removes ACL on switch failure', async () => {
      const session = await spawnSession();
      session.switchMode = vi.fn().mockResolvedValue(undefined);

      (mockProvider.resume as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Resume failed'),
      );

      await manager.switchMode('switch-session', 'local');

      // ACL should be cleared
      expect(acl.canAccess('owner-1', 'switch-session')).toBe(false);
    });
  });

  describe('concurrent switch rejection', () => {
    it('rejects switch when already draining', async () => {
      const session = await spawnSession();

      // switchMode hangs — stays in draining
      session.switchMode = vi.fn(() => new Promise<void>(() => {}));

      // Start first switch (will enter draining and hang)
      const firstSwitch = manager.switchMode('switch-session', 'local');

      // Give the microtask queue time to process
      await vi.advanceTimersByTimeAsync(0);

      // Second switch should reject because state is 'draining'
      await expect(
        manager.switchMode('switch-session', 'remote'),
      ).rejects.toThrow(/draining.*cannot switch/i);

      // Clean up: advance past timeout so firstSwitch resolves
      const newSession = createMockSession({ id: 'switch-session', mode: 'local' });
      mockProvider._setNextSession(newSession);
      await vi.advanceTimersByTimeAsync(150);
      await firstSwitch;
    });

    it('rejects switch when in error state', async () => {
      const session = await spawnSession();
      session.switchMode = vi.fn().mockResolvedValue(undefined);

      // Cause an error state via failed resume
      (mockProvider.resume as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('fail'),
      );
      await manager.switchMode('switch-session', 'local');

      expect(manager.getSwitchState('switch-session')).toBe('error');

      // Attempting switch on errored session should throw
      // (Session is removed from sessions map, so get() will fail)
      await expect(
        manager.switchMode('switch-session', 'remote'),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('no-op for same mode', () => {
    it('returns immediately when target mode equals current mode', async () => {
      const session = await spawnSession();

      const transitions: unknown[] = [];
      manager.on('stateTransition', (t: unknown) => transitions.push(t));

      await manager.switchMode('switch-session', 'remote'); // Already remote

      // No state transitions should have fired
      expect(transitions).toHaveLength(0);
      expect(manager.getSwitchState('switch-session')).toBe('running');
    });
  });

  describe('persistence integration during switch', () => {
    it('updates persistence after successful switch', async () => {
      const mockPersistence = {
        add: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        removeMany: vi.fn().mockResolvedValue(undefined),
        load: vi.fn().mockResolvedValue([]),
        save: vi.fn().mockResolvedValue(undefined),
        path: '/tmp/fake/sessions.json',
      };

      const persistManager = new SessionManager({
        acl,
        cwdWhitelist: [],
        maxSessions: 10,
        drainTimeoutMs: 100,
        persistence: mockPersistence as any,
        headless: false,
      });
      persistManager.registerProvider(mockProvider);

      const session = createMockSession({ id: 'persist-switch' });
      mockProvider._setNextSession(session);
      await persistManager.spawn('claude', { cwd: '/tmp/test', mode: 'remote' }, 'owner-1');

      session.switchMode = vi.fn().mockResolvedValue(undefined);
      const newSession = createMockSession({ id: 'persist-switch', mode: 'local' });
      mockProvider._setNextSession(newSession);

      await persistManager.switchMode('persist-switch', 'local');

      // Persistence.update should have been called with new mode
      expect(mockPersistence.update).toHaveBeenCalledWith('persist-switch', {
        mode: 'local',
        pid: newSession.pid,
      });
    });

    it('removes from persistence on switch failure', async () => {
      const mockPersistence = {
        add: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        removeMany: vi.fn().mockResolvedValue(undefined),
        load: vi.fn().mockResolvedValue([]),
        save: vi.fn().mockResolvedValue(undefined),
        path: '/tmp/fake/sessions.json',
      };

      const persistManager = new SessionManager({
        acl,
        cwdWhitelist: [],
        maxSessions: 10,
        drainTimeoutMs: 100,
        persistence: mockPersistence as any,
        headless: false,
      });
      persistManager.registerProvider(mockProvider);

      const session = createMockSession({ id: 'persist-fail' });
      mockProvider._setNextSession(session);
      await persistManager.spawn('claude', { cwd: '/tmp/test', mode: 'remote' }, 'owner-1');

      session.switchMode = vi.fn().mockResolvedValue(undefined);
      (mockProvider.resume as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Resume failed'),
      );

      await persistManager.switchMode('persist-fail', 'local');

      // Persistence.remove should have been called
      expect(mockPersistence.remove).toHaveBeenCalledWith('persist-fail');
    });
  });
});
