import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type {
  JsonRpcNotification,
} from '../../src/providers/mcp-bridge.js';
import type {
  SessionEvent,
  SessionMessage,
} from '../../src/types/index.js';

// Track mock children for per-test access
let mockChildren: any[] = [];

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as any;
    child.stdin = { write: vi.fn() };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 99999;
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      child.emit('exit', 0, null);
    });
    mockChildren.push(child);
    return child;
  }),
}));

// Import after mock
import { McpStdioBridge } from '../../src/providers/mcp-bridge.js';
import { CodexMCPProvider, CodexMCPSession } from '../../src/providers/codex-mcp.js';

describe('McpStdioBridge', () => {
  let bridge: McpStdioBridge;
  let child: any;

  beforeEach(() => {
    mockChildren = [];
    bridge = new McpStdioBridge('codex', ['--mcp'], { cwd: '/tmp' });
    child = mockChildren[mockChildren.length - 1];
  });

  it('starts as alive', () => {
    expect(bridge.isAlive).toBe(true);
  });

  it('has a pid', () => {
    expect(bridge.pid).toBe(99999);
  });

  describe('writeMessage format', () => {
    it('sends Content-Length framed JSON-RPC via notify', () => {
      bridge.notify('test/method', { foo: 'bar' });

      const writeCall = child.stdin.write.mock.calls[0]?.[0] as string;
      expect(writeCall).toContain('Content-Length:');
      expect(writeCall).toContain('"jsonrpc":"2.0"');
      expect(writeCall).toContain('"method":"test/method"');
    });
  });

  describe('processBuffer (Content-Length framing)', () => {
    it('parses a complete JSON-RPC response and resolves pending request', async () => {
      const requestPromise = bridge.request('test/method', { arg: 1 });

      const response = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { status: 'ok' },
      });
      const frame = `Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`;
      child.stdout.emit('data', Buffer.from(frame));

      const result = await requestPromise;
      expect(result).toEqual({ status: 'ok' });
    });

    it('rejects pending request on error response', async () => {
      const requestPromise = bridge.request('fail/method');

      const response = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600, message: 'Invalid Request' },
      });
      const frame = `Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`;
      child.stdout.emit('data', Buffer.from(frame));

      await expect(requestPromise).rejects.toThrow(/Invalid Request/);
    });

    it('emits notification events for server-initiated messages', () => {
      const notifications: JsonRpcNotification[] = [];
      bridge.on('notification', (n: JsonRpcNotification) => notifications.push(n));

      const notification = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { text: 'hello' },
      });
      const frame = `Content-Length: ${Buffer.byteLength(notification)}\r\n\r\n${notification}`;
      child.stdout.emit('data', Buffer.from(frame));

      expect(notifications).toHaveLength(1);
      expect(notifications[0].method).toBe('notifications/message');
    });

    it('handles partial data (multiple chunks)', async () => {
      const requestPromise = bridge.request('chunked/test');

      const response = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: 'chunked',
      });
      const frame = `Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`;

      const mid = Math.floor(frame.length / 2);
      child.stdout.emit('data', Buffer.from(frame.slice(0, mid)));
      child.stdout.emit('data', Buffer.from(frame.slice(mid)));

      const result = await requestPromise;
      expect(result).toBe('chunked');
    });

    it('handles malformed header gracefully', () => {
      const notifications: JsonRpcNotification[] = [];
      bridge.on('notification', (n: JsonRpcNotification) => notifications.push(n));

      // Malformed header followed by valid message
      const malformed = 'Bad-Header: oops\r\n\r\n';
      const valid = JSON.stringify({
        jsonrpc: '2.0',
        method: 'test/ok',
        params: {},
      });
      const validFrame = `Content-Length: ${Buffer.byteLength(valid)}\r\n\r\n${valid}`;

      child.stdout.emit('data', Buffer.from(malformed + validFrame));

      expect(notifications).toHaveLength(1);
      expect(notifications[0].method).toBe('test/ok');
    });
  });

  describe('close', () => {
    it('rejects all pending requests on close', async () => {
      const p1 = bridge.request('pending/1');
      const p2 = bridge.request('pending/2');

      await bridge.close(true);

      await expect(p1).rejects.toThrow(/closed/i);
      await expect(p2).rejects.toThrow(/closed/i);
    });

    it('marks bridge as not alive after close', async () => {
      await bridge.close(true);
      expect(bridge.isAlive).toBe(false);
    });
  });

  describe('exit handling', () => {
    it('rejects pending requests when child process exits', async () => {
      const p = bridge.request('will/fail');

      child.emit('exit', 1, 'SIGTERM');

      await expect(p).rejects.toThrow(/exited/i);
    });
  });
});

