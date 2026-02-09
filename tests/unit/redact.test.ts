import { describe, it, expect } from 'vitest';
import { redactSensitive } from '../../src/redact.js';
import type { RedactionConfig } from '../../src/redact.js';

describe('redactSensitive', () => {
  describe('Bearer tokens', () => {
    it('redacts Bearer tokens', () => {
      const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc123';
      const result = redactSensitive(input);
      expect(result).toContain('Bearer [REDACTED]');
      expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('handles multiple Bearer tokens', () => {
      const input = 'Bearer abc123 and Bearer def456';
      const result = redactSensitive(input);
      expect(result).toBe('Bearer [REDACTED] and Bearer [REDACTED]');
    });
  });

  describe('API key prefixes', () => {
    it('redacts sk- prefixed keys', () => {
      const result = redactSensitive('key: sk-proj-abc123def456');
      expect(result).toContain('sk-[REDACTED]');
      expect(result).not.toContain('abc123def456');
    });

    it('redacts AKIA prefixed keys (AWS)', () => {
      const result = redactSensitive('access: AKIAIOSFODNN7EXAMPLE');
      expect(result).toContain('AKIA[REDACTED]');
      expect(result).not.toContain('IOSFODNN7EXAMPLE');
    });

    it('redacts GitHub personal access tokens (ghp_)', () => {
      const result = redactSensitive('found ghp_aBcDeFgHiJkLmNoPqRsTuV here');
      expect(result).toContain('ghp_[REDACTED]');
    });

    it('redacts GitHub server tokens (ghs_)', () => {
      const result = redactSensitive('ghs_aBcDeFgHiJkLmNoPqRsTuV');
      expect(result).toContain('ghs_[REDACTED]');
    });

    it('redacts GitLab tokens (glpat-)', () => {
      const result = redactSensitive('glpat-aBcDeFgHiJkLmNoPqRsT');
      expect(result).toContain('glpat-[REDACTED]');
    });

    it('redacts Slack tokens (xoxb-, xoxp-)', () => {
      const result1 = redactSensitive('xoxb-123456789');
      expect(result1).toContain('xoxb-[REDACTED]');

      const result2 = redactSensitive('xoxp-987654321');
      expect(result2).toContain('xoxp-[REDACTED]');
    });
  });

  describe('key-value pairs with sensitive names', () => {
    it('redacts password= assignments', () => {
      const result = redactSensitive('password=mysecretpassword123');
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('mysecretpassword123');
    });

    it('redacts secret: assignments', () => {
      const result = redactSensitive('secret: supersecretvalue');
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('supersecretvalue');
    });

    it('redacts token= assignments', () => {
      const result = redactSensitive('token=abc123xyz');
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('abc123xyz');
    });

    it('redacts api_key assignments', () => {
      const result = redactSensitive('api_key=mykey123');
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('mykey123');
    });

    it('handles case-insensitive key names', () => {
      const result = redactSensitive('PASSWORD=test123');
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('test123');
    });
  });

  describe('environment variable assignments', () => {
    it('redacts export FOO_SECRET=value', () => {
      const result = redactSensitive('export MY_SECRET=supersecretvalue');
      expect(result).toContain('MY_SECRET=[REDACTED]');
      expect(result).not.toContain('supersecretvalue');
    });

    it('redacts FOO_TOKEN=value (without export)', () => {
      const result = redactSensitive('API_TOKEN=abc123');
      expect(result).toContain('API_TOKEN=[REDACTED]');
      expect(result).not.toContain('abc123');
    });

    it('redacts FOO_PASSWORD= assignments', () => {
      const result = redactSensitive('DB_PASSWORD=hunter2');
      expect(result).toContain('DB_PASSWORD=[REDACTED]');
      expect(result).not.toContain('hunter2');
    });

    it('redacts FOO_KEY= assignments', () => {
      const result = redactSensitive('AWS_ACCESS_KEY=MYKEY123');
      expect(result).toContain('AWS_ACCESS_KEY=[REDACTED]');
      expect(result).not.toContain('MYKEY123');
    });

    it('redacts FOO_CREDENTIAL= assignments', () => {
      const result = redactSensitive('SERVICE_CREDENTIAL=cred_abc');
      expect(result).toContain('SERVICE_CREDENTIAL=[REDACTED]');
      expect(result).not.toContain('cred_abc');
    });
  });

  describe('non-sensitive text preserved', () => {
    it('does not alter regular text', () => {
      const input = 'Hello world, this is a normal message.';
      expect(redactSensitive(input)).toBe(input);
    });

    it('does not alter code snippets without secrets', () => {
      const input = 'const x = 42;\nconsole.log(x);';
      expect(redactSensitive(input)).toBe(input);
    });

    it('preserves short tokens that do not look like secrets', () => {
      const input = 'status=ok result=true count=5';
      expect(redactSensitive(input)).toBe(input);
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(redactSensitive('')).toBe('');
    });

    it('handles text with no matches', () => {
      const input = 'just a normal log line with no secrets';
      expect(redactSensitive(input)).toBe(input);
    });

    it('handles multiple patterns in one string', () => {
      const input = 'Bearer abc123 and password=secret123';
      const result = redactSensitive(input);
      expect(result).toContain('Bearer [REDACTED]');
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('abc123');
      expect(result).not.toContain('secret123');
    });

    it('is safe to call multiple times (idempotent on redacted text)', () => {
      const input = 'Bearer mytoken123';
      const first = redactSensitive(input);
      const second = redactSensitive(first);
      expect(second).toBe(first);
    });
  });

  describe('custom config', () => {
    it('adds extra patterns alongside defaults', () => {
      const config: RedactionConfig = {
        extraPatterns: [
          {
            pattern: /\bCUSTOM_[A-Z]+/g,
            replacement: '[CUSTOM_REDACTED]',
          },
        ],
      };

      const result = redactSensitive('Found CUSTOM_TOKEN_ABC here', config);
      expect(result).toContain('[CUSTOM_REDACTED]');
    });

    it('replaces defaults when replaceDefaults is true', () => {
      const config: RedactionConfig = {
        replaceDefaults: true,
        extraPatterns: [
          {
            pattern: /\bfoo\b/g,
            replacement: 'bar',
          },
        ],
      };

      // Default patterns should NOT apply
      const result = redactSensitive('Bearer abc123 and foo', config);
      expect(result).toContain('Bearer abc123'); // default NOT applied
      expect(result).toContain('bar'); // custom applied
    });

    it('uses only defaults when no config provided', () => {
      const result = redactSensitive('Bearer token123');
      expect(result).toBe('Bearer [REDACTED]');
    });
  });
});
