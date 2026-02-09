import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockSession } from '../helpers/mock-provider.js';
import { parseCommand, listCommands } from '../../src/commands.js';
import type { ProviderSession, SessionMessage } from '../../src/types/index.js';

describe('parseCommand', () => {
  let session: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    vi.clearAllMocks();
    session = createMockSession({ id: 'cmd-session' });
  });

  describe('regular input (not a command)', () => {
    it('returns handled: false for plain text', async () => {
      const result = await parseCommand(session, 'Hello, Claude!');
      expect(result.handled).toBe(false);
      expect(result.response).toBeUndefined();
    });

    it('returns handled: false for empty string', async () => {
      const result = await parseCommand(session, '');
      expect(result.handled).toBe(false);
    });

    it('returns handled: false for whitespace-only input', async () => {
      const result = await parseCommand(session, '   ');
      expect(result.handled).toBe(false);
    });

    it('returns handled: false for text starting with / mid-sentence', async () => {
      // Text that has / but not at the start after trimming
      const result = await parseCommand(session, 'use /clear please');
      expect(result.handled).toBe(false);
    });
  });

  describe('/clear', () => {
    it('sends /clear to session and returns handled response', async () => {
      const result = await parseCommand(session, '/clear');

      expect(result.handled).toBe(true);
      expect(result.response).toContain('cmd-session');
      expect(result.response).toContain('cleared');
      expect(session.send).toHaveBeenCalledWith('/clear');
    });

    it('handles leading whitespace', async () => {
      const result = await parseCommand(session, '  /clear  ');
      expect(result.handled).toBe(true);
      expect(session.send).toHaveBeenCalledWith('/clear');
    });

    it('is case-insensitive', async () => {
      const result = await parseCommand(session, '/CLEAR');
      expect(result.handled).toBe(true);
    });
  });

  describe('/compact', () => {
    it('sends /compact to session without args', async () => {
      const result = await parseCommand(session, '/compact');

      expect(result.handled).toBe(true);
      expect(result.response).toContain('Compaction requested');
      expect(session.send).toHaveBeenCalledWith('/compact');
    });

    it('forwards args to session', async () => {
      const result = await parseCommand(session, '/compact keep last 5 messages');

      expect(result.handled).toBe(true);
      expect(session.send).toHaveBeenCalledWith('/compact keep last 5 messages');
    });
  });

  describe('/cost', () => {
    it('returns cost info from last result message', async () => {
      const mockMessages: SessionMessage[] = [
        { type: 'text', content: 'Hello!', timestamp: Date.now() },
        { type: 'result', content: 'Total cost: $0.05, 2500 tokens', timestamp: Date.now() },
      ];
      (session as any).read = vi.fn().mockResolvedValue({
        messages: mockMessages,
        nextCursor: '2',
      });

      const result = await parseCommand(session, '/cost');

      expect(result.handled).toBe(true);
      expect(result.response).toContain('cost info');
      expect(result.response).toContain('Total cost: $0.05');
    });

    it('returns "no cost info" when no result messages', async () => {
      (session as any).read = vi.fn().mockResolvedValue({
        messages: [
          { type: 'text', content: 'Hi', timestamp: Date.now() },
        ],
        nextCursor: '1',
      });

      const result = await parseCommand(session, '/cost');

      expect(result.handled).toBe(true);
      expect(result.response).toContain('No cost information');
    });

    it('returns "no cost info" when no messages at all', async () => {
      (session as any).read = vi.fn().mockResolvedValue({
        messages: [],
        nextCursor: '0',
      });

      const result = await parseCommand(session, '/cost');

      expect(result.handled).toBe(true);
      expect(result.response).toContain('No cost information');
    });

    it('reads with limit: 20', async () => {
      const result = await parseCommand(session, '/cost');

      expect(session.read).toHaveBeenCalledWith({ limit: 20 });
    });
  });

  describe('unknown commands', () => {
    it('returns handled: false for unrecognized slash command', async () => {
      const result = await parseCommand(session, '/unknown');
      expect(result.handled).toBe(false);
    });

    it('returns handled: false for /help (not registered)', async () => {
      const result = await parseCommand(session, '/help');
      expect(result.handled).toBe(false);
    });
  });
});

describe('listCommands', () => {
  it('returns all registered commands', () => {
    const commands = listCommands();
    expect(commands).toHaveLength(3);

    const names = commands.map((c) => c.command);
    expect(names).toContain('/clear');
    expect(names).toContain('/compact');
    expect(names).toContain('/cost');
  });

  it('each command has a description', () => {
    const commands = listCommands();
    for (const cmd of commands) {
      expect(cmd.description).toBeTruthy();
      expect(cmd.description.length).toBeGreaterThan(5);
    }
  });
});
