/**
 * CodexMCPProvider — Codex CLI provider via MCP (Model Context Protocol) bridge.
 *
 * Codex supports MCP as its primary machine-to-machine interface.
 * This provider communicates with Codex through JSON-RPC over stdio pipes.
 *
 * Reference: Happy Coder's codexMcpClient.ts
 */

import { spawn as spawnChild, type ChildProcess } from 'node:child_process';

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
import { McpStdioBridge, type JsonRpcNotification } from './mcp-bridge.js';

// ---------------------------------------------------------------------------
// CodexMCPProvider
// ---------------------------------------------------------------------------

export class CodexMCPProvider implements SessionProvider {
  readonly name = 'codex';
  readonly supportedModes: readonly SessionMode[] = ['local', 'remote'];

  async spawn(options: SpawnOptions): Promise<ProviderSession> {
    if (options.mode === 'local') {
      return new CodexLocalSession(options);
    }
    return new CodexMCPSession(options);
  }

  async resume(
    sessionId: string,
    options: SpawnOptions,
  ): Promise<ProviderSession> {
    return this.spawn({ ...options, resumeSessionId: sessionId });
  }
}

// ---------------------------------------------------------------------------
// CodexMCPSession — MCP bridge remote mode
// ---------------------------------------------------------------------------

export class CodexMCPSession implements ProviderSession {
  readonly provider = 'codex';
  readonly cwd: string;
  mode: SessionMode = 'remote';

  private bridge: McpStdioBridge;
  private sessionId: string;

  private messageBuffer: SessionMessage[] = [];
  private eventHandlers: EventHandler[] = [];
  private messageHandlers: MessageHandler[] = [];

  constructor(options: SpawnOptions) {
    this.cwd = options.cwd;
    this.sessionId = options.resumeSessionId ?? `codex-${Date.now()}`;

    const args = ['--mcp'];
    if (options.args) {
      args.push(...options.args);
    }

    this.bridge = new McpStdioBridge('codex', args, {
      cwd: options.cwd,
    });

    this.setupNotificationHandler();
    this.setupExitHandler();
    this.initialize();
  }

  get id(): string {
    return this.sessionId;
  }

  get pid(): number {
    return this.bridge.pid;
  }

