import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createMockSession,
  createMockProvider,
} from '../helpers/mock-provider.js';
import { SessionManager } from '../../src/session-manager.js';
import { SessionACL } from '../../src/security/acl.js';

describe('Provider registration', () => {
  let manager: SessionManager;
  let acl: SessionACL;

  beforeEach(() => {
    acl = new SessionACL();
    manager = new SessionManager({
      acl,
      cwdWhitelist: [],
      maxSessions: 10,
      headless: false,
    });
  });

  describe('registerProvider', () => {
    it('registers a single provider', () => {
      const provider = createMockProvider('claude');
      manager.registerProvider(provider);

      expect(manager.getProvider('claude')).toBe(provider);
    });

    it('registers multiple providers', () => {
      const claude = createMockProvider('claude');
      const gemini = createMockProvider('gemini');
      const codex = createMockProvider('codex');

      manager.registerProvider(claude);
      manager.registerProvider(gemini);
      manager.registerProvider(codex);

      expect(manager.getProvider('claude')).toBe(claude);
      expect(manager.getProvider('gemini')).toBe(gemini);
      expect(manager.getProvider('codex')).toBe(codex);
    });

    it('overwrites provider with same name', () => {
      const claude1 = createMockProvider('claude');
      const claude2 = createMockProvider('claude');

      manager.registerProvider(claude1);
      manager.registerProvider(claude2);

      expect(manager.getProvider('claude')).toBe(claude2);
    });

    it('returns undefined for unregistered provider', () => {
      expect(manager.getProvider('nonexistent')).toBeUndefined();
    });
  });

  describe('spawn with multiple providers', () => {
    it('spawns sessions from different providers', async () => {
      const claude = createMockProvider('claude');
      const gemini = createMockProvider('gemini');

      const claudeSession = createMockSession({ id: 'claude-1', provider: 'claude' });
      const geminiSession = createMockSession({ id: 'gemini-1', provider: 'gemini' });

      claude._setNextSession(claudeSession);
      gemini._setNextSession(geminiSession);

      manager.registerProvider(claude);
      manager.registerProvider(gemini);

      const s1 = await manager.spawn('claude', { cwd: '/tmp', mode: 'remote' }, 'user-1');
      const s2 = await manager.spawn('gemini', { cwd: '/tmp', mode: 'remote' }, 'user-1');

      expect(s1.provider).toBe('claude');
      expect(s2.provider).toBe('gemini');
      expect(manager.size).toBe(2);
    });

    it('rejects spawn for unknown provider', async () => {
      await expect(
        manager.spawn('unknown', { cwd: '/tmp', mode: 'remote' }),
      ).rejects.toThrow(/unknown provider/i);
    });
  });

  describe('list with provider filter', () => {
    it('filters sessions by provider name', async () => {
      const claude = createMockProvider('claude');
      const gemini = createMockProvider('gemini');

      manager.registerProvider(claude);
      manager.registerProvider(gemini);

      const cs = createMockSession({ id: 'c1', provider: 'claude' });
      const gs = createMockSession({ id: 'g1', provider: 'gemini' });

      claude._setNextSession(cs);
      await manager.spawn('claude', { cwd: '/tmp', mode: 'remote' });

      gemini._setNextSession(gs);
      await manager.spawn('gemini', { cwd: '/tmp', mode: 'remote' });

      const claudeSessions = manager.list({ provider: 'claude' });
      expect(claudeSessions).toHaveLength(1);
      expect(claudeSessions[0].provider).toBe('claude');

      const geminiSessions = manager.list({ provider: 'gemini' });
      expect(geminiSessions).toHaveLength(1);
      expect(geminiSessions[0].provider).toBe('gemini');

      const allSessions = manager.list();
      expect(allSessions).toHaveLength(2);
    });
  });

  describe('ACL enforcement across providers', () => {
    it('sessions from different providers have separate ACL entries', async () => {
      const claude = createMockProvider('claude');
      const gemini = createMockProvider('gemini');

      manager.registerProvider(claude);
      manager.registerProvider(gemini);

      const cs = createMockSession({ id: 'c1' });
      const gs = createMockSession({ id: 'g1' });

      claude._setNextSession(cs);
      await manager.spawn('claude', { cwd: '/tmp', mode: 'remote' }, 'user-a');

      gemini._setNextSession(gs);
      await manager.spawn('gemini', { cwd: '/tmp', mode: 'remote' }, 'user-b');

      // user-a owns c1 but not g1
      expect(acl.canAccess('user-a', 'c1')).toBe(true);
      expect(acl.canAccess('user-a', 'g1')).toBe(false);

      // user-b owns g1 but not c1
      expect(acl.canAccess('user-b', 'g1')).toBe(true);
      expect(acl.canAccess('user-b', 'c1')).toBe(false);
    });
  });

  describe('mixed provider resume', () => {
    it('resumes a session using the correct provider', async () => {
      const claude = createMockProvider('claude');
      const gemini = createMockProvider('gemini');

      manager.registerProvider(claude);
      manager.registerProvider(gemini);

      const original = createMockSession({ id: 'c1', provider: 'claude' });
      claude._setNextSession(original);
      await manager.spawn('claude', { cwd: '/tmp', mode: 'remote' }, 'user-1');

      const resumed = createMockSession({ id: 'c1', provider: 'claude', mode: 'local' });
      claude._setNextSession(resumed);
      const result = await manager.resume('c1', { mode: 'local' });

      expect(result.id).toBe('c1');
      // The resume should have used the claude provider, not gemini
      expect(claude.resume).toHaveBeenCalled();
      expect(gemini.resume).not.toHaveBeenCalled();
    });
  });
});
