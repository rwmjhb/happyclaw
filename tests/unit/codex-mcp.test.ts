import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type {
  JsonRpcNotification,
} from '../../src/providers/mcp-bridge.js';
import type {
  SessionEvent,
  SessionMessage,
} from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Track mock children for per-test access (used by McpStdioBridge tests)
// ---------------------------------------------------------------------------

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
  execSync: vi.fn(() => '/usr/local/bin/codex'),
}));

// ---------------------------------------------------------------------------
// Mock MCP SDK — Client + StdioClientTransport + ElicitRequestSchema
// ---------------------------------------------------------------------------

let mockNotificationHandler: ((data: any) => void) | null = null;
let mockRequestHandler: ((request: any) => Promise<any>) | null = null;
let mockCallToolFn: ReturnType<typeof vi.fn>;
let mockClientCloseFn: ReturnType<typeof vi.fn>;
let mockConnectFn: ReturnType<typeof vi.fn>;

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  const MockClient = function (this: any) {
    mockCallToolFn = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Done' }],
    });
    mockClientCloseFn = vi.fn().mockResolvedValue(undefined);
    mockConnectFn = vi.fn().mockResolvedValue(undefined);

    this.connect = mockConnectFn;
    this.close = mockClientCloseFn;
    this.callTool = mockCallToolFn;
    this.setNotificationHandler = vi.fn((_schema: any, handler: any) => {
      mockNotificationHandler = handler;
    });
    this.setRequestHandler = vi.fn((_schema: any, handler: any) => {
      mockRequestHandler = handler;
    });
  } as any;

  return { Client: MockClient };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  const MockTransport = function (this: any) {
    this.pid = 12345;
  } as any;

  return { StdioClientTransport: MockTransport };
});

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  ElicitRequestSchema: { method: 'elicitation/create' },
}));

vi.mock('zod', () => ({
  z: {
    object: vi.fn().mockReturnValue({
      passthrough: vi.fn().mockReturnValue('mock-schema'),
    }),
    literal: vi.fn().mockReturnValue('mock-literal'),
    any: vi.fn().mockReturnValue('mock-any'),
  },
}));

// Import after mocks
import { McpStdioBridge } from '../../src/providers/mcp-bridge.js';
import { CodexMCPProvider, CodexMCPSession } from '../../src/providers/codex-mcp.js';

// ---------------------------------------------------------------------------
// McpStdioBridge tests (preserved — tests valid code in mcp-bridge.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// CodexMCPProvider tests
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// CodexMCPSession tests — new implementation
// ---------------------------------------------------------------------------

