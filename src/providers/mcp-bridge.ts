/**
 * MCP stdio bridge — JSON-RPC framing over stdin/stdout.
 *
 * Provides a transport layer for communicating with MCP-compatible CLI tools
 * (like Codex) via JSON-RPC 2.0 messages over stdio pipes.
 *
 * Reference: Happy Coder's happyMcpStdioBridge.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ---------------------------------------------------------------------------
// McpStdioBridge
// ---------------------------------------------------------------------------

export class McpStdioBridge extends EventEmitter {
  private child: ChildProcess;
  private nextId = 1;
  private pendingRequests = new Map<
    number | string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private stdoutBuffer = '';
  private stopped = false;

  /** Default timeout for RPC requests (30 seconds) */
  private requestTimeout = 30_000;

  constructor(
    command: string,
    args: string[],
    options: { cwd: string; env?: Record<string, string> },
  ) {
    super();

    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? (process.env as Record<string, string>),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.setupStdoutParser();
    this.setupErrorHandling();
  }

  get pid(): number {
    return this.child.pid ?? 0;
  }

  get isAlive(): boolean {
    return !this.stopped && !this.child.killed;
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.isAlive) {
      throw new Error('MCP bridge process is not running.');
    }

    const id = this.nextId++;
    const msg: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request timed out: ${method} (id=${id})`));
      }, this.requestTimeout);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.writeMessage(msg);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  notify(method: string, params?: unknown): void {
    if (!this.isAlive) return;

    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.writeMessage(msg);
  }

  /**
   * Close the bridge, killing the child process.
   */
  async close(force?: boolean): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP bridge closed.'));
      this.pendingRequests.delete(id);
    }

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

  // -- Private ----------------------------------------------------------------

  private writeMessage(msg: JsonRpcMessage): void {
    const json = JSON.stringify(msg);
    // MCP uses Content-Length framed messages
    const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
    this.child.stdin!.write(header + json);
  }

  private setupStdoutParser(): void {
    this.child.stdout!.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString();
      this.processBuffer();
    });
  }

  private processBuffer(): void {
    // Parse Content-Length framed JSON-RPC messages
    while (this.stdoutBuffer.length > 0) {
      // Look for Content-Length header
      const headerEnd = this.stdoutBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.stdoutBuffer.substring(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Skip malformed header — advance past it
        this.stdoutBuffer = this.stdoutBuffer.substring(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1]!, 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (this.stdoutBuffer.length < bodyEnd) {
        break; // Not enough data yet
      }

      const body = this.stdoutBuffer.substring(bodyStart, bodyEnd);
      this.stdoutBuffer = this.stdoutBuffer.substring(bodyEnd);

      try {
        const msg = JSON.parse(body) as JsonRpcMessage;
        this.handleMessage(msg);
      } catch {
        // Malformed JSON — skip
      }
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Check if it's a response to a pending request
    if ('id' in msg && msg.id !== null && !('method' in msg)) {
      const response = msg as JsonRpcResponse;
      const pending = this.pendingRequests.get(response.id!);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(response.id!);

        if (response.error) {
          pending.reject(
            new Error(`MCP error ${response.error.code}: ${response.error.message}`),
          );
        } else {
          pending.resolve(response.result);
        }
        return;
      }
    }

    // It's a notification from the server
    if ('method' in msg) {
      this.emit('notification', msg as JsonRpcNotification);
    }
  }

  private setupErrorHandling(): void {
    this.child.on('exit', (code, signal) => {
      this.stopped = true;
      this.emit('exit', code, signal);

      // Reject remaining pending requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error(`MCP bridge exited: code=${code}, signal=${signal}`),
        );
        this.pendingRequests.delete(id);
      }
    });

    this.child.on('error', (err) => {
      this.stopped = true;
      this.emit('error', err);
    });

    this.child.stderr!.on('data', (chunk: Buffer) => {
      this.emit('stderr', chunk.toString());
    });
  }
}
