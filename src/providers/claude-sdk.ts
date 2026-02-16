/**
 * ClaudeSDKProvider — Claude Code SDK-based provider.
 *
 * Implements both remote (SDK query) and local (CLI spawn) modes:
 * - Remote: Structured stream-json via SDK query(), full message/event support
 * - Local: stdio inherit for native terminal experience, fd3 pipe for state tracking
 *
 * SDK package: @anthropic-ai/claude-agent-sdk@0.2.37
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKMessage,
  SDKUserMessage,
  CanUseTool,
  PermissionResult,
  Query,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  SessionProvider,
  ProviderSession,
  SpawnOptions,
  SessionMode,
  SessionMessage,
  SessionEvent,
  ReadResult,
  EventHandler,
  MessageHandler,
} from '../types/index.js';
import { AsyncQueue } from '../types/index.js';

// ---------------------------------------------------------------------------
// ClaudeSDKProvider
// ---------------------------------------------------------------------------

export class ClaudeSDKProvider implements SessionProvider {
  readonly name = 'claude';
  readonly supportedModes: readonly SessionMode[] = ['local', 'remote'];

  async spawn(options: SpawnOptions): Promise<ProviderSession> {
    if (options.mode === 'local') {
      return new ClaudeLocalSession(options);
    }
    return new ClaudeRemoteSession(options);
  }

  async resume(
    sessionId: string,
    options: SpawnOptions,
  ): Promise<ProviderSession> {
    return this.spawn({ ...options, resumeSessionId: sessionId });
  }
}

// ---------------------------------------------------------------------------
// ClaudeRemoteSession — SDK stream-json mode
// ---------------------------------------------------------------------------

export class ClaudeRemoteSession implements ProviderSession {
  readonly provider = 'claude';
  readonly cwd: string;
  mode: SessionMode = 'remote';

  private queryInstance: Query;
  private inputQueue: AsyncQueue<SDKUserMessage>;
  private sessionId = '';
  private processPid = 0;

  private messageBuffer: SessionMessage[] = [];
  private eventHandlers: EventHandler[] = [];
  private messageHandlers: MessageHandler[] = [];

  /** Pending permission requests: toolUseID -> { resolve, timer } */
  private pendingPermissions = new Map<
    string,
    {
      resolve: (result: PermissionResult) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** Permission request timeout (5 minutes, then auto-deny) */
  private permissionTimeout = 300_000;

  private listeningPromise: Promise<void>;

  /** Resolves when session_id is received from the SDK */
  private readyResolve!: () => void;
  private readyPromise: Promise<void>;

  constructor(options: SpawnOptions) {
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    this.cwd = options.cwd;
    this.inputQueue = new AsyncQueue<SDKUserMessage>();

    const canUseTool: CanUseTool = (toolName, input, opts) =>
      this.handlePermission(toolName, input, opts);

    this.queryInstance = sdkQuery({
      prompt: this.inputQueue,
      options: {
        cwd: options.cwd,
        resume: options.resumeSessionId,
        permissionMode: 'default',
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['project'],
        canUseTool,
      },
    });

    this.listeningPromise = this.startListening();
  }

  get id(): string {
    return this.sessionId;
  }

  async waitForReady(): Promise<void> {
    await this.readyPromise;
  }

  get pid(): number {
    return this.processPid;
  }

  async send(input: string): Promise<void> {
    if (this.inputQueue.isEnded) {
      throw new Error('Session input queue has ended. Cannot send.');
    }
    if (!this.sessionId) {
      throw new Error(
        'Session not yet initialized. Wait for the first message.',
      );
    }

    const userMessage: SDKUserMessage = {
      type: 'user',
      session_id: this.sessionId,
      parent_tool_use_id: null,
      message: { role: 'user', content: input },
    };
    this.inputQueue.push(userMessage);
  }

  async read(options?: {
    cursor?: string;
    limit?: number;
  }): Promise<ReadResult> {
    const cursor = options?.cursor ? parseInt(options.cursor, 10) : 0;
    const limit = options?.limit ?? 50;

    const start = Math.min(cursor, this.messageBuffer.length);
    const end = Math.min(start + limit, this.messageBuffer.length);
    const messages = this.messageBuffer.slice(start, end);

    return {
      messages,
      nextCursor: String(end),
    };
  }

  async switchMode(_target: SessionMode): Promise<void> {
    // Mode switching is handled by SessionManager:
    // 1. Stop this remote session
    // 2. Resume as local session with the same sessionId
    // We just need to clean up gracefully.
    await this.stop();
  }

  async respondToPermission(
    requestId: string,
    approved: boolean,
  ): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(
        `No pending permission request with ID: ${requestId}`,
      );
    }

    clearTimeout(pending.timer);
    this.pendingPermissions.delete(requestId);

    if (approved) {
      pending.resolve({ behavior: 'allow' });
    } else {
      pending.resolve({
        behavior: 'deny',
        message: 'Permission denied by user via HappyClaw.',
      });
    }
  }

  async stop(force?: boolean): Promise<void> {
    // Clean up pending permissions (deny all)
    for (const [id, pending] of this.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve({
        behavior: 'deny',
        message: 'Session stopped.',
      });
      this.pendingPermissions.delete(id);
    }

    this.inputQueue.end();

    if (force) {
      this.queryInstance.close();
    }

    // Wait for listening loop to complete
    try {
      await this.listeningPromise;
    } catch {
      // Listening may throw on close — that's expected
    }
  }

  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  // -- Private ----------------------------------------------------------------

  private async startListening(): Promise<void> {
    try {
      for await (const message of this.queryInstance) {
        this.handleSDKMessage(message);
      }
    } catch (err) {
      // Emit error event unless it's a clean close
      if (
        err instanceof Error &&
        err.name !== 'AbortError'
      ) {
        this.emitEvent({
          type: 'error',
          severity: 'warning',
          summary: `SDK stream error: ${err.message}`,
          sessionId: this.sessionId,
          timestamp: Date.now(),
        });
      }
    } finally {
      // Resolve ready promise even if no session_id was received
      // (prevents waitForReady from hanging forever on early failure)
      this.readyResolve();
    }
  }

  private handleSDKMessage(msg: SDKMessage): void {
    // Extract session_id from any message that has it
    if ('session_id' in msg && msg.session_id && !this.sessionId) {
      this.sessionId = msg.session_id;
      this.readyResolve();
    }

    switch (msg.type) {
      case 'system':
        this.handleSystemMessage(msg);
        break;
      case 'assistant':
        this.handleAssistantMessage(msg);
        break;
      case 'user':
        // user messages are echoes of tool results, generally skip
        break;
      case 'result':
        this.handleResultMessage(msg);
        break;
      case 'tool_progress':
        // Could be used for progress tracking, skip for now
        break;
      case 'tool_use_summary':
        this.handleToolUseSummary(msg);
        break;
      default:
        // auth_status, stream_event, etc. — skip for now
        break;
    }
  }

  private handleSystemMessage(msg: SDKMessage): void {
    if (msg.type !== 'system') return;

    if (msg.subtype === 'init') {
      // system:init carries session metadata
      this.emitEvent({
        type: 'ready',
        severity: 'info',
        summary: `Session initialized: model=${msg.model}`,
        sessionId: this.sessionId,
        timestamp: Date.now(),
      });
    }
  }

  private handleAssistantMessage(msg: SDKMessage): void {
    if (msg.type !== 'assistant') return;

    const content = msg.message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === 'text') {
        const sessionMsg: SessionMessage = {
          type: 'text',
          content: block.text,
          timestamp: Date.now(),
          metadata: { sdkMessageId: msg.uuid },
        };
        this.bufferAndEmit(sessionMsg);
      } else if (block.type === 'thinking' && 'thinking' in block) {
        const sessionMsg: SessionMessage = {
          type: 'thinking',
          content: String(block.thinking),
          timestamp: Date.now(),
          metadata: { sdkMessageId: msg.uuid },
        };
        this.bufferAndEmit(sessionMsg);
      } else if (block.type === 'tool_use') {
        const sessionMsg: SessionMessage = {
          type: 'tool_use',
          content: JSON.stringify(block.input),
          timestamp: Date.now(),
          metadata: {
            tool: block.name,
            sdkMessageId: msg.uuid,
          },
        };
        this.bufferAndEmit(sessionMsg);
      }
    }
  }

  private handleResultMessage(msg: SDKMessage): void {
    if (msg.type !== 'result') return;

    const isSuccess = msg.subtype === 'success';
    const resultText =
      isSuccess && 'result' in msg ? String(msg.result) : `Error: ${msg.subtype}`;

    const sessionMsg: SessionMessage = {
      type: 'result',
      content: resultText,
      timestamp: Date.now(),
      metadata: { sdkMessageId: msg.uuid },
    };
    this.bufferAndEmit(sessionMsg);

    this.emitEvent({
      type: 'task_complete',
      severity: 'info',
      summary: isSuccess
        ? 'Task completed successfully'
        : `Task ended: ${msg.subtype}`,
      sessionId: this.sessionId,
      timestamp: Date.now(),
    });
  }

  private handleToolUseSummary(msg: SDKMessage): void {
    if (msg.type !== 'tool_use_summary') return;

    const sessionMsg: SessionMessage = {
      type: 'tool_result',
      content: msg.summary,
      timestamp: Date.now(),
      metadata: { sdkMessageId: msg.uuid },
    };
    this.bufferAndEmit(sessionMsg);
  }

  private async handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: {
      signal: AbortSignal;
      toolUseID: string;
      decisionReason?: string;
      suggestions?: unknown[];
      blockedPath?: string;
      agentID?: string;
    },
  ): Promise<PermissionResult> {
    // Emit permission_request event with SDK's toolUseID as requestId
    this.emitEvent({
      type: 'permission_request',
      severity: 'urgent',
      summary: `Claude wants to use ${toolName}`,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      permissionDetail: {
        requestId: opts.toolUseID,
        toolName,
        input,
        decisionReason: opts.decisionReason,
      },
    });

    // Wait for user response with timeout
    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(opts.toolUseID);
        resolve({
          behavior: 'deny',
          message: 'Permission request timed out (5 min). Auto-denied.',
        });
      }, this.permissionTimeout);

      this.pendingPermissions.set(opts.toolUseID, { resolve, timer });

      // If the SDK signals abort, auto-deny
      opts.signal.addEventListener(
        'abort',
        () => {
          if (this.pendingPermissions.has(opts.toolUseID)) {
            clearTimeout(timer);
            this.pendingPermissions.delete(opts.toolUseID);
            resolve({
              behavior: 'deny',
              message: 'Permission request aborted.',
            });
          }
        },
        { once: true },
      );
    });
  }

  private bufferAndEmit(msg: SessionMessage): void {
    this.messageBuffer.push(msg);
    for (const handler of this.messageHandlers) {
      handler(msg);
    }
  }

  private emitEvent(event: SessionEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }
}

