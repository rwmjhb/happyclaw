/**
 * HappyClaw — Core type definitions
 *
 * Defines all interfaces and types for the session bridge plugin:
 * Provider abstraction, session management, security, and message formats.
 *
 * SDK re-exports are from @anthropic-ai/claude-agent-sdk@0.2.37
 */

// ---------------------------------------------------------------------------
// Re-exported SDK types
// ---------------------------------------------------------------------------

export type {
  // Core API
  Query,
  Options as SDKOptions,
  CanUseTool,
  PermissionResult,
  PermissionMode,
  PermissionUpdate,
  SettingSource,

  // Message types
  SDKMessage,
  SDKUserMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  SDKPartialAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKStatusMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
  SDKAuthStatusMessage,
  SDKHookStartedMessage,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKTaskNotificationMessage,
  SDKFilesPersistedEvent,
  SDKUserMessageReplay,

  // Supporting types
  SDKPermissionDenial,
  ModelUsage,
  AccountInfo,
  McpServerStatus,
  SlashCommand,

  // V2 Session API (alpha)
  SDKSession,
  SDKSessionOptions,
} from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Session mode
// ---------------------------------------------------------------------------

/** Provider-supported interaction modes */
export type SessionMode = 'local' | 'remote';

// ---------------------------------------------------------------------------
// Unified message format
// ---------------------------------------------------------------------------

/** Message type taxonomy after normalizing SDK/PTY output */
export type SessionMessageType =
  | 'text'
  | 'code'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'error'
  | 'result';

/** Structured message produced by any provider */
export interface SessionMessage {
  type: SessionMessageType;
  content: string;
  timestamp: number;
  metadata?: {
    tool?: string;
    file?: string;
    language?: string;
    /** Original SDK message UUID for traceability */
    sdkMessageId?: string;
  };
}

// ---------------------------------------------------------------------------
// Session events
// ---------------------------------------------------------------------------

/** Event type taxonomy */
export type SessionEventType =
  | 'permission_request'
  | 'error'
  | 'waiting_for_input'
  | 'task_complete'
  | 'ready';

/** Event severity levels */
export type SessionEventSeverity = 'info' | 'warning' | 'urgent';

/** Permission request details attached to permission_request events */
export interface PermissionDetail {
  /** SDK's toolUseID — used to correlate session.respond calls */
  requestId: string;
  toolName: string;
  input: unknown;
  /** Human-readable reason from SDK (decisionReason) */
  decisionReason?: string;
}

/** Session event emitted by providers */
export interface SessionEvent {
  type: SessionEventType;
  severity: SessionEventSeverity;
  summary: string;
  sessionId: string;
  timestamp: number;
  permissionDetail?: PermissionDetail;
}

// ---------------------------------------------------------------------------
// Provider interfaces
// ---------------------------------------------------------------------------

/** Options for spawning or resuming a session */
export interface SpawnOptions {
  cwd: string;
  mode: SessionMode;
  args?: string[];
  /** Session ID to resume (passed to SDK resume / CLI --resume) */
  resumeSessionId?: string;
}

/** Unified provider interface — each CLI tool implements this */
export interface SessionProvider {
  readonly name: string;
  readonly supportedModes: readonly SessionMode[];

  /** Spawn a new session */
  spawn(options: SpawnOptions): Promise<ProviderSession>;

  /** Resume an existing session by ID */
  resume(sessionId: string, options: SpawnOptions): Promise<ProviderSession>;
}

// ---------------------------------------------------------------------------
// Provider session
// ---------------------------------------------------------------------------

/** Cursor-paginated read result */
export interface ReadResult {
  messages: SessionMessage[];
  /** Opaque cursor — pass to next read() call for pagination */
  nextCursor: string;
}

/** Read result extended with wait metadata */
export interface WaitReadResult extends ReadResult {
  /** true if the wait timed out without new messages */
  timedOut: boolean;
}

/** Event handler callback */
export type EventHandler = (event: SessionEvent) => void;

/** Message handler callback */
export type MessageHandler = (message: SessionMessage) => void;

/** A live session created by a provider */
export interface ProviderSession {
  readonly id: string;
  readonly provider: string;
  readonly cwd: string;
  readonly pid: number;
  mode: SessionMode;

  /** Send user input to the session */
  send(input: string): Promise<void>;

  /** Read messages with cursor-based pagination */
  read(options?: { cursor?: string; limit?: number }): Promise<ReadResult>;

  /** Switch interaction mode (local <-> remote) */
  switchMode(target: SessionMode): Promise<void>;

  /** Respond to a permission request (requestId = SDK toolUseID) */
  respondToPermission(requestId: string, approved: boolean): Promise<void>;

  /** Stop the session. force=true sends SIGKILL instead of SIGTERM */
  stop(force?: boolean): Promise<void>;

  /** Register event listener */
  onEvent(handler: EventHandler): void;

  /** Register real-time message listener (remote mode) */
  onMessage(handler: MessageHandler): void;

  /**
   * Wait until the session is ready (has a valid ID from the backend).
   * Resolves immediately for providers whose ID is known at construction.
   * Remote SDK sessions resolve once the first message with session_id arrives.
   */
  waitForReady?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Caller context & security
// ---------------------------------------------------------------------------

/** Injected by OpenClaw Gateway into every tool handler */
export interface CallerContext {
  userId: string;
  channelId: string;
}

/** Access control for sessions — owner binding + access checks */
export interface SessionACL {
  /** Bind a session to its owner (must be called before event forwarding) */
  setOwner(sessionId: string, ownerId: string): void;

  /** Get the owner of a session */
  getOwner(sessionId: string): string | undefined;

  /** Check if a user can access a session */
  canAccess(userId: string, sessionId: string): boolean;

  /** Throw if the user is not the session owner */
  assertOwner(userId: string, sessionId: string): void;

  /** Remove ownership record (on session cleanup) */
  removeSession(sessionId: string): void;
}

// ---------------------------------------------------------------------------
// Session manager types
// ---------------------------------------------------------------------------

/** Mode-switching state machine states */
export type SwitchState = 'running' | 'draining' | 'switching' | 'error';

/** Persisted session metadata for reconcileOnStartup */
export interface PersistedSession {
  id: string;
  provider: string;
  cwd: string;
  pid: number;
  ownerId: string;
  mode: SessionMode;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// AsyncQueue — async iterable queue for SDK streaming input
// ---------------------------------------------------------------------------

/**
 * A push-based async iterable queue.
 *
 * Used to feed SDKUserMessage objects into the SDK's query() prompt parameter.
 * Supports backpressure: consumers await next(), producers push().
 * Call end() to signal no more items will be pushed.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiting: Array<{
    resolve: (result: IteratorResult<T>) => void;
  }> = [];
  private ended = false;

  /** Push an item into the queue */
  push(item: T): void {
    if (this.ended) {
      throw new Error('Cannot push to ended queue');
    }

    if (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      waiter.resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  /** Signal that no more items will be pushed */
  end(): void {
    this.ended = true;
    // Resolve all waiting consumers with done
    for (const waiter of this.waiting) {
      waiter.resolve({ value: undefined as unknown as T, done: true });
    }
    this.waiting = [];
  }

  /** Whether the queue has been ended */
  get isEnded(): boolean {
    return this.ended;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<T> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      } else if (this.ended) {
        return;
      } else {
        const item = await new Promise<IteratorResult<T>>((resolve) => {
          this.waiting.push({ resolve });
        });
        if (item.done) return;
        yield item.value;
      }
    }
  }
}
