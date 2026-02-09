import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HealthChecker } from '../../src/health.js';
import { SessionManager } from '../../src/session-manager.js';
import { SessionACL } from '../../src/security/acl.js';
import {
  createMockSession,
  createMockProvider,
} from '../helpers/mock-provider.js';
import type { SessionEvent } from '../../src/types/index.js';

describe('HealthChecker', () => {
  let manager: SessionManager;
  let acl: SessionACL;
  let mockProvider: ReturnType<typeof createMockProvider>;

  beforeEach(() => {
    vi.useFakeTimers();
    acl = new SessionACL();
    manager = new SessionManager({ acl, cwdWhitelist: [], maxSessions: 10 });
    mockProvider = createMockProvider('claude');
    manager.registerProvider(mockProvider);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('start/stop', () => {
    it('starts the periodic heartbeat', () => {
      const checker = new HealthChecker(manager, { intervalMs: 5000 });
      expect(checker.running).toBe(false);

      checker.start();
      expect(checker.running).toBe(true);

      checker.stop();
    });

    it('stops the periodic heartbeat', () => {
      const checker = new HealthChecker(manager, { intervalMs: 5000 });
      checker.start();
      checker.stop();
      expect(checker.running).toBe(false);
    });

    it('start is a no-op if already running', () => {
      const checker = new HealthChecker(manager, { intervalMs: 5000 });
      checker.start();
      checker.start(); // second call is no-op
      expect(checker.running).toBe(true);
      checker.stop();
    });

    it('stop is a no-op if not running', () => {
      const checker = new HealthChecker(manager);
      expect(() => checker.stop()).not.toThrow();
    });
  });

  describe('configurable interval', () => {
    it('uses default 30_000ms when no option provided', () => {
      const checker = new HealthChecker(manager);
      // We can't directly inspect intervalMs, but we can verify it doesn't throw
      checker.start();
      expect(checker.running).toBe(true);
      checker.stop();
    });

    it('uses custom interval', () => {
      const checker = new HealthChecker(manager, { intervalMs: 1000 });
      checker.start();
      expect(checker.running).toBe(true);
      checker.stop();
    });
  });

  describe('checkSession', () => {
    it('returns true for a live process (current PID)', async () => {
      const mockSession = createMockSession({
        id: 'live-session',
        pid: process.pid, // Current process — always alive
      });
      mockProvider._setNextSession(mockSession);
      await manager.spawn('claude', { cwd: '/tmp', mode: 'remote' }, 'user-1');

      const checker = new HealthChecker(manager);
      const alive = await checker.checkSession('live-session');
      expect(alive).toBe(true);
    });

    it('returns false for a dead PID and cleans up session', async () => {
      const mockSession = createMockSession({
        id: 'dead-session',
        pid: 999999999, // Almost certainly dead
      });
      mockProvider._setNextSession(mockSession);
      await manager.spawn('claude', { cwd: '/tmp', mode: 'remote' }, 'user-1');

      const events: SessionEvent[] = [];
      manager.on('event', (e: SessionEvent) => events.push(e));

      const checker = new HealthChecker(manager);
      const alive = await checker.checkSession('dead-session');

      expect(alive).toBe(false);

      // Should emit an error event
      const errorEvent = events.find(
        (e) => e.type === 'error' && e.severity === 'urgent',
      );
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.summary).toContain('999999999');

      // Session should be cleaned up
      expect(() => manager.get('dead-session')).toThrow(/not found/i);
    });

    it('does not emit false positive for live PIDs', async () => {
      const mockSession = createMockSession({
        id: 'healthy',
        pid: process.pid,
      });
      mockProvider._setNextSession(mockSession);
      await manager.spawn('claude', { cwd: '/tmp', mode: 'remote' }, 'user-1');

      const events: SessionEvent[] = [];
      manager.on('event', (e: SessionEvent) => events.push(e));

      const checker = new HealthChecker(manager);
      await checker.checkSession('healthy');

      // No error events should have been emitted
      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(0);
    });
  });

  describe('periodic checkAll', () => {
    it('checks all sessions on interval tick', async () => {
      const s1 = createMockSession({ id: 's1', pid: process.pid });
      const s2 = createMockSession({ id: 's2', pid: 999999999 });

      mockProvider._setNextSession(s1);
      await manager.spawn('claude', { cwd: '/tmp', mode: 'remote' }, 'user-1');
      mockProvider._setNextSession(s2);
      await manager.spawn('claude', { cwd: '/tmp', mode: 'remote' }, 'user-1');

      expect(manager.size).toBe(2);

      const checker = new HealthChecker(manager, { intervalMs: 1000 });
      checker.start();

      // Advance past interval
      await vi.advanceTimersByTimeAsync(1100);

      // s2 (dead PID) should have been cleaned up
      expect(manager.size).toBe(1);
      expect(() => manager.get('s1')).not.toThrow();
      expect(() => manager.get('s2')).toThrow(/not found/i);

      checker.stop();
    });
  });
});