  async send(input: string): Promise<void> {
    if (!this.bridge.isAlive) {
      throw new Error('Codex MCP session is not running.');
    }

    try {
      const result = await this.bridge.request('tools/call', {
        name: 'send_message',
        arguments: { message: input },
      });

      // Process the response as a message
      if (result && typeof result === 'object') {
        const msg: SessionMessage = {
          type: 'text',
          content: this.extractContent(result),
          timestamp: Date.now(),
        };
        this.bufferAndEmit(msg);
      }
    } catch (err) {
      const errorMsg: SessionMessage = {
        type: 'error',
        content: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
      this.bufferAndEmit(errorMsg);
    }
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
    await this.stop();
  }

  async respondToPermission(
    _requestId: string,
    approved: boolean,
  ): Promise<void> {
    if (!this.bridge.isAlive) {
      throw new Error('Codex MCP session is not running.');
    }

    try {
      await this.bridge.request('tools/call', {
        name: 'respond_permission',
        arguments: { approved },
      });
    } catch (err) {
      throw new Error(
        `Failed to respond to permission: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async stop(force?: boolean): Promise<void> {
    await this.bridge.close(force);
  }

  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  // -- Private ----------------------------------------------------------------

  private async initialize(): Promise<void> {
    try {
      await this.bridge.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'happyclaw',
          version: '0.0.1',
        },
      });

      this.bridge.notify('notifications/initialized');

      this.emitEvent({
        type: 'ready',
        severity: 'info',
        summary: 'Codex MCP session initialized',
        sessionId: this.sessionId,
        timestamp: Date.now(),
      });
    } catch (err) {
      this.emitEvent({
        type: 'error',
        severity: 'urgent',
        summary: `Codex MCP initialization failed: ${err instanceof Error ? err.message : String(err)}`,
        sessionId: this.sessionId,
        timestamp: Date.now(),
      });
    }
  }

  private setupNotificationHandler(): void {
    this.bridge.on('notification', (notification: JsonRpcNotification) => {
      this.handleNotification(notification);
    });
  }

  private handleNotification(notification: JsonRpcNotification): void {
    switch (notification.method) {
      case 'notifications/message': {
        const params = notification.params as Record<string, unknown> | undefined;
        if (params) {
          const msg: SessionMessage = {
            type: 'text',
            content: this.extractContent(params),
            timestamp: Date.now(),
          };
          this.bufferAndEmit(msg);
        }
        break;
      }
      case 'notifications/tools/call_progress': {
        const params = notification.params as Record<string, unknown> | undefined;
        if (params) {
          const msg: SessionMessage = {
            type: 'tool_use',
            content: String(params.progress ?? ''),
            timestamp: Date.now(),
            metadata: { tool: String(params.name ?? 'unknown') },
          };
          this.bufferAndEmit(msg);
        }
        break;
      }
      case 'notifications/permission_request': {
        const params = notification.params as Record<string, unknown> | undefined;
        this.emitEvent({
          type: 'permission_request',
          severity: 'urgent',
          summary: `Codex wants to use ${String(params?.tool_name ?? 'a tool')}`,
          sessionId: this.sessionId,
          timestamp: Date.now(),
          permissionDetail: {
            requestId: String(params?.request_id ?? `codex-${Date.now()}`),
            toolName: String(params?.tool_name ?? 'unknown'),
            input: params?.input,
          },
        });
        break;
      }
      case 'notifications/error': {
        const params = notification.params as Record<string, unknown> | undefined;
        this.emitEvent({
          type: 'error',
          severity: 'warning',
          summary: String(params?.message ?? 'Unknown error'),
          sessionId: this.sessionId,
          timestamp: Date.now(),
        });
        break;
      }
      default:
        // Unknown notification — ignore
        break;
    }
  }

  private setupExitHandler(): void {
    this.bridge.on('exit', (code: number | null, signal: string | null) => {
      this.emitEvent({
        type: 'task_complete',
        severity: code === 0 ? 'info' : 'warning',
        summary: `Codex process exited: code=${code}, signal=${signal}`,
        sessionId: this.sessionId,
        timestamp: Date.now(),
      });
    });

    this.bridge.on('error', (err: Error) => {
      this.emitEvent({
        type: 'error',
        severity: 'urgent',
        summary: `Codex process error: ${err.message}`,
        sessionId: this.sessionId,
        timestamp: Date.now(),
      });
    });
  }

  private extractContent(obj: unknown): string {
    if (typeof obj === 'string') return obj;
    if (obj && typeof obj === 'object') {
      const record = obj as Record<string, unknown>;
      // MCP tool results typically have a content array
      if (Array.isArray(record.content)) {
        return record.content
          .map((item: unknown) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object' && 'text' in (item as Record<string, unknown>)) {
              return String((item as Record<string, unknown>).text);
            }
            return JSON.stringify(item);
          })
          .join('\n');
      }
      if ('text' in record) return String(record.text);
      if ('message' in record) return String(record.message);
      return JSON.stringify(obj);
    }
    return String(obj);
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
// CodexLocalSession — stdio inherit for native terminal
// ---------------------------------------------------------------------------

export class CodexLocalSession implements ProviderSession {
  readonly provider = 'codex';
  readonly cwd: string;
  mode: SessionMode = 'local';

  private child: ChildProcess;
  private sessionId: string;
  private eventHandlers: EventHandler[] = [];

  constructor(options: SpawnOptions) {
    this.cwd = options.cwd;
    this.sessionId = options.resumeSessionId ?? `codex-local-${Date.now()}`;

    const args = [...(options.args ?? [])];

    this.child = spawnChild('codex', args, {
      stdio: 'inherit',
      cwd: options.cwd,
    });

    this.child.on('exit', (code, signal) => {
      this.emitEvent({
        type: 'task_complete',
        severity: code === 0 ? 'info' : 'warning',
        summary: `Codex exited: code=${code}, signal=${signal}`,
        sessionId: this.sessionId,
        timestamp: Date.now(),
      });
    });

    this.child.on('error', (err) => {
      this.emitEvent({
        type: 'error',
        severity: 'urgent',
        summary: `Codex error: ${err.message}`,
        sessionId: this.sessionId,
        timestamp: Date.now(),
      });
    });
  }

  get id(): string {
    return this.sessionId;
  }

  get pid(): number {
    return this.child.pid ?? 0;
  }

  async send(_input: string): Promise<void> {
    throw new Error(
      'Local mode: stdin is inherited by terminal.',
    );
  }

  async read(
    _options?: { cursor?: string; limit?: number },
  ): Promise<ReadResult> {
    throw new Error(
      'Local mode: stdout is inherited by terminal.',
    );
  }

  async switchMode(_target: SessionMode): Promise<void> {
    this.child.kill('SIGTERM');
  }

  async respondToPermission(
    _requestId: string,
    _approved: boolean,
  ): Promise<void> {
    throw new Error(
      'Local mode: permissions are handled interactively.',
    );
  }

  async stop(force?: boolean): Promise<void> {
    if (this.child.killed) return;

    if (force) {
      this.child.kill('SIGKILL');
      return;
    }

    this.child.kill('SIGTERM');

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
    // Local mode: no-op
  }

  private emitEvent(event: SessionEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }
}
