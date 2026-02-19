/**
 * CodexMCPProvider — Codex CLI provider via official MCP SDK.
 *
 * Uses @modelcontextprotocol/sdk Client + StdioClientTransport to communicate
 * with `codex mcp-server` (or `codex mcp` for older versions).
 *
 * Two-tool pattern:
 *   - `codex`       — start a new session (first message)
 *   - `codex-reply`  — continue an existing session (subsequent messages)
 *
 * Events stream via `codex/event` notifications during blocking tool calls.
 * Permissions use the MCP Elicitation protocol (ElicitRequestSchema).
 *
 * Reference: Happy Coder's codexMcpClient.ts + runCodex.ts
 */

import { execSync, spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { existsSync, readlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 14 days — safe margin under Node's 32-bit setTimeout max (~24.8 days) */
const TOOL_CALL_TIMEOUT = 14 * 24 * 60 * 60 * 1000;

/** Permission auto-deny after 5 minutes (matches Claude provider) */
const PERMISSION_TIMEOUT = 300_000;

// ---------------------------------------------------------------------------
// PATH resolution — launchd doesn't source ~/.zshrc, so nvm paths are missing
// ---------------------------------------------------------------------------

let resolvedCodexPath: string | undefined;

// ---------------------------------------------------------------------------
// Platform triple for native binary resolution
// ---------------------------------------------------------------------------

const PLATFORM_TRIPLES: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
};

/**
 * Given the npm wrapper path (e.g. `~/.nvm/versions/node/v24/bin/codex`),
 * resolve through the package structure to the actual Rust binary.
 *
 * Layout (npm):
 *   .../bin/codex  →  symlink to ../lib/node_modules/@openai/codex/bin/codex.js
 *   .../lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/
 *     vendor/<triple>/codex/codex   ← actual Mach-O / ELF binary
 */
function resolveNativeBinary(wrapperPath: string): string | null {
  const triple = PLATFORM_TRIPLES[`${process.platform}-${process.arch}`];
  if (!triple) return null;

  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const platformPkg = `codex-${process.platform}-${process.arch}`;

  // Follow symlink to find the package root
  let realBin: string;
  try {
    // bin/codex → ../lib/node_modules/@openai/codex/bin/codex.js
    realBin = path.resolve(path.dirname(wrapperPath), readlinkSync(wrapperPath));
  } catch {
    realBin = wrapperPath;
  }
  const packageRoot = path.resolve(path.dirname(realBin), '..');

  // Search for native binary in known locations
  const candidates = [
    // npm hoists optionalDeps into nested node_modules
    path.join(packageRoot, 'node_modules', '@openai', platformPkg, 'vendor', triple, 'codex', binaryName),
    // Vendor directory fallback (some install methods)
    path.join(packageRoot, 'vendor', triple, 'codex', binaryName),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the full path to the `codex` binary.
 *
 * LaunchAgent processes have a minimal PATH and no nvm — the npm wrapper
 * script (`#!/usr/bin/env node`) can't find node. We bypass the wrapper
 * entirely and locate the native Rust binary directly.
 *
 * Strategy:
 *  1. Shell resolution → find npm wrapper → resolve through to native binary
 *  2. Direct NVM scan → find npm wrapper → resolve through to native binary
 *  3. Bare `codex` fallback (relies on ambient PATH)
 */
function resolveCodexPath(): string {
  if (resolvedCodexPath !== undefined) return resolvedCodexPath;

  const shell = process.env.SHELL || '/bin/zsh';

  // Strategy 1: shell-based resolution → native binary
  for (const flags of ['-lic', '-lc']) {
    try {
      const raw = execSync(`${shell} ${flags} 'command -v codex'`, {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'], // suppress stderr noise
      }).trim();
      // Interactive shell may print prompts — take only the last non-empty line
      const lastLine = raw.split('\n').filter(Boolean).pop() ?? '';
      if (lastLine && lastLine.startsWith('/') && !lastLine.includes('not found')) {
        // Try to resolve through to native binary (skip Node wrapper)
        const native = resolveNativeBinary(lastLine);
        if (native) {
          resolvedCodexPath = native;
          return resolvedCodexPath;
        }
        // Fallback: use wrapper path (requires node in PATH)
        resolvedCodexPath = lastLine;
        return resolvedCodexPath;
      }
    } catch {
      // continue to next strategy
    }
  }

  // Strategy 2: scan NVM directories directly
  const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME || '', '.nvm');
  try {
    const versionsDir = path.join(nvmDir, 'versions', 'node');
    if (existsSync(versionsDir)) {
      const versions = readdirSync(versionsDir).sort().reverse(); // newest first
      for (const ver of versions) {
        const wrapper = path.join(versionsDir, ver, 'bin', 'codex');
        if (existsSync(wrapper)) {
          // Try to resolve through to native binary
          const native = resolveNativeBinary(wrapper);
          if (native) {
            resolvedCodexPath = native;
            return resolvedCodexPath;
          }
          resolvedCodexPath = wrapper;
          return resolvedCodexPath;
        }
      }
    }
  } catch {
    // continue to fallback
  }

  resolvedCodexPath = 'codex'; // bare fallback
  return resolvedCodexPath;
}

// ---------------------------------------------------------------------------
// Version detection — `mcp` vs `mcp-server` subcommand
// ---------------------------------------------------------------------------

function getCodexMcpSubcommand(): string {
  try {
    const version = execSync(`${resolveCodexPath()} --version`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const match = version.match(/codex-cli\s+(\d+)\.(\d+)\.(\d+)/);
    if (!match) return 'mcp-server';
    const [, major, minor] = match.map(Number);
    if (major! > 0 || minor! >= 43) return 'mcp-server';
    return 'mcp';
  } catch {
    return 'mcp-server';
  }
}

// ---------------------------------------------------------------------------
// Environment setup — filter RUST_LOG noise
// ---------------------------------------------------------------------------

function buildTransportEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }

  // Ensure codex's bin directory is on PATH (launchd has minimal PATH)
  const codexBin = resolveCodexPath();
  if (codexBin.startsWith('/')) {
    const binDir = path.dirname(codexBin);
    if (!env.PATH?.includes(binDir)) {
      env.PATH = binDir + (env.PATH ? ':' + env.PATH : '');
    }
  }

  const filter = 'codex_core::rollout::list=off';
  if (!env.RUST_LOG) {
    env.RUST_LOG = filter;
  } else if (!env.RUST_LOG.includes('codex_core::rollout::list=')) {
    env.RUST_LOG = `${env.RUST_LOG},${filter}`;
  }

  return env;
}

// ---------------------------------------------------------------------------
// Execution policy mapping
// ---------------------------------------------------------------------------

interface ExecutionPolicy {
  approvalPolicy: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
}

function resolveExecutionPolicy(permissionMode?: string): ExecutionPolicy {
  switch (permissionMode) {
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    case 'acceptEdits':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'plan':
      return { approvalPolicy: 'untrusted', sandbox: 'read-only' };
    default:
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
  }
}

// ---------------------------------------------------------------------------
// Codex session config (argument shape for `codex` tool)
// ---------------------------------------------------------------------------

interface CodexSessionConfig {
  prompt: string;
  'approval-policy'?: string;
  sandbox?: string;
  cwd?: string;
  model?: string;
  config?: Record<string, unknown>;
}

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
// CodexMCPSession — Official MCP SDK, two-tool pattern, Elicitation permissions
// ---------------------------------------------------------------------------

type CodexSessionState = 'connecting' | 'working' | 'idle' | 'stopped';

export class CodexMCPSession implements ProviderSession {
  readonly provider = 'codex';
  readonly cwd: string;
  mode: SessionMode = 'remote';

  // MCP
  private client: Client;
  private transport: StdioClientTransport;

  // Session state machine
  private sessionState: CodexSessionState = 'connecting';
  private sessionStarted = false;
  private codexSessionId: string | null = null;
  private conversationId: string | null = null;
  private stopped = false;
  private connected = false;
  private taskCompleted = false;
  private reconnecting = false;
  private abortController = new AbortController();
  private readonly pendingId: string;

  // Permissions
  private pendingPermissions = new Map<
    string,
    { resolve: (decision: string) => void; timer: ReturnType<typeof setTimeout> }
  >();

  // Buffers & handlers
  private messageBuffer: SessionMessage[] = [];
  private eventHandlers: EventHandler[] = [];
  private messageHandlers: MessageHandler[] = [];

  /** Count of messages emitted during the current tool call (for dedup). */
  private turnMessageCount = 0;

  // Config (stored for startSession)
  private spawnOptions: SpawnOptions;
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;

  constructor(options: SpawnOptions) {
    this.cwd = options.cwd;
    this.spawnOptions = options;
    this.pendingId = `codex-pending-${Date.now()}`;

    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });

    // Create MCP client with elicitation capability
    this.client = new Client(
      { name: 'happyclaw-codex', version: '0.0.1' },
      { capabilities: { elicitation: {} } },
    );

    // Determine subcommand and build transport
    const subcommand = getCodexMcpSubcommand();
    const args = [subcommand, ...(options.args ?? [])];

    this.transport = new StdioClientTransport({
      command: resolveCodexPath(),
      args,
      env: buildTransportEnv(),
      cwd: options.cwd,
      stderr: 'pipe',
    });

    // Register handlers before connecting
    this.registerEventHandler();
    this.registerPermissionHandler();
    this.registerTransportHandlers();

    // Initialize: connect then optionally start session with initial prompt
    this.readyPromise = this.initialize(options);
  }

  // --- ProviderSession interface -------------------------------------------

  get id(): string {
    // Always return the stable pendingId as the canonical external identifier.
    // The real codexSessionId (set by extractIdentifiers) is only used
    // internally for codex-reply MCP tool calls.
    return this.pendingId;
  }

  /** The real session ID returned by the Codex MCP server (null until first tool response). */
  get realSessionId(): string | null {
    return this.codexSessionId;
  }

  get pid(): number {
    return this.transport.pid ?? 0;
  }

  async waitForReady(): Promise<void> {
    const TIMEOUT_MS = 30_000;
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(
          `Codex MCP did not initialize within ${TIMEOUT_MS / 1000}s. ` +
          'Check that codex is installed and accessible.',
        ));
      }, TIMEOUT_MS);
    });

    await Promise.race([this.readyPromise, timeout]);
  }

  async send(input: string): Promise<void> {
    if (this.stopped) {
      throw new Error('Codex MCP session is stopped.');
    }

    switch (this.sessionState) {
      case 'connecting':
        await this.waitForReady();
        if (this.stopped) throw new Error('Session stopped during connect.');
        // fall through to idle — waitForReady resolves after initialize sets idle
      // eslint-disable-next-line no-fallthrough
      case 'idle':
        this.sessionState = 'working';
        this.turnMessageCount = 0;
        this.taskCompleted = false;
        this.fireToolCall(() => this.sessionStarted
          ? this.continueSession(input)
          : this.startSession(input),
        );
        break;
      case 'working':
        throw new Error('Codex is still processing. Wait for task_complete before sending.');
      case 'stopped':
        throw new Error('Codex MCP session is stopped.');
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
    pending.resolve(approved ? 'approved' : 'denied');
  }

  async stop(force?: boolean): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.sessionState = 'stopped';

    // Abort any ongoing tool calls
    this.abortController.abort();

    // Deny all pending permissions
    for (const [id, pending] of this.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve('denied');
      this.pendingPermissions.delete(id);
    }

    // Close MCP client (closes transport + kills child process)
    try {
      await this.client.close();
    } catch {
      // Client may already be closed
    }

    // Force-kill child process if still alive
    if (force) {
      const childPid = this.transport.pid;
      if (childPid) {
        try {
          process.kill(childPid, 0); // check alive
          process.kill(childPid, 'SIGKILL');
        } catch {
          // not running
        }
      }
    }
  }

  /** Reset session state without killing the MCP process. Only allowed when idle or stopped. */
  clearSession(): void {
    if (this.sessionState !== 'idle' && this.sessionState !== 'stopped') {
      throw new Error('Cannot clear session while connecting or working.');
    }

    for (const [id, pending] of this.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve('denied');
      this.pendingPermissions.delete(id);
    }

    this.codexSessionId = null;
    this.conversationId = null;
    this.sessionStarted = false;
    this.taskCompleted = false;
    this.sessionState = 'idle';
    this.turnMessageCount = 0;
  }

  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  // --- Private: initialization ---------------------------------------------

  private async initialize(options: SpawnOptions): Promise<void> {
    try {
      await this.client.connect(this.transport);
      this.connected = true;
    } catch (err) {
      // Issue K: init failure → set stopped to prevent zombie connecting state
      this.sessionState = 'stopped';
      this.stopped = true;

      const msg = err instanceof Error ? err.message : String(err);
      this.emitEvent({
        type: 'error',
        severity: 'urgent',
        summary: `Codex MCP init failed: ${msg}`,
        sessionId: this.id,
        timestamp: Date.now(),
      });
      // Propagate so waitForReady() / spawn() can surface the error
      throw new Error(
        `Failed to connect to Codex MCP server. ` +
        `Is codex installed? Resolved path: ${resolveCodexPath()}. ` +
        `Error: ${msg}`,
      );
    }

    this.emitEvent({
      type: 'ready',
      severity: 'info',
      summary: 'Codex MCP session connected',
      sessionId: this.id,
      timestamp: Date.now(),
    });

    // If initial prompt provided, start the session immediately
    // Issue L: must set working state via fireToolCall path
    if (options.initialPrompt) {
      this.sessionState = 'working';
      this.turnMessageCount = 0;
      this.fireToolCall(() => this.startSession(options.initialPrompt!));
    } else {
      // No initial prompt — session is idle, ready for send()
      this.sessionState = 'idle';
    }

    this.readyResolve();
  }

  // --- Private: two-tool pattern -------------------------------------------

  private async startSession(prompt: string): Promise<void> {
    const policy = resolveExecutionPolicy(this.spawnOptions.permissionMode);

    const config: CodexSessionConfig = {
      prompt,
      'approval-policy': policy.approvalPolicy,
      sandbox: policy.sandbox,
      cwd: this.spawnOptions.cwd,
    };

    if (this.spawnOptions.model) {
      config.model = this.spawnOptions.model;
    }

    if (this.spawnOptions.mcpServers) {
      config.config = { mcp_servers: this.spawnOptions.mcpServers };
    }

    this.turnMessageCount = 0;

    const response = await this.client.callTool(
      { name: 'codex', arguments: config as unknown as Record<string, unknown> },
      undefined,
      {
        signal: this.abortController.signal,
        timeout: TOOL_CALL_TIMEOUT,
      },
    );

    this.sessionStarted = true;
    this.extractIdentifiers(response);
    this.processToolResponse(response);
  }

  private async continueSession(prompt: string): Promise<void> {
    // Reconnect transparently if MCP server disconnected (idle timeout)
    if (!this.connected) {
      await this.reconnect();
    }

    if (!this.codexSessionId) {
      throw new Error('No active Codex session. Call startSession first.');
    }

    const sessionId = this.codexSessionId;
    const conversationId = this.conversationId ?? sessionId;

    this.turnMessageCount = 0;

    const response = await this.client.callTool(
      {
        name: 'codex-reply',
        arguments: { sessionId, conversationId, prompt },
      },
      undefined,
      {
        signal: this.abortController.signal,
        timeout: TOOL_CALL_TIMEOUT,
      },
    );

    this.extractIdentifiers(response);
    this.processToolResponse(response);
  }

  /**
   * Fire a tool call in the background. Tool calls block for the entire
   * turn while events stream via notifications, so we don't await them
   * in send(). Errors are emitted as events.
   *
   * This is the SINGLE place that transitions state to 'idle' after a
   * tool call completes (Issue A fix — processToolResponse has early returns).
   */
  private fireToolCall(fn: () => Promise<void>): void {
    fn()
      .then(() => {
        if (this.sessionState === 'working') {
          this.sessionState = 'idle';
        }
      })
      .catch((err: unknown) => {
        // Transition to idle even on error (unless stopped)
        if (this.sessionState === 'working') {
          this.sessionState = 'idle';
        }
        if (this.stopped) return; // expected after abort
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('abort')) return; // expected on stop
        this.emitEvent({
          type: 'error',
          severity: 'warning',
          summary: `Codex tool call error: ${message}`,
          sessionId: this.id,
          timestamp: Date.now(),
        });
      });
  }

  private processToolResponse(response: unknown): void {
    const resp = response as Record<string, unknown> | undefined;
    if (!resp) return;

    if (resp.isError) {
      const content = this.extractContentFromResponse(resp);
      this.bufferAndEmit({
        type: 'error',
        content: content || 'Codex tool call returned an error',
        timestamp: Date.now(),
      });
      return;
    }

    // Skip the tool response text when events already delivered content
    // during this turn. The response typically duplicates the last
    // agent_message that was already emitted via the event stream.
    if (this.turnMessageCount > 0) return;

    const content = this.extractContentFromResponse(resp);
    if (content) {
      this.bufferAndEmit({
        type: 'text',
        content,
        timestamp: Date.now(),
      });
    }
  }

  private extractContentFromResponse(resp: Record<string, unknown>): string {
    const content = resp.content;
    if (!Array.isArray(content)) return '';

    return content
      .map((item: unknown) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in (item as Record<string, unknown>)) {
          return String((item as Record<string, unknown>).text);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  // --- Private: codex/event notification handler ---------------------------

  private registerEventHandler(): void {
    this.client.setNotificationHandler(
      z.object({
        method: z.literal('codex/event'),
        params: z.object({ msg: z.any() }).passthrough(),
      }).passthrough(),
      (data) => {
        const msg = (data.params as { msg: Record<string, unknown> }).msg;
        this.updateIdentifiersFromEvent(msg);
        this.handleCodexEvent(msg);
      },
    );
  }

  private handleCodexEvent(msg: Record<string, unknown>): void {
    const type = msg.type as string;
    const callId = String(msg.call_id ?? msg.callId ?? '');

    switch (type) {
      case 'agent_message':
        this.bufferAndEmit({
          type: 'text',
          content: String(msg.message ?? ''),
          timestamp: Date.now(),
        });
        break;

      case 'agent_reasoning':
      case 'agent_reasoning_delta':
      case 'agent_reasoning_section_break':
      case 'token_count':
        // Skip — thinking/reasoning and token counts are noise for TG push.
        // Buffering agent_reasoning as 'thinking' triggers empty flushes
        // because the formatter filters it anyway.
        break;

      case 'exec_command_begin':
        this.bufferAndEmit({
          type: 'tool_use',
          content: String(msg.command ?? ''),
          timestamp: Date.now(),
          metadata: { tool: 'CodexBash', sdkMessageId: callId || undefined },
        });
        break;

      case 'exec_command_end': {
        const output = String(msg.output ?? msg.error ?? 'Command completed');
        this.bufferAndEmit({
          type: 'tool_result',
          content: output,
          timestamp: Date.now(),
          metadata: { tool: 'CodexBash', sdkMessageId: callId || undefined },
        });
        break;
      }

      case 'exec_approval_request':
        // Redundant with Elicitation — but emit event for visibility
        this.emitEvent({
          type: 'permission_request',
          severity: 'urgent',
          summary: `Codex wants to run: ${String(msg.command ?? 'unknown command')}`,
          sessionId: this.id,
          timestamp: Date.now(),
          permissionDetail: {
            requestId: callId || `codex-${Date.now()}`,
            toolName: 'CodexBash',
            input: { command: msg.command, cwd: msg.cwd },
            command: Array.isArray(msg.command) ? msg.command as string[] : undefined,
            cwd: typeof msg.cwd === 'string' ? msg.cwd : undefined,
          },
        });
        break;

      case 'patch_apply_begin': {
        const changes = msg.changes as Record<string, unknown> | undefined;
        const files = changes ? Object.keys(changes).join(', ') : 'files';
        this.bufferAndEmit({
          type: 'tool_use',
          content: `Modifying ${files}`,
          timestamp: Date.now(),
          metadata: { tool: 'CodexPatch', sdkMessageId: callId || undefined },
        });
        break;
      }

      case 'patch_apply_end': {
        const success = msg.success as boolean;
        const output = success
          ? String(msg.stdout ?? 'Patch applied')
          : String(msg.stderr ?? 'Patch failed');
        this.bufferAndEmit({
          type: 'tool_result',
          content: output,
          timestamp: Date.now(),
          metadata: { tool: 'CodexPatch', sdkMessageId: callId || undefined },
        });
        break;
      }

      case 'turn_diff':
        // Skip — turn_diff contains the accumulated unified diff for the
        // entire turn, which duplicates what exec_command_end / patch_apply_end
        // already delivered as tool_result. Emitting it as 'text' would bypass
        // the formatter's tool_result filters and flood TG with raw diffs.
        break;

      case 'task_started':
        this.emitEvent({
          type: 'ready',
          severity: 'info',
          summary: 'Codex task started',
          sessionId: this.id,
          timestamp: Date.now(),
        });
        break;

      case 'task_complete':
        this.taskCompleted = true;  // Must set before emitEvent (Issue J)
        this.emitEvent({
          type: 'task_complete',
          severity: 'info',
          summary: 'Codex task completed',
          sessionId: this.id,
          timestamp: Date.now(),
        });
        break;

      case 'turn_aborted':
        this.emitEvent({
          type: 'error',
          severity: 'warning',
          summary: `Codex turn aborted: ${String(msg.reason ?? msg.error ?? 'unknown')}`,
          sessionId: this.id,
          timestamp: Date.now(),
        });
        break;

      default:
        // Unknown event type — silently ignore
        break;
    }
  }

  // --- Private: Elicitation permission handler -----------------------------

  private registerPermissionHandler(): void {
    this.client.setRequestHandler(
      ElicitRequestSchema,
      async (request) => {
        const params = request.params as unknown as Record<string, unknown>;

        const callId = String(params.codex_call_id ?? params.codex_event_id ?? `perm-${Date.now()}`);
        const command = params.codex_command;
        const cwd = typeof params.codex_cwd === 'string' ? params.codex_cwd : undefined;

        // Emit permission request event for remote user
        this.emitEvent({
          type: 'permission_request',
          severity: 'urgent',
          summary: `Codex wants to run: ${Array.isArray(command) ? command.join(' ') : String(command ?? 'command')}`,
          sessionId: this.id,
          timestamp: Date.now(),
          permissionDetail: {
            requestId: callId,
            toolName: 'CodexBash',
            input: { command, cwd },
            command: Array.isArray(command) ? command as string[] : undefined,
            cwd,
          },
        });

        // Wait for respondToPermission() call or timeout
        const decision = await this.waitForPermissionDecision(callId);
        return { action: decision } as unknown as ReturnType<Parameters<typeof this.client.setRequestHandler>[1]>;
      },
    );
  }

  private waitForPermissionDecision(callId: string): Promise<string> {
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(callId);
        resolve('denied');
      }, PERMISSION_TIMEOUT);

      this.pendingPermissions.set(callId, { resolve, timer });
    });
  }

  // --- Private: transport lifecycle handlers --------------------------------

  /**
   * Monitor the child process stderr and exit for diagnostics.
   * StdioClientTransport pipes stderr but nothing reads it by default —
   * capture it so we know WHY the Codex process died.
   */
  private registerTransportHandlers(): void {
    // stderr capture — Codex writes debug/error info here
    this.transport.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text) return;

      // eslint-disable-next-line no-console
      console.error(`[Codex stderr] ${text}`);

      // Surface fatal errors as session events
      if (/error|fatal|panic|abort/i.test(text)) {
        this.emitEvent({
          type: 'error',
          severity: 'warning',
          summary: `Codex stderr: ${text.slice(0, 200)}`,
          sessionId: this.id,
          timestamp: Date.now(),
        });
      }
    });

    // Transport close — fires when child process exits
    // WARNING: summary text controls SessionManager cleanup — see handleProcessEvent()
    this.transport.onclose = () => {
      if (this.stopped) return; // expected after stop()
      this.connected = false;  // All paths set this (Issue H)

      if (this.sessionState === 'idle' || this.taskCompleted) {
        // Idle/completed disconnect — MCP server idle timeout or normal task-end exit.
        // Use type:'ready' (not 'error') so TG push adapter ignores it (Issue B).
        // Summary must NOT contain "Process exited" to avoid SessionManager cleanup.
        this.emitEvent({
          type: 'ready',
          severity: 'info',
          summary: 'Codex MCP server disconnected (idle). Will reconnect on next send.',
          sessionId: this.id,
          timestamp: Date.now(),
        });
      } else {
        // working/connecting without taskCompleted — truly unexpected death
        this.emitEvent({
          type: 'error',
          severity: 'urgent',
          summary: 'Process exited: Codex MCP server terminated unexpectedly',
          sessionId: this.id,
          timestamp: Date.now(),
        });
      }
    };

    // Transport error
    this.transport.onerror = (err: Error) => {
      if (this.stopped) return;
      this.emitEvent({
        type: 'error',
        severity: 'urgent',
        summary: `Process error: Codex MCP transport error: ${err.message}`,
        sessionId: this.id,
        timestamp: Date.now(),
      });
    };
  }

  // --- Private: transparent reconnect ----------------------------------------

  /**
   * Reconnect to a fresh Codex MCP server process after idle disconnect.
   * Fully tears down old transport (including stderr listeners) before
   * creating a new one with the same config.
   */
  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;  // Prevent concurrent reconnects (Issue G)
    this.reconnecting = true;

    try {
      // Tear down old transport handlers (Issue E — stderr listener)
      this.transport.onclose = undefined;
      this.transport.onerror = undefined;
      this.transport.stderr?.removeAllListeners();
      try { await this.transport.close(); } catch { /* old process may be dead */ }

      // Close old client to prevent handler leaks
      try { await this.client.close(); } catch { /* ignore */ }

      // Build new transport with original config (Issue D — resolveCodexPath)
      const subcommand = getCodexMcpSubcommand();
      this.transport = new StdioClientTransport({
        command: resolveCodexPath(),
        args: [subcommand, ...(this.spawnOptions.args ?? [])],
        env: buildTransportEnv(),
        cwd: this.cwd,
        stderr: 'pipe',
      });

      this.client = new Client(
        { name: 'happyclaw-codex', version: '0.0.1' },
        { capabilities: { elicitation: {} } },
      );

      this.registerEventHandler();
      this.registerPermissionHandler();
      this.registerTransportHandlers();
      await this.client.connect(this.transport);
      this.connected = true;
    } finally {
      this.reconnecting = false;
    }
  }

  // --- Private: session ID extraction (defensive) --------------------------

  private extractIdentifiers(response: unknown): void {
    const resp = response as Record<string, unknown> | undefined;
    if (!resp) return;

    // Source 1: response.meta
    const meta = (resp.meta ?? {}) as Record<string, unknown>;
    const metaId = meta.threadId ?? meta.sessionId;
    if (typeof metaId === 'string') this.codexSessionId = metaId;
    if (typeof meta.conversationId === 'string') this.conversationId = meta.conversationId;

    // Source 2: response root (threadId preferred over sessionId for Codex >= 0.98)
    const rootId = resp.threadId ?? resp.sessionId;
    if (typeof rootId === 'string') this.codexSessionId = rootId;
    if (typeof resp.conversationId === 'string') this.conversationId = resp.conversationId;

    // Source 3: response.content array items
    const content = resp.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          if (!this.codexSessionId) {
            const itemId = rec.threadId ?? rec.sessionId;
            if (typeof itemId === 'string') this.codexSessionId = itemId;
          }
          if (!this.conversationId && typeof rec.conversationId === 'string') {
            this.conversationId = rec.conversationId;
          }
        }
      }
    }
  }

  private updateIdentifiersFromEvent(event: Record<string, unknown>): void {
    const candidates: Record<string, unknown>[] = [event];
    if (event.data && typeof event.data === 'object') {
      candidates.push(event.data as Record<string, unknown>);
    }

    for (const candidate of candidates) {
      // threadId preferred (Codex >= 0.98), fallback to session_id/sessionId
      const sessionId = candidate.thread_id ?? candidate.threadId
        ?? candidate.session_id ?? candidate.sessionId;
      if (typeof sessionId === 'string') this.codexSessionId = sessionId;

      const conversationId = candidate.conversation_id ?? candidate.conversationId;
      if (typeof conversationId === 'string') this.conversationId = conversationId;
    }
  }

  // --- Private: buffer & emit helpers --------------------------------------

  private bufferAndEmit(msg: SessionMessage): void {
    this.turnMessageCount++;
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

    this.child = spawnChild(resolveCodexPath(), args, {
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
