import { describe, it, expect } from 'vitest';
import { summarizeSession, formatSummaryText } from '../../src/summary.js';
import type { SessionMessage } from '../../src/types/index.js';

function makeMsg(
  overrides: Partial<SessionMessage> = {},
): SessionMessage {
  return {
    type: overrides.type ?? 'text',
    content: overrides.content ?? 'test',
    timestamp: overrides.timestamp ?? Date.now(),
    metadata: overrides.metadata,
  };
}

describe('summarizeSession', () => {
  describe('empty array handling', () => {
    it('returns zero-value summary for empty messages', () => {
      const summary = summarizeSession([]);
      expect(summary.totalMessages).toBe(0);
      expect(summary.messagesByType).toEqual({});
      expect(summary.toolsUsed).toEqual([]);
      expect(summary.filesModified).toEqual([]);
      expect(summary.errorsCount).toBe(0);
      expect(summary.lastActivity).toBe(0);
      expect(summary.status).toBe('running');
      expect(summary.durationMs).toBe(0);
    });
  });

  describe('message type counts', () => {
    it('counts messages by type', () => {
      const messages = [
        makeMsg({ type: 'text', timestamp: 1000 }),
        makeMsg({ type: 'text', timestamp: 2000 }),
        makeMsg({ type: 'code', timestamp: 3000 }),
        makeMsg({ type: 'error', timestamp: 4000 }),
      ];

      const summary = summarizeSession(messages);
      expect(summary.totalMessages).toBe(4);
      expect(summary.messagesByType).toEqual({
        text: 2,
        code: 1,
        error: 1,
      });
    });

    it('counts errors correctly', () => {
      const messages = [
        makeMsg({ type: 'error', timestamp: 1000 }),
        makeMsg({ type: 'error', timestamp: 2000 }),
        makeMsg({ type: 'text', timestamp: 3000 }),
      ];

      const summary = summarizeSession(messages);
      expect(summary.errorsCount).toBe(2);
    });
  });

  describe('tool extraction', () => {
    it('extracts unique tool names from tool_use messages', () => {
      const messages = [
        makeMsg({
          type: 'tool_use',
          timestamp: 1000,
          metadata: { tool: 'Read' },
        }),
        makeMsg({
          type: 'tool_use',
          timestamp: 2000,
          metadata: { tool: 'Write' },
        }),
        makeMsg({
          type: 'tool_use',
          timestamp: 3000,
          metadata: { tool: 'Read' }, // duplicate
        }),
      ];

      const summary = summarizeSession(messages);
      expect(summary.toolsUsed).toEqual(['Read', 'Write']); // sorted, unique
    });

    it('ignores tool_use messages without metadata.tool', () => {
      const messages = [
        makeMsg({ type: 'tool_use', timestamp: 1000 }),
      ];

      const summary = summarizeSession(messages);
      expect(summary.toolsUsed).toEqual([]);
    });
  });

  describe('file extraction', () => {
    it('extracts unique file paths from metadata.file', () => {
      const messages = [
        makeMsg({
          type: 'tool_use',
          timestamp: 1000,
          metadata: { tool: 'Write', file: '/src/main.ts' },
        }),
        makeMsg({
          type: 'tool_use',
          timestamp: 2000,
          metadata: { tool: 'Write', file: '/src/index.ts' },
        }),
        makeMsg({
          type: 'tool_use',
          timestamp: 3000,
          metadata: { tool: 'Read', file: '/src/main.ts' }, // duplicate
        }),
      ];

      const summary = summarizeSession(messages);
      expect(summary.filesModified).toEqual(['/src/index.ts', '/src/main.ts']); // sorted
    });
  });

  describe('duration calculation', () => {
    it('calculates duration from first to last message', () => {
      const messages = [
        makeMsg({ timestamp: 1000 }),
        makeMsg({ timestamp: 5000 }),
        makeMsg({ timestamp: 11000 }),
      ];

      const summary = summarizeSession(messages);
      expect(summary.durationMs).toBe(10000);
    });

    it('returns 0 for a single message', () => {
      const messages = [makeMsg({ timestamp: 5000 })];
      const summary = summarizeSession(messages);
      expect(summary.durationMs).toBe(0);
    });

    it('clamps negative durations to 0', () => {
      // Edge case: out-of-order timestamps
      const messages = [
        makeMsg({ timestamp: 5000 }),
        makeMsg({ timestamp: 1000 }),
      ];
      const summary = summarizeSession(messages);
      expect(summary.durationMs).toBe(0);
    });
  });

  describe('status detection', () => {
    it('returns "completed" when last message is result', () => {
      const messages = [
        makeMsg({ type: 'text', timestamp: 1000 }),
        makeMsg({ type: 'result', timestamp: 2000 }),
      ];

      const summary = summarizeSession(messages);
      expect(summary.status).toBe('completed');
    });

    it('returns "error" when last message is error', () => {
      const messages = [
        makeMsg({ type: 'text', timestamp: 1000 }),
        makeMsg({ type: 'error', timestamp: 2000 }),
      ];

      const summary = summarizeSession(messages);
      expect(summary.status).toBe('error');
    });

    it('returns "running" for other last message types', () => {
      const messages = [
        makeMsg({ type: 'text', timestamp: 1000 }),
        makeMsg({ type: 'code', timestamp: 2000 }),
      ];

      const summary = summarizeSession(messages);
      expect(summary.status).toBe('running');
    });
  });

  describe('lastActivity', () => {
    it('returns the timestamp of the last message', () => {
      const messages = [
        makeMsg({ timestamp: 1000 }),
        makeMsg({ timestamp: 5000 }),
      ];

      const summary = summarizeSession(messages);
      expect(summary.lastActivity).toBe(5000);
    });
  });
});

