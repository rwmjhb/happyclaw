import { describe, it, expect, beforeEach } from 'vitest';
import {
  GeminiParserRules,
  type ParserRuleSet,
} from '../../src/providers/parser-rules.js';

describe('GeminiParserRules', () => {
  let parser: GeminiParserRules;

  beforeEach(() => {
    parser = new GeminiParserRules();
  });

  describe('parse — text classification', () => {
    it('parses plain text as type "text"', () => {
      const msg = parser.parse('Hello, world!');
      expect(msg).not.toBeNull();
      expect(msg!.type).toBe('text');
      expect(msg!.content).toBe('Hello, world!');
    });

    it('returns null for empty input', () => {
      expect(parser.parse('')).toBeNull();
      expect(parser.parse('   ')).toBeNull();
    });

    it('parses "Using tool:" as tool_use', () => {
      const msg = parser.parse('Using tool: Read /tmp/file.txt');
      expect(msg).not.toBeNull();
      expect(msg!.type).toBe('tool_use');
      expect(msg!.content).toContain('Read');
    });

    it('parses "Running:" as tool_use', () => {
      const msg = parser.parse('Running: npm test');
      expect(msg).not.toBeNull();
      expect(msg!.type).toBe('tool_use');
    });

    it('parses "Tool result:" as tool_result', () => {
      const msg = parser.parse('Tool result: success');
      expect(msg).not.toBeNull();
      expect(msg!.type).toBe('tool_result');
    });

    it('parses "Error:" as error', () => {
      const msg = parser.parse('Error: file not found');
      expect(msg).not.toBeNull();
      expect(msg!.type).toBe('error');
      expect(msg!.content).toContain('file not found');
    });

    it('parses "Failed:" as error', () => {
      const msg = parser.parse('FAILED: compilation error');
      expect(msg).not.toBeNull();
      expect(msg!.type).toBe('error');
    });

    it('parses "Thinking..." as thinking', () => {
      const msg = parser.parse('Thinking...');
      expect(msg).not.toBeNull();
      expect(msg!.type).toBe('thinking');
    });

    it('parses "Analyzing..." as thinking', () => {
      const msg = parser.parse('Analyzing...');
      expect(msg).not.toBeNull();
      expect(msg!.type).toBe('thinking');
    });

    it('includes timestamp on all messages', () => {
      const msg = parser.parse('hello');
      expect(msg!.timestamp).toBeGreaterThan(0);
    });
  });

  describe('parse — code blocks', () => {
    it('accumulates code block and emits on close', () => {
      // Start code block
      expect(parser.parse('```typescript')).toBeNull();

      // Code lines are accumulated
      expect(parser.parse('const x = 1;')).toBeNull();
      expect(parser.parse('console.log(x);')).toBeNull();

      // Close code block
      const msg = parser.parse('```');
      expect(msg).not.toBeNull();
      expect(msg!.type).toBe('code');
      expect(msg!.content).toContain('const x = 1;');
      expect(msg!.content).toContain('console.log(x);');
      expect(msg!.metadata?.language).toBe('typescript');
    });

    it('handles code block without language', () => {
      parser.parse('```');
      parser.parse('some code');
      const msg = parser.parse('```');
      expect(msg!.type).toBe('code');
      expect(msg!.metadata?.language).toBeUndefined();
    });

    it('handles empty code block', () => {
      parser.parse('```python');
      const msg = parser.parse('```');
      expect(msg!.type).toBe('code');
      expect(msg!.content).toBe('');
      expect(msg!.metadata?.language).toBe('python');
    });
  });

  describe('detectEvent', () => {
    it('detects permission prompt with "Allow?"', () => {
      const event = parser.detectEvent('Allow? (y/n)', 'sess-1');
      expect(event).not.toBeNull();
      expect(event!.type).toBe('permission_request');
      expect(event!.severity).toBe('urgent');
      expect(event!.sessionId).toBe('sess-1');
      expect(event!.permissionDetail).toBeDefined();
      expect(event!.permissionDetail!.requestId).toMatch(/^pty-/);
    });

    it('detects permission prompt with "[Y/n]"', () => {
      const event = parser.detectEvent('Do you want to continue? [Y/n]', 'sess-1');
      expect(event).not.toBeNull();
      expect(event!.type).toBe('permission_request');
    });

    it('detects permission prompt with "[yes/no]"', () => {
      const event = parser.detectEvent('Proceed? [yes/no]', 'sess-1');
      expect(event).not.toBeNull();
      expect(event!.type).toBe('permission_request');
    });

    it('detects error events', () => {
      const event = parser.detectEvent('Error: connection refused', 'sess-1');
      expect(event).not.toBeNull();
      expect(event!.type).toBe('error');
      expect(event!.severity).toBe('warning');
    });

    it('detects waiting for input with ">"', () => {
      const event = parser.detectEvent('> ', 'sess-1');
      expect(event).not.toBeNull();
      expect(event!.type).toBe('waiting_for_input');
    });

    it('detects waiting for input with ">>>"', () => {
      const event = parser.detectEvent('>>> ', 'sess-1');
      expect(event).not.toBeNull();
      expect(event!.type).toBe('waiting_for_input');
    });

    it('returns null for regular text', () => {
      const event = parser.detectEvent('Just normal output', 'sess-1');
      expect(event).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(parser.detectEvent('', 'sess-1')).toBeNull();
      expect(parser.detectEvent('   ', 'sess-1')).toBeNull();
    });
  });

  describe('filterInput', () => {
    it('allows regular text input', () => {
      expect(parser.filterInput('hello world')).toBe('hello world');
    });

    it('allows multiline text', () => {
      expect(parser.filterInput('line1\nline2')).toBe('line1\nline2');
    });

    it('blocks Ctrl+C (\\x03)', () => {
      expect(parser.filterInput('\x03')).toBeNull();
    });

    it('blocks Ctrl+D (\\x04)', () => {
      expect(parser.filterInput('\x04')).toBeNull();
    });

    it('blocks Ctrl+Z (\\x1a)', () => {
      expect(parser.filterInput('\x1a')).toBeNull();
    });

    it('blocks ESC sequences (\\x1b)', () => {
      expect(parser.filterInput('\x1b[2J')).toBeNull(); // Clear screen
    });

    it('blocks input containing control chars mid-string', () => {
      expect(parser.filterInput('hello\x03world')).toBeNull();
    });
  });
});

describe('ParserRuleSet interface compliance', () => {
  it('GeminiParserRules implements ParserRuleSet', () => {
    const rules: ParserRuleSet = new GeminiParserRules();

    // Verify all required methods exist
    expect(typeof rules.parse).toBe('function');
    expect(typeof rules.detectEvent).toBe('function');
    expect(typeof rules.filterInput).toBe('function');
  });
});
