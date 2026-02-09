import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuditLogger } from '../../src/audit.js';
import type { AuditEntry } from '../../src/audit.js';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  default: {
    appendFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(''),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

// Must import AFTER vi.mock
import fs from 'node:fs/promises';

describe('AuditLogger', () => {
  let logger: AuditLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = new AuditLogger({ logDir: '/tmp/test-audit' });
  });

  describe('log', () => {
    it('appends a JSON line to the log file', async () => {
      const entry: AuditEntry = {
        timestamp: 1000,
        userId: 'alice',
        action: 'spawn',
        sessionId: 'sess-1',
        details: { provider: 'claude' },
      };

      await logger.log(entry);

      expect(fs.appendFile).toHaveBeenCalledWith(
        '/tmp/test-audit/audit.log',
        JSON.stringify(entry) + '\n',
        'utf-8',
      );
    });

    it('auto-creates the directory on first log', async () => {
      await logger.log({
        timestamp: 1000,
        userId: 'alice',
        action: 'spawn',
        sessionId: 'sess-1',
      });

      expect(fs.mkdir).toHaveBeenCalledWith('/tmp/test-audit', {
        recursive: true,
      });
    });

    it('only creates directory once (cached)', async () => {
      await logger.log({
        timestamp: 1000,
        userId: 'alice',
        action: 'spawn',
        sessionId: 'sess-1',
      });
      await logger.log({
        timestamp: 2000,
        userId: 'bob',
        action: 'stop',
        sessionId: 'sess-2',
      });

      expect(fs.mkdir).toHaveBeenCalledTimes(1);
    });

    it('includes details field when provided', async () => {
      const entry: AuditEntry = {
        timestamp: 1000,
        userId: 'alice',
        action: 'send',
        sessionId: 'sess-1',
        details: { inputLength: 42 },
      };

      await logger.log(entry);

      const written = (fs.appendFile as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      const parsed = JSON.parse(written.trim());
      expect(parsed.details).toEqual({ inputLength: 42 });
    });
  });

  describe('readLog', () => {
    it('returns empty array when log file does not exist', async () => {
      (fs.readFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('ENOENT'),
      );

      const entries = await logger.readLog();
      expect(entries).toEqual([]);
    });

    it('parses JSON lines and returns in reverse chronological order', async () => {
      const lines = [
        JSON.stringify({ timestamp: 1000, userId: 'alice', action: 'spawn', sessionId: 's1' }),
        JSON.stringify({ timestamp: 2000, userId: 'bob', action: 'stop', sessionId: 's2' }),
        JSON.stringify({ timestamp: 3000, userId: 'alice', action: 'send', sessionId: 's1' }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(lines);

      const entries = await logger.readLog();
      expect(entries).toHaveLength(3);
      // Newest first
      expect(entries[0].timestamp).toBe(3000);
      expect(entries[1].timestamp).toBe(2000);
      expect(entries[2].timestamp).toBe(1000);
    });

    it('filters by since timestamp', async () => {
      const lines = [
        JSON.stringify({ timestamp: 1000, userId: 'a', action: 'spawn', sessionId: 's1' }),
        JSON.stringify({ timestamp: 2000, userId: 'a', action: 'stop', sessionId: 's1' }),
        JSON.stringify({ timestamp: 3000, userId: 'a', action: 'send', sessionId: 's1' }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(lines);

      const entries = await logger.readLog({ since: 2000 });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.timestamp >= 2000)).toBe(true);
    });

    it('limits number of returned entries', async () => {
      const lines = [
        JSON.stringify({ timestamp: 1000, userId: 'a', action: 'a', sessionId: 's1' }),
        JSON.stringify({ timestamp: 2000, userId: 'a', action: 'b', sessionId: 's1' }),
        JSON.stringify({ timestamp: 3000, userId: 'a', action: 'c', sessionId: 's1' }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(lines);

      const entries = await logger.readLog({ limit: 2 });
      expect(entries).toHaveLength(2);
      // Should be the 2 newest (reversed order)
      expect(entries[0].timestamp).toBe(3000);
      expect(entries[1].timestamp).toBe(2000);
    });

    it('skips malformed JSON lines', async () => {
      const lines = [
        JSON.stringify({ timestamp: 1000, userId: 'a', action: 'a', sessionId: 's1' }),
        'not valid json',
        JSON.stringify({ timestamp: 3000, userId: 'a', action: 'c', sessionId: 's1' }),
      ].join('\n');

      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(lines);

      const entries = await logger.readLog();
      expect(entries).toHaveLength(2);
    });

    it('handles empty log file', async () => {
      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce('');

      const entries = await logger.readLog();
      expect(entries).toEqual([]);
    });
  });

  describe('action types', () => {
    it.each(['spawn', 'stop', 'send', 'read', 'resume', 'switch', 'respond', 'list', 'summary'])(
      'records %s action correctly',
      async (action) => {
        await logger.log({
          timestamp: Date.now(),
          userId: 'alice',
          action,
          sessionId: 'sess-1',
        });

        const written = (fs.appendFile as ReturnType<typeof vi.fn>).mock
          .calls[0][1] as string;
        const parsed = JSON.parse(written.trim());
        expect(parsed.action).toBe(action);
      },
    );
  });

  describe('filePath', () => {
    it('uses default path when no logDir specified', () => {
      const defaultLogger = new AuditLogger();
      expect(defaultLogger.filePath).toContain('audit.log');
      expect(defaultLogger.filePath).toContain('.happyclaw');
    });

    it('uses custom logDir', () => {
      const customLogger = new AuditLogger({ logDir: '/custom/path' });
      expect(customLogger.filePath).toBe('/custom/path/audit.log');
    });
  });

  describe('error handling', () => {
    it('propagates write errors', async () => {
      (fs.appendFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('write failed'),
      );

      await expect(
        logger.log({
          timestamp: 1000,
          userId: 'a',
          action: 'spawn',
          sessionId: 's1',
        }),
      ).rejects.toThrow('write failed');
    });
  });
});
