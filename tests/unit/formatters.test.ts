import { describe, it, expect } from 'vitest';
import type { SessionMessage, SessionEvent } from '../../src/types/index.js';
import {
  formatForTelegram,
  formatForDiscord,
  formatAsEmbed,
  formatPermissionEmbed,
} from '../../src/formatters/index.js';
import {
  cleanCodexCommand,
  isDiffContent,
  isActionCommand,
  formatMessage,
} from '../../src/formatters/telegram.js';

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

// ---------------------------------------------------------------------------
// Codex-specific formatter helpers
// ---------------------------------------------------------------------------

describe('cleanCodexCommand', () => {
  it('extracts command from /bin/zsh,-lc,<cmd> format', () => {
    expect(cleanCodexCommand('/bin/zsh,-lc,pnpm test -- --run foo.test.ts'))
      .toBe('pnpm test -- --run foo.test.ts');
  });

  it('extracts command from /bin/bash,-lc,<cmd> format', () => {
    expect(cleanCodexCommand('/bin/bash,-lc,npm run build'))
      .toBe('npm run build');
  });

  it('handles -c flag without -l', () => {
    expect(cleanCodexCommand('/bin/zsh,-c,ls -la'))
      .toBe('ls -la');
  });

  it('returns raw string when no shell prefix matches', () => {
    expect(cleanCodexCommand('git status')).toBe('git status');
  });

  it('handles multiline commands', () => {
    const raw = '/bin/zsh,-lc,echo "line1"\necho "line2"';
    expect(cleanCodexCommand(raw)).toBe('echo "line1"\necho "line2"');
  });
});

describe('isDiffContent', () => {
  it('detects diff --git prefix', () => {
    expect(isDiffContent('diff --git a/foo.ts b/foo.ts\n--- a/foo.ts')).toBe(true);
  });

  it('detects --- a/ and +++ b/ patterns', () => {
    expect(isDiffContent('some header\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@')).toBe(true);
  });

  it('returns false for normal text', () => {
    expect(isDiffContent('Hello world')).toBe(false);
  });

  it('returns false for text mentioning diff without markers', () => {
    expect(isDiffContent('The diff looks good')).toBe(false);
  });
});

describe('isActionCommand', () => {
  it('recognizes package manager commands as actions', () => {
    expect(isActionCommand('pnpm test')).toBe(true);
    expect(isActionCommand('npm run build')).toBe(true);
    expect(isActionCommand('yarn install')).toBe(true);
    expect(isActionCommand('bun run dev')).toBe(true);
    expect(isActionCommand('npx create-react-app my-app')).toBe(true);
    expect(isActionCommand('pnpx tsx src/main.ts')).toBe(true);
    expect(isActionCommand('bunx vitest')).toBe(true);
  });

  it('recognizes git commands as actions', () => {
    expect(isActionCommand('git status')).toBe(true);
    expect(isActionCommand('git push origin main')).toBe(true);
    expect(isActionCommand('git commit -m "fix"')).toBe(true);
  });

  it('recognizes build/toolchain commands as actions', () => {
    expect(isActionCommand('make build')).toBe(true);
    expect(isActionCommand('cargo test')).toBe(true);
    expect(isActionCommand('go build ./...')).toBe(true);
    expect(isActionCommand('tsc --noEmit')).toBe(true);
    expect(isActionCommand('esbuild src/main.ts')).toBe(true);
    expect(isActionCommand('vite build')).toBe(true);
    expect(isActionCommand('turbo run build')).toBe(true);
  });

  it('recognizes test runners as actions', () => {
    expect(isActionCommand('vitest run')).toBe(true);
    expect(isActionCommand('jest --watch')).toBe(true);
    expect(isActionCommand('pytest -v tests/')).toBe(true);
  });

  it('recognizes container/infra commands as actions', () => {
    expect(isActionCommand('docker build -t myapp .')).toBe(true);
    expect(isActionCommand('kubectl apply -f deploy.yaml')).toBe(true);
    expect(isActionCommand('terraform plan')).toBe(true);
  });

  it('recognizes Python/pip package manager actions', () => {
    expect(isActionCommand('pip install requests')).toBe(true);
    expect(isActionCommand('uv run pytest')).toBe(true);
    expect(isActionCommand('poetry add flask')).toBe(true);
  });

  it('recognizes network tool commands as actions', () => {
    expect(isActionCommand('curl -X POST https://api.example.com')).toBe(true);
    expect(isActionCommand('wget https://example.com/file.tar.gz')).toBe(true);
    expect(isActionCommand('ssh user@host')).toBe(true);
    expect(isActionCommand('rsync -avz src/ dest/')).toBe(true);
  });

  it('recognizes file mutation commands as actions', () => {
    expect(isActionCommand('mkdir -p src/new-dir')).toBe(true);
    expect(isActionCommand('rm -rf node_modules')).toBe(true);
    expect(isActionCommand('mv old.ts new.ts')).toBe(true);
    expect(isActionCommand('cp template.ts copy.ts')).toBe(true);
    expect(isActionCommand('chmod +x script.sh')).toBe(true);
    expect(isActionCommand('touch newfile.ts')).toBe(true);
  });

  it('recognizes script execution as actions', () => {
    expect(isActionCommand('python script.py')).toBe(true);
    expect(isActionCommand('python3 manage.py migrate')).toBe(true);
    expect(isActionCommand('node server.js')).toBe(true);
    expect(isActionCommand('deno run app.ts')).toBe(true);
  });

  it('does NOT treat python -c one-liners as actions', () => {
    expect(isActionCommand('python -c "print(1)"')).toBe(false);
    expect(isActionCommand('python3 -c "import sys; print(sys.version)"')).toBe(false);
    expect(isActionCommand('node -e "console.log(1)"')).toBe(false);
  });

  it('does NOT treat read/exploration commands as actions', () => {
    expect(isActionCommand('cat package.json')).toBe(false);
    expect(isActionCommand('head -20 src/main.ts')).toBe(false);
    expect(isActionCommand('tail -f log.txt')).toBe(false);
    expect(isActionCommand('less README.md')).toBe(false);
    expect(isActionCommand('ls -la src/')).toBe(false);
    expect(isActionCommand('find . -name "*.ts"')).toBe(false);
    expect(isActionCommand('stat package.json')).toBe(false);
    expect(isActionCommand('wc -l src/main.ts')).toBe(false);
  });

  it('does NOT treat text processing/inspection commands as actions', () => {
    expect(isActionCommand('sed -n "1,320p" src/main.ts')).toBe(false);
    expect(isActionCommand('grep -r "TODO" src/')).toBe(false);
    expect(isActionCommand('awk "{print $1}" data.txt')).toBe(false);
    expect(isActionCommand('sort names.txt')).toBe(false);
    expect(isActionCommand('jq ".dependencies" package.json')).toBe(false);
    expect(isActionCommand('echo hello')).toBe(false);
  });
});