describe('CodexMCPSession', () => {
  let session: CodexMCPSession;
  let events: SessionEvent[];
  let messages: SessionMessage[];

  beforeEach(() => {
    vi.useFakeTimers();
    mockChildren = [];
    mockNotificationHandler = null;
    mockRequestHandler = null;
    events = [];
    messages = [];

    session = new CodexMCPSession({
      cwd: '/tmp/test',
      mode: 'remote',
    });

    session.onEvent((e) => events.push(e));
    session.onMessage((m) => messages.push(m));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Basic properties ---

  it('has provider set to "codex"', () => {
    expect(session.provider).toBe('codex');
  });

  it('generates a pending session id before first tool call', () => {
    expect(session.id).toMatch(/^codex-pending-/);
  });

  it('has pid from transport', () => {
    expect(session.pid).toBe(12345);
  });

  it('mode defaults to remote', () => {
    expect(session.mode).toBe('remote');
  });

  // --- MCP connection ---

  it('connects to MCP server on initialization', () => {
    expect(mockConnectFn).toHaveBeenCalled();
  });

  it('registers notification handler for codex/event', () => {
    expect(mockNotificationHandler).not.toBeNull();
  });

  it('registers request handler for Elicitation', () => {
    expect(mockRequestHandler).not.toBeNull();
  });

  // --- Two-tool flow ---

  describe('two-tool flow', () => {
    it('first send calls "codex" tool', async () => {
      await session.send('Write hello world');
      await vi.advanceTimersByTimeAsync(0);

      expect(mockCallToolFn).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'codex' }),
        undefined,
        expect.any(Object),
      );

      const args = mockCallToolFn.mock.calls[0][0].arguments;
      expect(args.prompt).toBe('Write hello world');
      expect(args['approval-policy']).toBe('untrusted');
      expect(args.sandbox).toBe('workspace-write');
      expect(args.cwd).toBe('/tmp/test');
    });

    it('second send calls "codex-reply" tool', async () => {
      // Simulate first call returning session IDs
      mockCallToolFn.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Started' }],
        sessionId: 'sess-123',
        conversationId: 'conv-456',
      });

      await session.send('First message');
      await vi.advanceTimersByTimeAsync(0);

      await session.send('Follow up');
      await vi.advanceTimersByTimeAsync(0);

      expect(mockCallToolFn).toHaveBeenCalledTimes(2);
      const secondCall = mockCallToolFn.mock.calls[1][0];
      expect(secondCall.name).toBe('codex-reply');
      expect(secondCall.arguments.sessionId).toBe('sess-123');
      expect(secondCall.arguments.conversationId).toBe('conv-456');
      expect(secondCall.arguments.prompt).toBe('Follow up');
    });

    it('uses codex tool with initialPrompt on construction', async () => {
      const sessionWithPrompt = new CodexMCPSession({
        cwd: '/tmp',
        mode: 'remote',
        initialPrompt: 'Hello from initialPrompt',
      });
      await vi.advanceTimersByTimeAsync(0);

      // The initial prompt triggers startSession in initialize()
      expect(mockCallToolFn).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'codex',
          arguments: expect.objectContaining({
            prompt: 'Hello from initialPrompt',
          }),
        }),
        undefined,
        expect.any(Object),
      );
    });

    it('sends stopped error when session is stopped', async () => {
      await session.stop();
      await expect(session.send('test')).rejects.toThrow(/stopped/);
    });
  });

  // --- Execution policy mapping ---

  describe('execution policy mapping', () => {
    it('default mode maps to untrusted + workspace-write', async () => {
      await session.send('test');
      await vi.advanceTimersByTimeAsync(0);

      const args = mockCallToolFn.mock.calls[0][0].arguments;
      expect(args['approval-policy']).toBe('untrusted');
      expect(args.sandbox).toBe('workspace-write');
    });

    it('bypassPermissions maps to never + danger-full-access', async () => {
      const s = new CodexMCPSession({
        cwd: '/tmp',
        mode: 'remote',
        permissionMode: 'bypassPermissions',
      });
      s.onMessage(() => {});
      await s.send('test');
      await vi.advanceTimersByTimeAsync(0);

      const args = mockCallToolFn.mock.calls[0][0].arguments;
      expect(args['approval-policy']).toBe('never');
      expect(args.sandbox).toBe('danger-full-access');
    });

    it('acceptEdits maps to on-request + workspace-write', async () => {
      const s = new CodexMCPSession({
        cwd: '/tmp',
        mode: 'remote',
        permissionMode: 'acceptEdits',
      });
      await s.send('test');
      await vi.advanceTimersByTimeAsync(0);

      const args = mockCallToolFn.mock.calls[0][0].arguments;
      expect(args['approval-policy']).toBe('on-request');
      expect(args.sandbox).toBe('workspace-write');
    });

    it('plan maps to untrusted + read-only', async () => {
      const s = new CodexMCPSession({
        cwd: '/tmp',
        mode: 'remote',
        permissionMode: 'plan',
      });
      await s.send('test');
      await vi.advanceTimersByTimeAsync(0);

      const args = mockCallToolFn.mock.calls[0][0].arguments;
      expect(args['approval-policy']).toBe('untrusted');
      expect(args.sandbox).toBe('read-only');
    });
  });

  // --- Config building ---

  describe('config building', () => {
    it('includes model when provided', async () => {
      const s = new CodexMCPSession({
        cwd: '/tmp',
        mode: 'remote',
        model: 'o3-mini',
      });
      await s.send('test');
      await vi.advanceTimersByTimeAsync(0);

      const args = mockCallToolFn.mock.calls[0][0].arguments;
      expect(args.model).toBe('o3-mini');
    });

    it('includes mcp_servers when provided', async () => {
      const mcpServers = { happy: { command: 'node', args: ['server.js'] } };
      const s = new CodexMCPSession({
        cwd: '/tmp',
        mode: 'remote',
        mcpServers,
      });
      await s.send('test');
      await vi.advanceTimersByTimeAsync(0);

      const args = mockCallToolFn.mock.calls[0][0].arguments;
      expect(args.config).toEqual({ mcp_servers: mcpServers });
    });

    it('uses 14-day timeout for tool calls', async () => {
      await session.send('test');
      await vi.advanceTimersByTimeAsync(0);

      const options = mockCallToolFn.mock.calls[0][2];
      expect(options.timeout).toBe(14 * 24 * 60 * 60 * 1000);
    });
  });

  // --- Event mapping ---

  describe('event mapping', () => {
    function emitCodexEvent(msg: Record<string, unknown>): void {
      mockNotificationHandler?.({
        method: 'codex/event',
        params: { msg },
      });
    }

    it('agent_message -> text message', () => {
      emitCodexEvent({ type: 'agent_message', message: 'Hello world' });

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('text');
      expect(messages[0].content).toBe('Hello world');
    });

    it('agent_reasoning -> thinking message', () => {
      emitCodexEvent({ type: 'agent_reasoning', text: 'Let me think...' });

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('thinking');
      expect(messages[0].content).toBe('Let me think...');
    });

    it('agent_reasoning_delta is skipped', () => {
      emitCodexEvent({ type: 'agent_reasoning_delta', delta: 'token' });
      expect(messages).toHaveLength(0);
    });

    it('agent_reasoning_section_break is skipped', () => {
      emitCodexEvent({ type: 'agent_reasoning_section_break' });
      expect(messages).toHaveLength(0);
    });

    it('token_count is skipped', () => {
      emitCodexEvent({ type: 'token_count', input: 100, output: 50 });
      expect(messages).toHaveLength(0);
    });

    it('exec_command_begin -> tool_use message', () => {
      emitCodexEvent({
        type: 'exec_command_begin',
        command: 'ls -la /tmp',
        call_id: 'call-1',
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('tool_use');
      expect(messages[0].content).toBe('ls -la /tmp');
      expect(messages[0].metadata?.tool).toBe('CodexBash');
      expect(messages[0].metadata?.sdkMessageId).toBe('call-1');
    });

    it('exec_command_end -> tool_result message with output', () => {
      emitCodexEvent({
        type: 'exec_command_end',
        output: 'file1.txt\nfile2.txt',
        call_id: 'call-1',
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('tool_result');
      expect(messages[0].content).toBe('file1.txt\nfile2.txt');
    });

    it('exec_command_end -> tool_result message with error', () => {
      emitCodexEvent({
        type: 'exec_command_end',
        error: 'Permission denied',
        call_id: 'call-2',
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('tool_result');
      expect(messages[0].content).toBe('Permission denied');
    });

    it('exec_approval_request -> permission_request event', () => {
      emitCodexEvent({
        type: 'exec_approval_request',
        command: ['rm', '-rf', '/tmp/test'],
        cwd: '/home/user',
        call_id: 'call-perm',
      });

      const permEvent = events.find((e) => e.type === 'permission_request');
      expect(permEvent).toBeDefined();
      expect(permEvent!.permissionDetail?.requestId).toBe('call-perm');
      expect(permEvent!.permissionDetail?.toolName).toBe('CodexBash');
      expect(permEvent!.permissionDetail?.command).toEqual(['rm', '-rf', '/tmp/test']);
      expect(permEvent!.permissionDetail?.cwd).toBe('/home/user');
    });

    it('patch_apply_begin -> tool_use message with file names', () => {
      emitCodexEvent({
        type: 'patch_apply_begin',
        changes: { 'src/main.ts': {}, 'src/utils.ts': {} },
        call_id: 'patch-1',
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('tool_use');
      expect(messages[0].content).toContain('src/main.ts');
      expect(messages[0].content).toContain('src/utils.ts');
      expect(messages[0].metadata?.tool).toBe('CodexPatch');
    });

    it('patch_apply_end success -> tool_result with stdout', () => {
      emitCodexEvent({
        type: 'patch_apply_end',
        success: true,
        stdout: 'Applied successfully',
        call_id: 'patch-1',
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('tool_result');
      expect(messages[0].content).toBe('Applied successfully');
    });

    it('patch_apply_end failure -> tool_result with stderr', () => {
      emitCodexEvent({
        type: 'patch_apply_end',
        success: false,
        stderr: 'Conflict in file',
        call_id: 'patch-2',
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Conflict in file');
    });

    it('turn_diff -> text message with unified diff', () => {
      emitCodexEvent({
        type: 'turn_diff',
        unified_diff: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new',
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('text');
      expect(messages[0].content).toContain('--- a/file.ts');
    });

    it('turn_diff with empty diff is skipped', () => {
      emitCodexEvent({ type: 'turn_diff', unified_diff: '' });
      expect(messages).toHaveLength(0);
    });

    it('task_started -> ready event', () => {
      emitCodexEvent({ type: 'task_started' });

      const readyEvent = events.find((e) => e.type === 'ready' && e.summary.includes('task started'));
      expect(readyEvent).toBeDefined();
    });

    it('task_complete -> task_complete event', () => {
      emitCodexEvent({ type: 'task_complete' });

      const completeEvent = events.find((e) => e.type === 'task_complete');
      expect(completeEvent).toBeDefined();
    });

    it('turn_aborted -> error event', () => {
      emitCodexEvent({ type: 'turn_aborted', reason: 'User cancelled' });

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.summary).toContain('User cancelled');
    });

    it('unknown event type is silently ignored', () => {
      emitCodexEvent({ type: 'some_unknown_event' });
      expect(messages).toHaveLength(0);
      // Only the ready event from initialize should be present
    });
  });

  // --- Session ID extraction ---

  describe('session ID extraction', () => {
    function emitCodexEvent(msg: Record<string, unknown>): void {
      mockNotificationHandler?.({
        method: 'codex/event',
        params: { msg },
      });
    }

    it('extracts from tool response root', async () => {
      mockCallToolFn.mockResolvedValueOnce({
        content: [],
        sessionId: 'from-root',
        conversationId: 'conv-root',
      });

      await session.send('test');
      await vi.advanceTimersByTimeAsync(0);

      expect(session.id).toBe('from-root');
    });

    it('extracts from tool response meta', async () => {
      mockCallToolFn.mockResolvedValueOnce({
        content: [],
        meta: { sessionId: 'from-meta', conversationId: 'conv-meta' },
      });

      await session.send('test');
      await vi.advanceTimersByTimeAsync(0);

      expect(session.id).toBe('from-meta');
    });

    it('extracts from tool response content items', async () => {
      mockCallToolFn.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'ok', sessionId: 'from-content' }],
      });

      await session.send('test');
      await vi.advanceTimersByTimeAsync(0);

      expect(session.id).toBe('from-content');
    });

    it('extracts from events with snake_case', () => {
      emitCodexEvent({
        type: 'agent_message',
        message: 'hello',
        session_id: 'snake-sess',
        conversation_id: 'snake-conv',
      });

      expect(session.id).toBe('snake-sess');
    });

    it('extracts from events with camelCase', () => {
      emitCodexEvent({
        type: 'agent_message',
        message: 'hello',
        sessionId: 'camel-sess',
        conversationId: 'camel-conv',
      });

      expect(session.id).toBe('camel-sess');
    });

    it('extracts from nested event.data', () => {
      emitCodexEvent({
        type: 'agent_message',
        message: 'hello',
        data: { session_id: 'nested-sess' },
      });

      expect(session.id).toBe('nested-sess');
    });

    it('prefers threadId over sessionId in tool response (Codex >= 0.98)', async () => {
      mockCallToolFn.mockResolvedValueOnce({
        content: [],
        threadId: 'thread-abc',
        sessionId: 'sess-old',
      });

      await session.send('test');
      await vi.advanceTimersByTimeAsync(0);

      expect(session.id).toBe('thread-abc');
    });

    it('prefers thread_id over session_id in events', () => {
      emitCodexEvent({
        type: 'agent_message',
        message: 'hello',
        thread_id: 'thread-from-event',
        session_id: 'sess-from-event',
      });

      expect(session.id).toBe('thread-from-event');
    });

    it('extracts threadId from response meta', async () => {
      mockCallToolFn.mockResolvedValueOnce({
        content: [],
        meta: { threadId: 'thread-meta' },
      });

      await session.send('test');
      await vi.advanceTimersByTimeAsync(0);

      expect(session.id).toBe('thread-meta');
    });
  });

  // --- Permission flow ---

  describe('permission flow', () => {
    it('Elicitation handler emits permission_request event', async () => {
      const promise = mockRequestHandler?.({
        params: {
          codex_call_id: 'perm-1',
          codex_command: ['rm', '-rf', '/'],
          codex_cwd: '/home',
        },
      });

      const permEvent = events.find((e) => e.type === 'permission_request');
      expect(permEvent).toBeDefined();
      expect(permEvent!.permissionDetail?.requestId).toBe('perm-1');
      expect(permEvent!.permissionDetail?.command).toEqual(['rm', '-rf', '/']);
      expect(permEvent!.permissionDetail?.cwd).toBe('/home');

      // Approve
      await session.respondToPermission('perm-1', true);
      const result = await promise;
      expect(result).toEqual({ action: 'approved' });
    });

    it('respondToPermission with deny returns denied decision', async () => {
      const promise = mockRequestHandler?.({
        params: {
          codex_call_id: 'perm-2',
          codex_command: ['rm', 'file'],
          codex_cwd: '/tmp',
        },
      });

      await session.respondToPermission('perm-2', false);
      const result = await promise;
      expect(result).toEqual({ action: 'denied' });
    });

    it('throws when responding to unknown permission ID', async () => {
      await expect(
        session.respondToPermission('nonexistent', true),
      ).rejects.toThrow(/No pending permission request/);
    });

    it('auto-denies after 5 minute timeout', async () => {
      const promise = mockRequestHandler?.({
        params: {
          codex_call_id: 'perm-timeout',
          codex_command: ['echo', 'hi'],
          codex_cwd: '/tmp',
        },
      });

      // Advance past 5 min timeout
      await vi.advanceTimersByTimeAsync(300_001);

      const result = await promise;
      expect(result).toEqual({ action: 'denied' });
    });

    it('uses codex_event_id as fallback for call_id', async () => {
      const promise = mockRequestHandler?.({
        params: {
          codex_event_id: 'evt-fallback',
          codex_command: ['ls'],
          codex_cwd: '/tmp',
        },
      });

      const permEvent = events.find((e) => e.type === 'permission_request');
      expect(permEvent!.permissionDetail?.requestId).toBe('evt-fallback');

      await session.respondToPermission('evt-fallback', true);
      await promise;
    });
  });

  // --- Read ---

  describe('read', () => {
    function emitCodexEvent(msg: Record<string, unknown>): void {
      mockNotificationHandler?.({
        method: 'codex/event',
        params: { msg },
      });
    }

    it('returns buffered messages with cursor pagination', async () => {
      for (let i = 0; i < 3; i++) {
        emitCodexEvent({ type: 'agent_message', message: `message ${i}` });
      }

      const result = await session.read({ limit: 2 });
      expect(result.messages).toHaveLength(2);
      expect(result.nextCursor).toBe('2');

      const result2 = await session.read({ cursor: '2', limit: 2 });
      expect(result2.messages).toHaveLength(1);
    });

    it('returns empty for no messages', async () => {
      const result = await session.read();
      expect(result.messages).toHaveLength(0);
      expect(result.nextCursor).toBe('0');
    });
  });

  // --- Stop / cleanup ---

  describe('stop and cleanup', () => {
    it('calls client.close on stop', async () => {
      await session.stop();
      expect(mockClientCloseFn).toHaveBeenCalled();
    });

    it('denies all pending permissions on stop', async () => {
      const promise = mockRequestHandler?.({
        params: {
          codex_call_id: 'perm-stop',
          codex_command: ['echo'],
          codex_cwd: '/tmp',
        },
      });

      await session.stop();
      const result = await promise;
      expect(result).toEqual({ action: 'denied' });
    });

    it('stop is idempotent', async () => {
      await session.stop();
      await session.stop(); // should not throw
      expect(mockClientCloseFn).toHaveBeenCalledTimes(1);
    });

    it('switchMode calls stop', async () => {
      await session.switchMode('local');
      expect(mockClientCloseFn).toHaveBeenCalled();
    });
  });

  // --- callId handling with camelCase fallback ---

  describe('callId extraction from events', () => {
    function emitCodexEvent(msg: Record<string, unknown>): void {
      mockNotificationHandler?.({
        method: 'codex/event',
        params: { msg },
      });
    }

    it('uses call_id (snake_case)', () => {
      emitCodexEvent({
        type: 'exec_command_begin',
        command: 'echo hi',
        call_id: 'snake-id',
      });

      expect(messages[0].metadata?.sdkMessageId).toBe('snake-id');
    });

    it('falls back to callId (camelCase)', () => {
      emitCodexEvent({
        type: 'exec_command_begin',
        command: 'echo hi',
        callId: 'camel-id',
      });

      expect(messages[0].metadata?.sdkMessageId).toBe('camel-id');
    });
  });
});
