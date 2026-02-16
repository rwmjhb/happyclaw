import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createMockSession,
  createMockProvider,
} from '../helpers/mock-provider.js';
import type { CallerContext } from '../../src/types/index.js';

import { createPluginTools } from '../../src/plugin.js';
import { SessionManager } from '../../src/session-manager.js';
import { SessionACL } from '../../src/security/acl.js';

describe('Plugin tools', () => {
  let manager: SessionManager;
  let acl: SessionACL;
  let tools: ReturnType<typeof createPluginTools>;
  let mockProvider: ReturnType<typeof createMockProvider>;

  const ownerCtx: CallerContext = { userId: 'owner-1', channelId: 'ch-1' };
  const otherCtx: CallerContext = { userId: 'other-user', channelId: 'ch-2' };

  beforeEach(async () => {
    acl = new SessionACL();
    manager = new SessionManager({
      acl,
      cwdWhitelist: [],
      maxSessions: 10,
      headless: false,
    });
    mockProvider = createMockProvider('claude');
    manager.registerProvider(mockProvider);

    tools = createPluginTools(manager);

    // Pre-create a session owned by owner-1
    const mockSession = createMockSession({ id: 'test-session' });
    mockProvider._setNextSession(mockSession);
    await manager.spawn(
      'claude',
      { cwd: '/tmp/test', mode: 'remote' },
      ownerCtx.userId,
    );
  });

  describe('session.list', () => {
    it('filters by ACL — only returns sessions owned by caller', async () => {
      const result = await tools['session.list'].handler({}, ownerCtx);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('test-session');
    });

    it('returns empty for non-owner', async () => {
      const result = await tools['session.list'].handler({}, otherCtx);
      expect(result).toHaveLength(0);
    });

    it('includes enriched metadata (status)', async () => {
      const result = await tools['session.list'].handler({}, ownerCtx);
      expect(result[0].status).toBe('running');
    });
  });

  describe('session.spawn', () => {
    it('passes ownerId to manager.spawn', async () => {
      const newSession = createMockSession({ id: 'spawned-session' });
      mockProvider._setNextSession(newSession);

      const result = await tools['session.spawn'].handler(
        { provider: 'claude', cwd: '/tmp/new', mode: 'remote' },
        ownerCtx,
      );

      expect(result.id).toBe('spawned-session');
      expect(acl.getOwner('spawned-session')).toBe('owner-1');
    });
  });

  describe('session.send', () => {
    it('forwards regular input and returns handled: false', async () => {
      const session = manager.get('test-session');

      const result = await tools['session.send'].handler(
        { sessionId: 'test-session', input: 'hello' },
        ownerCtx,
      );

      expect(result.handled).toBe(false);
      expect(session.send).toHaveBeenCalledWith('hello');
    });

    it('intercepts /clear command and returns handled: true', async () => {
      const session = manager.get('test-session');

      const result = await tools['session.send'].handler(
        { sessionId: 'test-session', input: '/clear' },
        ownerCtx,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toBeDefined();
      expect(session.send).toHaveBeenCalledWith('/clear');
    });

    it('ACL check fails for non-owner', async () => {
      await expect(
        tools['session.send'].handler(
          { sessionId: 'test-session', input: 'hello' },
          otherCtx,
        ),
      ).rejects.toThrow(/denied|not own/i);
    });
  });

  describe('session.read', () => {
    it('cursor is forwarded to readMessages', async () => {
      const spy = vi.spyOn(manager, 'readMessages');

      await tools['session.read'].handler(
        { sessionId: 'test-session', cursor: 'abc-123', limit: 20 },
        ownerCtx,
      );

      expect(spy).toHaveBeenCalledWith('test-session', {
        cursor: 'abc-123',
        limit: 20,
      });

      spy.mockRestore();
    });

    it('ACL check for non-owner', async () => {
      await expect(
        tools['session.read'].handler(
          { sessionId: 'test-session' },
          otherCtx,
        ),
      ).rejects.toThrow(/denied|not own/i);
    });
  });

  describe('session.respond', () => {
    it('ACL check passes and delegates to respondToPermission', async () => {
      const session = manager.get('test-session');

      await tools['session.respond'].handler(
        { sessionId: 'test-session', requestId: 'req-1', approved: true },
        ownerCtx,
      );

      expect(session.respondToPermission).toHaveBeenCalledWith('req-1', true);
    });

    it('ACL check fails for non-owner', async () => {
      await expect(
        tools['session.respond'].handler(
          { sessionId: 'test-session', requestId: 'req-1', approved: true },
          otherCtx,
        ),
      ).rejects.toThrow(/denied|not own/i);
    });
  });

  describe('session.stop', () => {
    it('ACL check passes and delegates to manager.stop', async () => {
      const spy = vi.spyOn(manager, 'stop').mockResolvedValue(undefined);

      await tools['session.stop'].handler(
        { sessionId: 'test-session', force: false },
        ownerCtx,
      );

      expect(spy).toHaveBeenCalledWith('test-session', false);

      spy.mockRestore();
    });

    it('ACL check fails for non-owner', async () => {
      await expect(
        tools['session.stop'].handler(
          { sessionId: 'test-session' },
          otherCtx,
        ),
      ).rejects.toThrow(/denied|not own/i);
    });
  });
});