describe('formatMessage (Codex-specific)', () => {
  it('cleans CodexBash tool_use commands', () => {
    const msg: SessionMessage = {
      type: 'tool_use',
      content: '/bin/zsh,-lc,pnpm test',
      timestamp: Date.now(),
      metadata: { tool: 'CodexBash' },
    };
    const result = formatMessage(msg);
    expect(result).toContain('pnpm test');
    expect(result).not.toContain('/bin/zsh');
  });

  it('skips CodexBash non-action commands (cat, grep, sed, etc.)', () => {
    for (const cmd of ['cat package.json', 'grep -r TODO src/', 'sed -n "1,320p" file.ts']) {
      const msg: SessionMessage = {
        type: 'tool_use',
        content: `/bin/zsh,-lc,${cmd}`,
        timestamp: Date.now(),
        metadata: { tool: 'CodexBash' },
      };
      expect(formatMessage(msg)).toBe('');
    }
  });

  it('shows CodexBash action commands (git, pnpm, docker, etc.)', () => {
    for (const cmd of ['git push', 'pnpm test', 'docker build .']) {
      const msg: SessionMessage = {
        type: 'tool_use',
        content: `/bin/zsh,-lc,${cmd}`,
        timestamp: Date.now(),
        metadata: { tool: 'CodexBash' },
      };
      expect(formatMessage(msg)).not.toBe('');
    }
  });

  it('skips CodexBash "Command completed" results', () => {
    const msg: SessionMessage = {
      type: 'tool_result',
      content: 'Command completed',
      timestamp: Date.now(),
      metadata: { tool: 'CodexBash' },
    };
    expect(formatMessage(msg)).toBe('');
  });

  it('skips diff content in tool_result', () => {
    const msg: SessionMessage = {
      type: 'tool_result',
      content: 'diff --git a/foo b/foo',
      timestamp: Date.now(),
      metadata: { tool: 'CodexBash' },
    };
    expect(formatMessage(msg)).toBe('');
  });

  it('skips CodexPatch generic confirmations', () => {
    const msg: SessionMessage = {
      type: 'tool_result',
      content: 'Patch applied successfully',
      timestamp: Date.now(),
      metadata: { tool: 'CodexPatch' },
    };
    expect(formatMessage(msg)).toBe('');
  });

  it('skips diff content leaked as text type', () => {
    const msg: SessionMessage = {
      type: 'text',
      content: 'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts',
      timestamp: Date.now(),
    };
    expect(formatMessage(msg)).toBe('');
  });

  it('skips thinking messages', () => {
    const msg: SessionMessage = {
      type: 'thinking',
      content: 'Let me think about this...',
      timestamp: Date.now(),
    };
    expect(formatMessage(msg)).toBe('');
  });

  it('skips silent tools (TodoWrite, Task, etc.)', () => {
    for (const tool of ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'EnterPlanMode']) {
      const msg: SessionMessage = {
        type: 'tool_use',
        content: 'some content',
        timestamp: Date.now(),
        metadata: { tool },
      };
      expect(formatMessage(msg)).toBe('');
    }
  });

  it('truncates long tool_use content to 120 chars', () => {
    const msg: SessionMessage = {
      type: 'tool_use',
      content: 'A'.repeat(200),
      timestamp: Date.now(),
      metadata: { tool: 'Bash' },
    };
    const result = formatMessage(msg);
    expect(result).toContain('...');
    // 117 chars + "..." = 120
    expect(result).not.toContain('A'.repeat(200));
  });

  it('shows short tool_result content', () => {
    const msg: SessionMessage = {
      type: 'tool_result',
      content: 'OK',
      timestamp: Date.now(),
      metadata: { tool: 'Bash' },
    };
    const result = formatMessage(msg);
    expect(result).toContain('OK');
  });

  it('skips long tool_result content (>200 chars)', () => {
    const msg: SessionMessage = {
      type: 'tool_result',
      content: 'X'.repeat(201),
      timestamp: Date.now(),
      metadata: { tool: 'Bash' },
    };
    expect(formatMessage(msg)).toBe('');
  });
});
