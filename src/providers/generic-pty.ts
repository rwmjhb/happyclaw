/**
 * GenericPTYProvider — PTY-based provider for CLI tools without a dedicated SDK.
 *
 * Uses node-pty for terminal emulation and @xterm/headless for screen state.
 * Output is parsed through configurable ParserRuleSet (e.g., GeminiParserRules).
 *
 * Local mode: stdio inherit (native terminal experience)
 * Remote mode: node-pty capture + ANSI stripping + rule-based parsing
 */

import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import * as pty from 'node-pty';
import { Terminal } from '@xterm/headless';
import stripAnsi from 'strip-ansi';

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
import type { ParserRuleSet } from './parser-rules.js';

// ---------------------------------------------------------------------------
// GenericPTYProvider
// ---------------------------------------------------------------------------

export class GenericPTYProvider implements SessionProvider {
  readonly name: string;
  readonly supportedModes: readonly SessionMode[] = ['local', 'remote'];

  constructor(
    name: string,
    private cliPath: string,
    private parserRules: ParserRuleSet,
  ) {
    this.name = name;
  }

  async spawn(options: SpawnOptions): Promise<ProviderSession> {
    if (options.mode === 'local') {
      return new PTYLocalSession(this.name, this.cliPath, options);
    }
    return new PTYRemoteSession(
      this.name,
      this.cliPath,
      options,
      this.parserRules,
    );
  }

  async resume(
    sessionId: string,
    options: SpawnOptions,
  ): Promise<ProviderSession> {
    return this.spawn({ ...options, resumeSessionId: sessionId });
  }
}

// ---------------------------------------------------------------------------
// PTYRemoteSession — node-pty capture + parsing
// ---------------------------------------------------------------------------

export class PTYRemoteSession implements ProviderSession {
  readonly provider: string;
  readonly cwd: string;
  mode: SessionMode = 'remote';

  private ptyProcess: pty.IPty;
  private terminal: Terminal;
  private rules: ParserRuleSet;
  private sessionId: string;

  private messageBuffer: SessionMessage[] = [];
  private eventHandlers: EventHandler[] = [];
  private messageHandlers: MessageHandler[] = [];
  private stopped = false;

  constructor(
    providerName: string,
    cliPath: string,
    options: SpawnOptions,
    rules: ParserRuleSet,
  ) {
    this.provider = providerName;
    this.cwd = options.cwd;
    this.rules = rules;
    this.sessionId = options.resumeSessionId ?? `pty-${Date.now()}`;

    const args = [...(options.args ?? [])];

    // Wide terminal reduces line wrapping, making parsing more reliable
    this.ptyProcess = pty.spawn(cliPath, args, {
      cwd: options.cwd,
      cols: 200,
      rows: 50,
      env: process.env as Record<string, string>,
    });

    this.terminal = new Terminal({ cols: 200, rows: 50 });

    // Listen for PTY output
    this.ptyProcess.onData((data) => {
      if (this.stopped) return;
      this.terminal.write(data);
      this.parseAndEmit(data);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.stopped = true;
      this.emitEvent({
        type: 'task_complete',
        severity: exitCode === 0 ? 'info' : 'warning',
        summary: `Process exited: code=${exitCode}, signal=${signal}`,
        sessionId: this.sessionId,
        timestamp: Date.now(),
      });
    });

    // Emit ready event
    this.emitEvent({
      type: 'ready',
      severity: 'info',
      summary: `PTY session started: ${providerName}`,
      sessionId: this.sessionId,
      timestamp: Date.now(),
    });
  }

  get id(): string {
    return this.sessionId;
  }

  get pid(): number {
    return this.ptyProcess.pid;
  }

  async send(input: string): Promise<void> {
    if (this.stopped) {
      throw new Error('PTY session has stopped. Cannot send input.');
    }

    // Filter input through parser rules (block dangerous control chars)
    const filtered = this.rules.filterInput(input);
    if (filtered === null) {
      throw new Error('Input blocked by safety filter.');
    }

    this.ptyProcess.write(filtered + '\r');
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
    // PTY mode: no structured permission protocol.
    // Best effort: send "y" or "n" to the terminal.
    if (this.stopped) {
      throw new Error('PTY session has stopped.');
    }
    this.ptyProcess.write(approved ? 'y\r' : 'n\r');
  }

  async stop(force?: boolean): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    if (force) {
      this.ptyProcess.kill('SIGKILL');
      return;
    }

    this.ptyProcess.kill('SIGTERM');

    // Wait up to 5s for graceful exit, then SIGKILL
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          this.ptyProcess.kill('SIGKILL');
        } catch {
          // Already dead
        }
        resolve();
      }, 5000);

      // node-pty's onExit fires when the process exits
      this.ptyProcess.onExit(() => {
        clearTimeout(killTimer);
        resolve();
      });
    });

    this.terminal.dispose();
  }

  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  // -- Private ----------------------------------------------------------------

  private parseAndEmit(raw: string): void {
    const clean = stripAnsi(raw);

    // Try to parse into structured message
    const parsed = this.rules.parse(clean);
    if (parsed) {
      this.messageBuffer.push(parsed);
      for (const handler of this.messageHandlers) {
        handler(parsed);
      }
    }

    // Check for events (permission prompts, errors, etc.)
    const event = this.rules.detectEvent(clean, this.sessionId);
    if (event) {
      this.emitEvent(event);
    }
  }

  private emitEvent(event: SessionEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }
}

// ---------------------------------------------------------------------------
// PTYLocalSession — stdio inherit for native terminal
// ---------------------------------------------------------------------------

export class PTYLocalSession implements ProviderSession {
  readonly provider: string;
  readonly cwd: string;
  mode: SessionMode = 'local';

  private child: ChildProcess;
  private sessionId: string;
  private eventHandlers: EventHandler[] = [];

  constructor(
    providerName: string,
    cliPath: string,
    options: SpawnOptions,
  ) {
    this.provider = providerName;
    this.cwd = options.cwd;
    this.sessionId = options.resumeSessionId ?? `pty-local-${Date.now()}`;

    const args = [...(options.args ?? [])];

    this.child = spawnChild(cliPath, args, {
      stdio: 'inherit',
      cwd: options.cwd,
    });

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