// ---------------------------------------------------------------------------
// ClaudeLocalSession — CLI spawn with stdio inherit
// ---------------------------------------------------------------------------

export class ClaudeLocalSession implements ProviderSession {
  readonly provider = 'claude';
  readonly cwd: string;
  mode: SessionMode = 'local';

  private child: ChildProcess;
  private sessionId: string;
  private eventHandlers: EventHandler[] = [];
  private fd3Buffer = '';

  constructor(options: SpawnOptions) {
    this.cwd = options.cwd;
    this.sessionId = options.resumeSessionId ?? `local-${Date.now()}`;

    const args = [...(options.args ?? [])];
    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    }

    // stdio inherit for native terminal experience
    // fd3 = pipe for state tracking (thinking, tool use, etc.)
    this.child = spawn('claude', args, {
      stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
      cwd: options.cwd,
    });

    this.setupFd3Listener();
    this.setupExitMonitor();
  }

  get id(): string {
    return this.sessionId;
  }

  get pid(): number {
    return this.child.pid ?? 0;
  }

  async send(_input: string): Promise<void> {
    throw new Error(
      'Local mode: stdin is inherited by terminal. Use terminal input directly.',
    );
  }

  async read(
    _options?: { cursor?: string; limit?: number },
  ): Promise<ReadResult> {
    throw new Error(
      'Local mode: stdout is inherited by terminal. Use terminal output directly.',
    );
  }

  async switchMode(_target: SessionMode): Promise<void> {
    // Kill local process so SessionManager can resume in remote mode
    this.child.kill('SIGTERM');
  }

  async respondToPermission(
    _requestId: string,
    _approved: boolean,
  ): Promise<void> {
    throw new Error(
      'Local mode: permissions are handled interactively in the terminal.',
    );
  }

  async stop(force?: boolean): Promise<void> {
    if (this.child.killed) return;

    if (force) {
      this.child.kill('SIGKILL');
      return;
    }

    this.child.kill('SIGTERM');

    // Wait up to 5s for graceful exit, then SIGKILL
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        if (!this.child.killed) {
          this.child.kill('SIGKILL');
        }
        resolve();
      }, 5000);

      this.child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
  }

  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler);
  }

  onMessage(_handler: MessageHandler): void {
    // Local mode: messages go directly to terminal, not to handlers.
    // This is a no-op.
  }

  // -- Private ----------------------------------------------------------------

  private setupFd3Listener(): void {
    const fd3Stream = this.child.stdio[3];
    if (!fd3Stream || !('on' in fd3Stream)) return;

    const readable = fd3Stream as NodeJS.ReadableStream;

    readable.on('data', (chunk: Buffer) => {
      this.fd3Buffer += chunk.toString();
      const lines = this.fd3Buffer.split('\n');
      this.fd3Buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          this.handleFd3Event(parsed);
        } catch {
          // Non-JSON output on fd3 — ignore
        }
      }
    });

    readable.on('error', () => {
      // fd3 pipe errors are non-fatal
    });
  }

  private handleFd3Event(event: Record<string, unknown>): void {
    // fd3 events are used for status tracking in local mode.
    // The exact format depends on Claude CLI version.
    // For now we emit a generic event.
    this.emitEvent({
      type: 'ready',
      severity: 'info',
      summary: `fd3 event: ${String(event.type ?? 'unknown')}`,
      sessionId: this.sessionId,
      timestamp: Date.now(),
    });
  }

  private setupExitMonitor(): void {
    this.child.on('exit', (code, signal) => {
      this.emitEvent({
        type: 'task_complete',
        severity: code === 0 ? 'info' : 'warning',
        summary: `Process exited: code=${code}, signal=${signal}`,
        sessionId: this.sessionId,
        timestamp: Date.now(),
      });
    });

    this.child.on('error', (err) => {
      this.emitEvent({
        type: 'error',
        severity: 'urgent',
        summary: `Process error: ${err.message}`,
        sessionId: this.sessionId,
        timestamp: Date.now(),
      });
    });
  }

  private emitEvent(event: SessionEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }
}