describe('CodexMCPProvider', () => {
  beforeEach(() => {
    mockChildren = [];
  });

  it('has name "codex"', () => {
    const provider = new CodexMCPProvider();
    expect(provider.name).toBe('codex');
  });

  it('supports local and remote modes', () => {
    const provider = new CodexMCPProvider();
    expect(provider.supportedModes).toContain('local');
    expect(provider.supportedModes).toContain('remote');
  });
});

describe('CodexMCPSession notification handling', () => {
  let session: CodexMCPSession;
  let events: SessionEvent[];
  let messages: SessionMessage[];

  beforeEach(() => {
    mockChildren = [];
    events = [];
    messages = [];

    session = new CodexMCPSession({
      cwd: '/tmp/test',
      mode: 'remote',
    });

    session.onEvent((e) => events.push(e));
    session.onMessage((m) => messages.push(m));
  });

  it('has provider set to "codex"', () => {
    expect(session.provider).toBe('codex');
  });

  it('generates a session id', () => {
    expect(session.id).toMatch(/^codex-/);
  });

  it('uses resumeSessionId when provided', () => {
    const resumed = new CodexMCPSession({
      cwd: '/tmp',
      mode: 'remote',
      resumeSessionId: 'my-codex-session',
    });
    expect(resumed.id).toBe('my-codex-session');
  });

  describe('message notification', () => {
    it('emits messages from notifications/message', () => {
      const bridge = (session as any).bridge as McpStdioBridge;
      bridge.emit('notification', {
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { text: 'Hello from Codex' },
      } satisfies JsonRpcNotification);

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('text');
      expect(messages[0].content).toContain('Hello from Codex');
    });
  });

  describe('tool progress notification', () => {
    it('emits tool_use messages from notifications/tools/call_progress', () => {
      const bridge = (session as any).bridge as McpStdioBridge;
      bridge.emit('notification', {
        jsonrpc: '2.0',
        method: 'notifications/tools/call_progress',
        params: { name: 'write_file', progress: 'Writing /tmp/test.txt...' },
      } satisfies JsonRpcNotification);

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('tool_use');
      expect(messages[0].metadata?.tool).toBe('write_file');
    });
  });

  describe('permission request notification', () => {
    it('emits permission_request events', () => {
      const bridge = (session as any).bridge as McpStdioBridge;
      bridge.emit('notification', {
        jsonrpc: '2.0',
        method: 'notifications/permission_request',
        params: {
          request_id: 'req-abc',
          tool_name: 'execute_command',
          input: { command: 'rm -rf /tmp/test' },
        },
      } satisfies JsonRpcNotification);

      const permEvent = events.find((e) => e.type === 'permission_request');
      expect(permEvent).toBeDefined();
      expect(permEvent!.permissionDetail?.requestId).toBe('req-abc');
      expect(permEvent!.permissionDetail?.toolName).toBe('execute_command');
    });
  });

  describe('error notification', () => {
    it('emits error events from notifications/error', () => {
      const bridge = (session as any).bridge as McpStdioBridge;
      bridge.emit('notification', {
        jsonrpc: '2.0',
        method: 'notifications/error',
        params: { message: 'Rate limit exceeded' },
      } satisfies JsonRpcNotification);

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.summary).toContain('Rate limit exceeded');
    });
  });

  describe('unknown notification', () => {
    it('ignores unknown notification methods', () => {
      const bridge = (session as any).bridge as McpStdioBridge;
      bridge.emit('notification', {
        jsonrpc: '2.0',
        method: 'notifications/unknown',
        params: {},
      } satisfies JsonRpcNotification);

      expect(messages).toHaveLength(0);
    });
  });

  describe('read', () => {
    it('returns buffered messages with cursor pagination', async () => {
      const bridge = (session as any).bridge as McpStdioBridge;

      for (let i = 0; i < 3; i++) {
        bridge.emit('notification', {
          jsonrpc: '2.0',
          method: 'notifications/message',
          params: { text: `message ${i}` },
        } satisfies JsonRpcNotification);
      }

      const result = await session.read({ limit: 2 });
      expect(result.messages).toHaveLength(2);
      expect(result.nextCursor).toBe('2');

      const result2 = await session.read({ cursor: '2', limit: 2 });
      expect(result2.messages).toHaveLength(1);
    });
  });
});
