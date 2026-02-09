import { describe, it, expect } from 'vitest';
import type { SessionMessage } from '../../src/types/index.js';
import {
  formatForTelegram,
  formatForDiscord,
} from '../../src/formatters/index.js';

const MAX_TELEGRAM_LENGTH = 4000;
const MAX_DISCORD_LENGTH = 1900;

describe('formatForTelegram', () => {
  it('formats simple text messages within 4000 chars', () => {
    const messages: SessionMessage[] = [
      { type: 'text', content: 'Hello world', timestamp: Date.now() },
    ];

    const chunks = formatForTelegram(messages);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_TELEGRAM_LENGTH);
    }
  });

  it('handles code blocks with language metadata', () => {
    const messages: SessionMessage[] = [
      {
        type: 'code',
        content: 'const x = 42;',
        timestamp: Date.now(),
        metadata: { language: 'typescript' },
      },
    ];

    const chunks = formatForTelegram(messages);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // Should contain markdown code block syntax
    const combined = chunks.join('');
    expect(combined).toContain('```');
    expect(combined).toContain('const x = 42;');
  });

  it('splits long content across multiple chunks', () => {
    const longContent = 'A'.repeat(3000);
    const messages: SessionMessage[] = [
      { type: 'text', content: longContent, timestamp: Date.now() },
      { type: 'text', content: longContent, timestamp: Date.now() },
    ];

    const chunks = formatForTelegram(messages);
    // Each chunk should respect the limit
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_TELEGRAM_LENGTH);
    }
  });

  it('formats tool_use messages', () => {
    const messages: SessionMessage[] = [
      {
        type: 'tool_use',
        content: 'Reading file...',
        timestamp: Date.now(),
        metadata: { tool: 'Read', file: '/src/main.ts' },
      },
    ];

    const chunks = formatForTelegram(messages);
    const combined = chunks.join('');
    expect(combined).toContain('Read');
  });

  it('formats error messages', () => {
    const messages: SessionMessage[] = [
      {
        type: 'error',
        content: 'File not found: /src/missing.ts',
        timestamp: Date.now(),
      },
    ];

    const chunks = formatForTelegram(messages);
    const combined = chunks.join('');
    expect(combined).toContain('File not found');
  });

  it('handles empty messages array', () => {
    const chunks = formatForTelegram([]);
    expect(chunks).toHaveLength(0);
  });

  it('truncates very long individual messages', () => {
    const messages: SessionMessage[] = [
      {
        type: 'text',
        content: 'X'.repeat(10000),
        timestamp: Date.now(),
      },
    ];

    const chunks = formatForTelegram(messages);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_TELEGRAM_LENGTH);
    }
  });
});

describe('formatForDiscord', () => {
  it('formats within 1900 chars', () => {
    const messages: SessionMessage[] = [
      { type: 'text', content: 'Hello Discord', timestamp: Date.now() },
    ];

    const chunks = formatForDiscord(messages);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_DISCORD_LENGTH);
    }
  });

  it('splits long content for Discord limit', () => {
    const longContent = 'B'.repeat(1800);
    const messages: SessionMessage[] = [
      { type: 'text', content: longContent, timestamp: Date.now() },
      { type: 'text', content: longContent, timestamp: Date.now() },
    ];

    const chunks = formatForDiscord(messages);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_DISCORD_LENGTH);
    }
  });

  it('handles empty messages array', () => {
    const chunks = formatForDiscord([]);
    expect(chunks).toHaveLength(0);
  });
});
