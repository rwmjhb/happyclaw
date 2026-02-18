import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createMockSession,
  createMockProvider,
} from '../helpers/mock-provider.js';
import { SessionManager } from '../../src/session-manager.js';
import { AuditLogger } from '../../src/audit.js';
import { registerSessionCommands } from '../../src/openclaw-commands.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegisteredCommand {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: {
    senderId?: string;
    channel: string;
    isAuthorizedSender: boolean;
    args?: string;
    commandBody: string;
  }) => unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCommandRegistry() {
  const commands = new Map<string, RegisteredCommand>();
  return {
    registerCommand: vi.fn((cmd: RegisteredCommand) => {
      commands.set(cmd.name, cmd);
    }),
    commands,
  };
}

function makeCtx(args?: string, senderId = 'user-1'): {
  senderId: string;
  channel: string;
  isAuthorizedSender: boolean;
  args?: string;
  commandBody: string;
} {
  return {
    senderId,
    channel: 'telegram',
    isAuthorizedSender: true,
    args,
    commandBody: args ?? '',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerSessionCommands', () => {
  let manager: SessionManager;
  let audit: AuditLogger;
  let registry: ReturnType<typeof createCommandRegistry>;

  beforeEach(() => {
    manager = new SessionManager({ headless: false });
    const provider = createMockProvider('claude');
    manager.registerProvider(provider);
    audit = new AuditLogger();
    registry = createCommandRegistry();
    registerSessionCommands(registry, manager, audit);
  });

  it('registers all 10 commands', () => {
    expect(registry.commands.size).toBe(10);
    const names = [...registry.commands.keys()].sort();
    expect(names).toEqual([
      'sessions_approve',
      'sessions_deny',
      'sessions_list',
      'sessions_read',
      'sessions_resume',
      'sessions_send',
      'sessions_spawn',
      'sessions_stop',
      'sessions_summary',
      'sessions_switch',
    ]);
  });

  it('all commands have requireAuth: true', () => {
    for (const cmd of registry.commands.values()) {
      expect(cmd.requireAuth).toBe(true);
    }
  });

  it('sessions_list has acceptsArgs: false', () => {
    const cmd = registry.commands.get('sessions_list')!;
    expect(cmd.acceptsArgs).toBe(false);
  });

  it('all other commands have acceptsArgs: true', () => {
    for (const [name, cmd] of registry.commands) {
      if (name !== 'sessions_list') {
        expect(cmd.acceptsArgs).toBe(true);
      }
    }
  });

  // ----- sessions_list -----

  describe('/sessions_list', () => {
    it('returns empty message when no sessions', async () => {
      const cmd = registry.commands.get('sessions_list')!;
      const result = (await cmd.handler(makeCtx())) as { text: string };
      expect(result.text).toContain('No active sessions');
    });

    it('lists sessions the user owns', async () => {
      await manager.spawn('claude', { cwd: '/tmp', mode: 'local' }, 'user-1');
      const cmd = registry.commands.get('sessions_list')!;
      const result = (await cmd.handler(makeCtx())) as { text: string };
      expect(result.text).toContain('Active sessions (1)');
      expect(result.text).toContain('claude');
      expect(result.text).toContain('/tmp');
    });

    it('does not list sessions owned by others', async () => {
      await manager.spawn('claude', { cwd: '/tmp', mode: 'local' }, 'other-user');
      const cmd = registry.commands.get('sessions_list')!;
      const result = (await cmd.handler(makeCtx())) as { text: string };
      expect(result.text).toContain('No active sessions');
    });
  });

  // ----- sessions_spawn -----

  describe('/sessions_spawn', () => {
    it('returns usage on missing args', async () => {
      const cmd = registry.commands.get('sessions_spawn')!;
      const result = (await cmd.handler(makeCtx('claude /tmp'))) as { text: string; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Usage');
    });

    it('spawns a session with correct params', async () => {
      const cmd = registry.commands.get('sessions_spawn')!;
      const result = (await cmd.handler(makeCtx('claude /tmp fix the bug please'))) as { text: string };
      expect(result.text).toContain('Session started');
      expect(result.text).toContain('claude');
      expect(result.text).toContain('/tmp');

      // Verify session was actually created
      const sessions = manager.list();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].provider).toBe('claude');
      expect(sessions[0].cwd).toContain('/tmp');
    });

    it('returns error on spawn failure', async () => {
      const cmd = registry.commands.get('sessions_spawn')!;
      // Invalid provider should fail
      const result = (await cmd.handler(makeCtx('nonexistent /tmp do stuff'))) as { text: string; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Spawn failed');
    });
  });

  // ----- sessions_send -----

  describe('/sessions_send', () => {
    it('returns usage on missing args', async () => {
      const cmd = registry.commands.get('sessions_send')!;
      const result = (await cmd.handler(makeCtx('sess-1'))) as { text: string; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Usage');
    });

    it('sends input to a session', async () => {
      const session = await manager.spawn('claude', { cwd: '/tmp', mode: 'local' }, 'user-1');
      const cmd = registry.commands.get('sessions_send')!;
      const result = (await cmd.handler(makeCtx(`${session.id} run npm test`))) as { text: string };
      expect(result.text).toContain(`Sent to ${session.id}`);
    });

    it('rejects access to sessions owned by others', async () => {
      const session = await manager.spawn('claude', { cwd: '/tmp', mode: 'local' }, 'other-user');
      const cmd = registry.commands.get('sessions_send')!;
      const result = (await cmd.handler(makeCtx(`${session.id} hello`))) as { text: string; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Send failed');
    });
  });

  // ----- sessions_read -----

  describe('/sessions_read', () => {
    it('returns usage on missing args', async () => {
      const cmd = registry.commands.get('sessions_read')!;
      const result = (await cmd.handler(makeCtx(''))) as { text: string; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Usage');
    });

    it('reads messages from a session', async () => {
      const session = await manager.spawn('claude', { cwd: '/tmp', mode: 'local' }, 'user-1');
      const cmd = registry.commands.get('sessions_read')!;
      const result = (await cmd.handler(makeCtx(session.id))) as { text: string };
      // No messages yet, should indicate empty
      expect(result.text).toContain('No recent output');
    });
  });

  // ----- sessions_stop -----

  describe('/sessions_stop', () => {
    it('returns usage on missing args', async () => {
      const cmd = registry.commands.get('sessions_stop')!;
      const result = (await cmd.handler(makeCtx(''))) as { text: string; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Usage');
    });

    it('stops a session', async () => {
      const session = await manager.spawn('claude', { cwd: '/tmp', mode: 'local' }, 'user-1');
      const cmd = registry.commands.get('sessions_stop')!;
      const result = (await cmd.handler(makeCtx(session.id))) as { text: string };
      expect(result.text).toContain('stopped');

      // Session should be gone
      expect(manager.list()).toHaveLength(0);
    });

    it('supports --force flag', async () => {
      const session = await manager.spawn('claude', { cwd: '/tmp', mode: 'local' }, 'user-1');
      const cmd = registry.commands.get('sessions_stop')!;
      const result = (await cmd.handler(makeCtx(`${session.id} --force`))) as { text: string };
      expect(result.text).toContain('stopped');
      expect(result.text).toContain('forced');
    });
  });

  // ----- sessions_approve / sessions_deny -----

  describe('/sessions_approve', () => {
    it('returns usage on missing args', async () => {
      const cmd = registry.commands.get('sessions_approve')!;
      const result = (await cmd.handler(makeCtx('sess-1'))) as { text: string; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Usage');
    });
  });

  describe('/sessions_deny', () => {
    it('returns usage on missing args', async () => {
      const cmd = registry.commands.get('sessions_deny')!;
      const result = (await cmd.handler(makeCtx(''))) as { text: string; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Usage');
    });
  });

  // ----- sessions_switch -----

  describe('/sessions_switch', () => {
    it('returns usage on invalid mode', async () => {
      const cmd = registry.commands.get('sessions_switch')!;
      const result = (await cmd.handler(makeCtx('sess-1 invalid'))) as { text: string; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Usage');
    });

    it('returns usage on missing args', async () => {
      const cmd = registry.commands.get('sessions_switch')!;
      const result = (await cmd.handler(makeCtx(''))) as { text: string; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Usage');
    });
  });

  // ----- sessions_summary -----

  describe('/sessions_summary', () => {
    it('returns usage on missing args', async () => {
      const cmd = registry.commands.get('sessions_summary')!;
      const result = (await cmd.handler(makeCtx(''))) as { text: string; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Usage');
    });
  });

  // ----- sessions_resume -----

  describe('/sessions_resume', () => {
    it('returns usage on missing args', async () => {
      const cmd = registry.commands.get('sessions_resume')!;
      const result = (await cmd.handler(makeCtx('sess-1'))) as { text: string; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Usage');
    });
  });
});