describe('formatSummaryText', () => {
  it('formats a basic summary', () => {
    const text = formatSummaryText({
      totalMessages: 5,
      messagesByType: { text: 3, code: 2 },
      toolsUsed: [],
      filesModified: [],
      errorsCount: 0,
      lastActivity: 5000,
      status: 'running',
      durationMs: 4000,
    });

    expect(text).toContain('Session summary: 5 messages');
    expect(text).toContain('3 text');
    expect(text).toContain('2 code');
    expect(text).toContain('Duration: 4s');
    expect(text).toContain('Status: running');
  });

  it('includes tools used when present', () => {
    const text = formatSummaryText({
      totalMessages: 3,
      messagesByType: { tool_use: 3 },
      toolsUsed: ['Read', 'Write'],
      filesModified: [],
      errorsCount: 0,
      lastActivity: 3000,
      status: 'running',
      durationMs: 2000,
    });

    expect(text).toContain('Tools used: Read, Write');
  });

  it('includes files modified when present', () => {
    const text = formatSummaryText({
      totalMessages: 2,
      messagesByType: { tool_use: 2 },
      toolsUsed: ['Write'],
      filesModified: ['/src/main.ts', '/src/index.ts'],
      errorsCount: 0,
      lastActivity: 2000,
      status: 'running',
      durationMs: 1000,
    });

    expect(text).toContain('Files modified: /src/main.ts, /src/index.ts');
  });

  it('includes error count when present', () => {
    const text = formatSummaryText({
      totalMessages: 3,
      messagesByType: { text: 1, error: 2 },
      toolsUsed: [],
      filesModified: [],
      errorsCount: 2,
      lastActivity: 3000,
      status: 'error',
      durationMs: 2000,
    });

    expect(text).toContain('Errors: 2');
  });

  it('formats sub-second durations as ms', () => {
    const text = formatSummaryText({
      totalMessages: 1,
      messagesByType: { text: 1 },
      toolsUsed: [],
      filesModified: [],
      errorsCount: 0,
      lastActivity: 1000,
      status: 'running',
      durationMs: 500,
    });

    expect(text).toContain('Duration: 500ms');
  });

  it('formats minute durations correctly', () => {
    const text = formatSummaryText({
      totalMessages: 1,
      messagesByType: { text: 1 },
      toolsUsed: [],
      filesModified: [],
      errorsCount: 0,
      lastActivity: 1000,
      status: 'running',
      durationMs: 90_000, // 1m 30s
    });

    expect(text).toContain('Duration: 1m 30s');
  });

  it('formats hour durations correctly', () => {
    const text = formatSummaryText({
      totalMessages: 1,
      messagesByType: { text: 1 },
      toolsUsed: [],
      filesModified: [],
      errorsCount: 0,
      lastActivity: 1000,
      status: 'running',
      durationMs: 3_720_000, // 1h 2m
    });

    expect(text).toContain('Duration: 1h 2m');
  });

  it('omits tools/files/errors sections when empty/zero', () => {
    const text = formatSummaryText({
      totalMessages: 1,
      messagesByType: { text: 1 },
      toolsUsed: [],
      filesModified: [],
      errorsCount: 0,
      lastActivity: 1000,
      status: 'running',
      durationMs: 0,
    });

    expect(text).not.toContain('Tools used');
    expect(text).not.toContain('Files modified');
    expect(text).not.toContain('Errors:');
  });
});
