import { describe, it, expect } from 'vitest';
import type { SessionMessage, SessionEvent } from '../../src/types/index.js';
import {
  formatForTelegram,
  formatForDiscord,
  formatAsEmbed,
  formatPermissionEmbed,
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

  it('redacts sensitive content in output', () => {
    const messages: SessionMessage[] = [
      {
        type: 'text',
        content: 'Bearer mysecrettoken123',
        timestamp: Date.now(),
      },
    ];

    const chunks = formatForDiscord(messages);
    const combined = chunks.join('');
    expect(combined).toContain('Bearer [REDACTED]');
    expect(combined).not.toContain('mysecrettoken123');
  });
});

describe('formatAsEmbed', () => {
  it('returns empty embed for no messages', () => {
    const embed = formatAsEmbed([]);
    expect(embed.title).toBe('Session Output');
    expect(embed.description).toBe('No messages.');
    expect(embed.color).toBe(0x00ff00); // green
  });

  it('formats messages into embed description', () => {
    const messages: SessionMessage[] = [
      { type: 'text', content: 'Hello from Claude', timestamp: Date.now() },
    ];

    const embed = formatAsEmbed(messages);
    expect(embed.description).toContain('Hello from Claude');
    expect(embed.fields).toBeDefined();
    expect(embed.fields!.some((f) => f.name === 'text')).toBe(true);
  });

  it('uses green color for messages without errors', () => {
    const messages: SessionMessage[] = [
      { type: 'text', content: 'ok', timestamp: Date.now() },
    ];

    const embed = formatAsEmbed(messages);
    expect(embed.color).toBe(0x00ff00);
  });

  it('uses red color for error-only messages', () => {
    const messages: SessionMessage[] = [
      { type: 'error', content: 'Failed', timestamp: Date.now() },
    ];

    const embed = formatAsEmbed(messages);
    expect(embed.color).toBe(0xff0000);
  });

  it('uses yellow color for mixed messages', () => {
    const messages: SessionMessage[] = [
      { type: 'text', content: 'ok', timestamp: Date.now() },
      { type: 'error', content: 'bad', timestamp: Date.now() },
    ];

    const embed = formatAsEmbed(messages);
    expect(embed.color).toBe(0xffff00);
  });

  it('includes type count fields', () => {
    const messages: SessionMessage[] = [
      { type: 'text', content: 'a', timestamp: Date.now() },
      { type: 'text', content: 'b', timestamp: Date.now() },
      { type: 'code', content: 'c', timestamp: Date.now() },
    ];

    const embed = formatAsEmbed(messages);
    expect(embed.fields).toBeDefined();

    const textField = embed.fields!.find((f) => f.name === 'text');
    expect(textField).toBeDefined();
    expect(textField!.value).toBe('2');

    const codeField = embed.fields!.find((f) => f.name === 'code');
    expect(codeField).toBeDefined();
    expect(codeField!.value).toBe('1');
  });

  it('includes timestamp', () => {
    const messages: SessionMessage[] = [
      { type: 'text', content: 'ok', timestamp: Date.now() },
    ];

    const embed = formatAsEmbed(messages);
    expect(embed.timestamp).toBeDefined();
  });

  it('uses "Session Summary" title for many messages', () => {
    const messages: SessionMessage[] = Array.from({ length: 11 }, (_, i) => ({
      type: 'text' as const,
      content: `msg ${i}`,
      timestamp: Date.now(),
    }));

    const embed = formatAsEmbed(messages);
    expect(embed.title).toBe('Session Summary');
  });

  it('truncates long embed descriptions', () => {
    const messages: SessionMessage[] = Array.from({ length: 100 }, (_, i) => ({
      type: 'text' as const,
      content: 'A'.repeat(100),
      timestamp: Date.now(),
    }));

    const embed = formatAsEmbed(messages);
    expect(embed.description.length).toBeLessThanOrEqual(4020); // with truncation suffix
  });

  it('redacts sensitive content in embed description', () => {
    const messages: SessionMessage[] = [
      {
        type: 'text',
        content: 'Bearer mysecrettoken123',
        timestamp: Date.now(),
      },
    ];

    const embed = formatAsEmbed(messages);
    expect(embed.description).toContain('Bearer [REDACTED]');
    expect(embed.description).not.toContain('mysecrettoken123');
  });
});

describe('formatPermissionEmbed', () => {
  it('formats a permission request event', () => {
    const event: SessionEvent = {
      type: 'permission_request',
      severity: 'urgent',
      summary: 'Tool needs approval',
      sessionId: 'sess-1',
      timestamp: Date.now(),
      permissionDetail: {
        requestId: 'req-1',
        toolName: 'Write',
        input: { file_path: '/tmp/test.txt' },
      },
    };

    const embed = formatPermissionEmbed(event);
    expect(embed.title).toBe('Permission Request');
    expect(embed.color).toBe(0xffaa00);
    expect(embed.description).toContain('Tool needs approval');
    expect(embed.footer?.text).toContain('session.respond');
    expect(embed.timestamp).toBeDefined();
  });

  it('includes tool name field', () => {
    const event: SessionEvent = {
      type: 'permission_request',
      severity: 'urgent',
      summary: 'Approval needed',
      sessionId: 'sess-1',
      timestamp: Date.now(),
      permissionDetail: {
        requestId: 'req-1',
        toolName: 'Bash',
        input: 'rm -rf /',
      },
    };

    const embed = formatPermissionEmbed(event);
    const toolField = embed.fields?.find((f) => f.name === 'Tool');
    expect(toolField).toBeDefined();
    expect(toolField!.value).toContain('Bash');
  });

  it('includes input field', () => {
    const event: SessionEvent = {
      type: 'permission_request',
      severity: 'urgent',
      summary: 'Approval needed',
      sessionId: 'sess-1',
      timestamp: Date.now(),
      permissionDetail: {
        requestId: 'req-1',
        toolName: 'Write',
        input: { file_path: '/tmp/test.txt' },
      },
    };

    const embed = formatPermissionEmbed(event);
    const inputField = embed.fields?.find((f) => f.name === 'Input');
    expect(inputField).toBeDefined();
    expect(inputField!.value).toContain('/tmp/test.txt');
  });

  it('includes decision reason when present', () => {
    const event: SessionEvent = {
      type: 'permission_request',
      severity: 'urgent',
      summary: 'Approval needed',
      sessionId: 'sess-1',
      timestamp: Date.now(),
      permissionDetail: {
        requestId: 'req-1',
        toolName: 'Write',
        input: {},
        decisionReason: 'File outside project directory',
      },
    };

    const embed = formatPermissionEmbed(event);
    const reasonField = embed.fields?.find((f) => f.name === 'Reason');
    expect(reasonField).toBeDefined();
    expect(reasonField!.value).toBe('File outside project directory');
  });

  it('redacts sensitive content in permission embed', () => {
    const event: SessionEvent = {
      type: 'permission_request',
      severity: 'urgent',
      summary: 'Tool wants to write Bearer mysecrettoken123',
      sessionId: 'sess-1',
      timestamp: Date.now(),
      permissionDetail: {
        requestId: 'req-1',
        toolName: 'Write',
        input: 'password=secret123',
      },
    };

    const embed = formatPermissionEmbed(event);
    expect(embed.description).toContain('[REDACTED]');
    expect(embed.description).not.toContain('mysecrettoken123');
  });

  it('truncates long input', () => {
    const event: SessionEvent = {
      type: 'permission_request',
      severity: 'urgent',
      summary: 'Approval needed',
      sessionId: 'sess-1',
      timestamp: Date.now(),
      permissionDetail: {
        requestId: 'req-1',
        toolName: 'Write',
        input: 'A'.repeat(300),
      },
    };

    const embed = formatPermissionEmbed(event);
    const inputField = embed.fields?.find((f) => f.name === 'Input');
    expect(inputField!.value.length).toBeLessThanOrEqual(200);
  });

  it('handles event without permissionDetail', () => {
    const event: SessionEvent = {
      type: 'permission_request',
      severity: 'urgent',
      summary: 'Generic permission',
      sessionId: 'sess-1',
      timestamp: Date.now(),
    };

    const embed = formatPermissionEmbed(event);
    expect(embed.title).toBe('Permission Request');
    expect(embed.description).toBe('Generic permission');
    // No tool/input fields
    expect(embed.fields?.find((f) => f.name === 'Tool')).toBeUndefined();
  });
});
