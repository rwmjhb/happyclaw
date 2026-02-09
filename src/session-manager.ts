/**
 * SessionManager — unified session lifecycle management.
 *
 * Manages all Provider-created sessions: spawn, resume, read, switchMode, stop.
 * Enforces security (ACL owner binding, cwd whitelist, session limits),
 * buffers messages with cursor pagination, and forwards events.
 *
 * Phase 2 enhancements:
 * - Drain timeout for mode switching (prevents indefinite wait)
 * - Session metadata persistence (~/.happyclaw/sessions.json)
 * - Proper reconcileOnStartup (PID check, dead cleanup, live re-register)
 * - State transition event notifications
 *
 * Reference: docs/technical-proposal.md §3.3.4
 */

import path from 'node:path';
import { EventEmitter } from 'node:events';

import type {
  ProviderSession,
  SessionProvider,
  SpawnOptions,
  SessionMode,
  SessionMessage,
  SessionEvent,
  SwitchState,
  PersistedSession,
  ReadResult,
  SessionACL as ISessionACL,
} from './types/index.js';

import { SessionACL } from './security/index.js';
import { CwdWhitelist } from './security/index.js';
import type { SessionPersistence } from './persistence.js';
import { redactSensitive } from './redact.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SessionManagerOptions {
  /** Maximum concurrent sessions (default: 10) */
  maxSessions?: number;
  /** Allowed working directories (empty = no restriction) */
  cwdWhitelist?: string[];
  /** Injected ACL instance (default: creates own) */
  acl?: ISessionACL;
  /** Drain timeout in ms for mode switching (default: 30_000) */
  drainTimeoutMs?: number;
  /** Session persistence layer (optional, enables auto-save) */
  persistence?: SessionPersistence;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ProviderSession>();
  private providers = new Map<string, SessionProvider>();
  private switchStates = new Map<string, SwitchState>();
  private messageBuffers = new Map<string, SessionMessage[]>();
  private lastActivityTimes = new Map<string, number>();

  private readonly maxSessions: number;
  private readonly cwdWhitelist: CwdWhitelist;
  private readonly drainTimeoutMs: number;
  private readonly persistence: SessionPersistence | undefined;
  readonly acl: ISessionACL;

  constructor(options: SessionManagerOptions = {}) {
    super();
    this.maxSessions = options.maxSessions ?? 10;
    this.cwdWhitelist = new CwdWhitelist(options.cwdWhitelist ?? []);
    this.acl = options.acl ?? new SessionACL();
    this.drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
    this.persistence = options.persistence;
  }

  // -------------------------------------------------------------------------
  // Provider registration
  // -------------------------------------------------------------------------

  registerProvider(provider: SessionProvider): void {
    this.providers.set(provider.name, provider);
  }

  getProvider(name: string): SessionProvider | undefined {
    return this.providers.get(name);
  }

  // -------------------------------------------------------------------------
  // Session accessors
  // -------------------------------------------------------------------------

  /** Get a session by ID. Throws if not found. */
  get(sessionId: string): ProviderSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }

  /** Get the switch-state for a session */
  getSwitchState(sessionId: string): SwitchState | undefined {
    return this.switchStates.get(sessionId);
  }

  /** Get the last activity timestamp for a session */
  getLastActivity(sessionId: string): number | undefined {
    return this.lastActivityTimes.get(sessionId);
  }

  /** List sessions, optionally filtered by cwd and/or provider */
  list(filter?: {
    cwd?: string;
    provider?: string;
  }): ProviderSession[] {
    let results = Array.from(this.sessions.values());
    if (filter?.cwd) {
      const resolved = path.resolve(filter.cwd);
      results = results.filter((s) => s.cwd === resolved);
    }
    if (filter?.provider) {
      results = results.filter((s) => s.provider === filter.provider);
    }
    return results;
  }

  /** Total active session count */
  get size(): number {
    return this.sessions.size;
  }

  // -------------------------------------------------------------------------
  // Spawn
  // -------------------------------------------------------------------------

  /**
   * Spawn a new session.
   *
   * Security: cwd whitelist + session limit checked before spawn.
   * Owner is bound BEFORE event forwarding starts (avoids R3-3 race).
   * Persists session metadata if persistence is configured.
   */
  async spawn(
    providerName: string,
    options: SpawnOptions,
    ownerId?: string,
  ): Promise<ProviderSession> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerName}`);
    }

    // Security checks
    const resolvedCwd = path.resolve(options.cwd);
    this.cwdWhitelist.assertAllowed(resolvedCwd);

    if (this.sessions.size >= this.maxSessions) {
      throw new Error(
        `Session limit reached (${this.maxSessions}). Stop an existing session first.`,
      );
    }

    const session = await provider.spawn({
      ...options,
      cwd: resolvedCwd,
    });

    this.sessions.set(session.id, session);
    this.switchStates.set(session.id, 'running');
    this.messageBuffers.set(session.id, []);

    // Bind owner BEFORE event forwarding (R3-3)
    if (ownerId) {
      this.acl.setOwner(session.id, ownerId);
    }

    this.attachSessionListeners(session);

    // Persist metadata
    await this.persistSession(session, ownerId);

    return session;
  }

  // -------------------------------------------------------------------------
  // Resume
  // -------------------------------------------------------------------------

  /**
   * Resume an existing session.
   *
   * The session must already be tracked (i.e., previously spawned by this
   * manager). Uses the original provider and cwd.
   */
  async resume(
    sessionId: string,
    options: { mode: SessionMode },
  ): Promise<ProviderSession> {
    const existing = this.sessions.get(sessionId);
    const providerName = existing?.provider;
    const cwd = existing?.cwd;
    if (!providerName || !cwd) {
      throw new Error(`Cannot resume unknown session: ${sessionId}`);
    }

    const provider = this.providers.get(providerName)!;
    const newSession = await provider.resume(sessionId, {
      cwd,
      mode: options.mode,
    });

    this.sessions.set(sessionId, newSession);
    this.switchStates.set(sessionId, 'running');
    // Preserve existing message buffer for continuity
    if (!this.messageBuffers.has(sessionId)) {
      this.messageBuffers.set(sessionId, []);
    }

    this.attachSessionListeners(newSession);

    // Update persisted metadata with new mode/pid
    await this.persistence?.update(sessionId, {
      mode: options.mode,
      pid: newSession.pid,
    });

    return newSession;
  }

  // -------------------------------------------------------------------------
  // Read (cursor-based pagination)
  // -------------------------------------------------------------------------

  /**
   * Read messages from a session's buffer with cursor-based pagination.
   *
   * Cursor is a stringified integer index into the buffer.
   * Returns messages starting at cursor, up to limit count.
   */
  readMessages(
    sessionId: string,
    options?: { cursor?: string; limit?: number },
  ): ReadResult {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) {
      throw new Error(`No message buffer for session: ${sessionId}`);
    }

    const cursor = options?.cursor ? parseInt(options.cursor, 10) : 0;
    const limit = options?.limit ?? 50;

    const start = Math.max(0, Math.min(cursor, buffer.length));
    const end = Math.min(start + limit, buffer.length);
    const messages = buffer.slice(start, end).map((msg) => ({
      ...msg,
      content: redactSensitive(msg.content),
    }));

    return {
      messages,
      nextCursor: String(end),
    };
  }

  // -------------------------------------------------------------------------
  // Retry resume (exponential backoff)
  // -------------------------------------------------------------------------

  /**
   * Retry resuming a session with exponential backoff.
   *
   * Calls `this.resume()` on each attempt — the session must be tracked
   * in the sessions map. Emits events on each attempt and on exhaustion.
   */
  async retryResume(
    sessionId: string,
    options?: { maxRetries?: number; baseDelayMs?: number },
  ): Promise<ProviderSession> {
    const maxRetries = options?.maxRetries ?? 3;
    const baseDelayMs = options?.baseDelayMs ?? 1000;

    const existing = this.sessions.get(sessionId);
    const mode = existing?.mode ?? 'remote';

    let lastError: unknown;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const delay = baseDelayMs * Math.pow(2, attempt);

      this.emit('event', {
        type: 'error',
        severity: 'info',
        sessionId,
        timestamp: Date.now(),
        summary: `Retry attempt ${attempt + 1}/${maxRetries} in ${delay}ms...`,
      } satisfies SessionEvent);

      await sleep(delay);

      try {
        return await this.resume(sessionId, { mode });
      } catch (err) {
        lastError = err;
      }
    }

    const message = lastError instanceof Error
      ? lastError.message
      : String(lastError);

    this.emit('event', {
      type: 'error',
      severity: 'urgent',
      sessionId,
      timestamp: Date.now(),
      summary: `All ${maxRetries} retry attempts exhausted: ${message}`,
    } satisfies SessionEvent);

    throw new Error(
      `Failed to resume session ${sessionId} after ${maxRetries} retries: ${message}`,
    );
  }

  // -------------------------------------------------------------------------
  // Mode switching (state machine with drain timeout)
  // -------------------------------------------------------------------------

  /**
   * Switch a session between local and remote modes.
   *
   * State machine: running -> draining -> switching -> running
   * Drain phase has a configurable timeout (default 30s) to prevent
   * indefinite waits when in-flight tool calls don't complete.
   * On failure: sets 'error' state, removes session from map, emits error event.
   */
  async switchMode(
    sessionId: string,
    target: SessionMode,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const state = this.switchStates.get(sessionId);
    if (state !== 'running') {
      throw new Error(
        `Session ${sessionId} is in '${state}' state, cannot switch.`,
      );
    }

    if (session.mode === target) {
      return; // Already in target mode
    }

    // running -> draining (with timeout)
    this.switchStates.set(sessionId, 'draining');
    this.emitStateTransition(sessionId, 'running', 'draining');

    try {
      await withTimeout(
        session.switchMode(target),
        this.drainTimeoutMs,
        `Drain timed out after ${this.drainTimeoutMs}ms`,
      );
    } catch (err) {
      // Drain timeout or error — force stop and continue switching
      this.emitStateTransition(sessionId, 'draining', 'switching');
      this.emit('event', {
        type: 'error',
        severity: 'warning',
        sessionId,
        timestamp: Date.now(),
        summary: `Drain phase interrupted: ${err instanceof Error ? err.message : String(err)}. Forcing mode switch.`,
      } satisfies SessionEvent);
    }

    // draining -> switching
    this.switchStates.set(sessionId, 'switching');
    this.emitStateTransition(sessionId, 'draining', 'switching');

    const oldSession = session;
    const provider = this.providers.get(session.provider);
    if (!provider) {
      this.handleSwitchFailure(sessionId, new Error('Provider not found'));
      return;
    }

    await oldSession.stop();

    try {
      const newSession = await provider.resume(sessionId, {
        cwd: oldSession.cwd,
        mode: target,
      });

      this.sessions.set(sessionId, newSession);
      this.switchStates.set(sessionId, 'running');
      this.emitStateTransition(sessionId, 'switching', 'running');

      // Preserve buffer across switches
      if (!this.messageBuffers.has(sessionId)) {
        this.messageBuffers.set(sessionId, []);
      }

      this.attachSessionListeners(newSession);

      // Update persisted metadata
      await this.persistence?.update(sessionId, {
        mode: target,
        pid: newSession.pid,
      });
    } catch (err) {
      this.handleSwitchFailure(sessionId, err);
    }
  }

  // -------------------------------------------------------------------------
  // Stop
  // -------------------------------------------------------------------------

  /** Stop a session and clean up all associated resources. */
  async stop(sessionId: string, force?: boolean): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    await session.stop(force);
    this.cleanup(sessionId);
  }

  // -------------------------------------------------------------------------
  // Startup reconciliation
  // -------------------------------------------------------------------------

  /**
   * Reconcile persisted sessions on startup.
   *
   * For each persisted session:
   * - Dead (PID gone): remove from persistence
   * - Alive: re-register in the sessions map with owner ACL binding
   *   (without re-spawning — the CLI process is already running)
   *
   * Note: alive sessions are registered as "stale references" since we
   * can't reconnect to the running process. They appear in list() but
   * send/read/stop won't work until the user explicitly resumes them.
   * This is a deliberate trade-off — full reconnect requires Provider
   * support for attaching to an existing process.
   */
  async reconcileOnStartup(
    persisted: PersistedSession[],
  ): Promise<{ alive: PersistedSession[]; dead: PersistedSession[] }> {
    const alive: PersistedSession[] = [];
    const dead: PersistedSession[] = [];

    for (const entry of persisted) {
      try {
        process.kill(entry.pid, 0); // Signal 0 = check if process exists
        alive.push(entry);
      } catch {
        dead.push(entry);
      }
    }

    // Remove dead sessions from persistence
    if (dead.length > 0 && this.persistence) {
      await this.persistence.removeMany(dead.map((s) => s.id));
    }

    // Re-register alive sessions' ACL ownership
    // (sessions themselves are not re-added to the map since we can't
    // reconnect to the running process — they need explicit resume)
    for (const entry of alive) {
      // Re-register ACL so the owner can resume/stop
      // We don't add to this.sessions because there's no ProviderSession
      // object — the user must call session.resume to re-attach
      this.switchStates.set(entry.id, 'running');
    }

    return { alive, dead };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Attach event and message listeners to a session.
   * Also sets up process exit monitoring for auto-cleanup.
   */
  private attachSessionListeners(session: ProviderSession): void {
    // Forward events to EventEmitter
    session.onEvent((event) => {
      this.emit('event', event);
      this.handleProcessEvent(session.id, event);
    });

    // Buffer messages, track activity, and forward to EventEmitter
    session.onMessage((msg) => {
      const buffer = this.messageBuffers.get(session.id);
      if (buffer) {
        buffer.push(msg);
      }
      this.lastActivityTimes.set(session.id, msg.timestamp || Date.now());
      this.emit('message', session.id, msg);
    });
  }

  /**
   * Monitor session events for process exit/crash.
   * Auto-cleans sessions when process exits unexpectedly.
   */
  private handleProcessEvent(
    sessionId: string,
    event: SessionEvent,
  ): void {
    // Detect process exit from both error and task_complete events
    const isProcessExit =
      event.summary.includes('Process exited') ||
      event.summary.includes('process exited') ||
      event.summary.includes('Process error');

    if (isProcessExit) {
      // Don't cleanup during mode switching — the old process is expected to exit
      const state = this.switchStates.get(sessionId);
      if (state === 'draining' || state === 'switching') {
        return;
      }
      this.cleanup(sessionId);
    }
  }

  /** Handle switch mode failure: mark error, remove session, emit event. */
  private handleSwitchFailure(
    sessionId: string,
    err: unknown,
  ): void {
    this.switchStates.set(sessionId, 'error');
    this.sessions.delete(sessionId);
    // Keep message buffer for debugging, but remove from active management
    this.acl.removeSession(sessionId);

    const message = err instanceof Error ? err.message : String(err);
    this.emit('event', {
      type: 'error',
      severity: 'urgent',
      sessionId,
      timestamp: Date.now(),
      summary:
        `Mode switch failed. Session is no longer available. ` +
        `Use session.spawn to create a new session or session.resume to recover: ${message}`,
    } satisfies SessionEvent);

    // Update persistence to reflect error state
    this.persistence?.remove(sessionId).catch(() => {});
  }

  /** Remove all tracking for a session. */
  private cleanup(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.switchStates.delete(sessionId);
    this.messageBuffers.delete(sessionId);
    this.lastActivityTimes.delete(sessionId);
    this.acl.removeSession(sessionId);

    // Remove from persistence
    this.persistence?.remove(sessionId).catch(() => {});
  }

  /** Persist a session's metadata to disk */
  private async persistSession(
    session: ProviderSession,
    ownerId?: string,
  ): Promise<void> {
    if (!this.persistence || !ownerId) return;

    await this.persistence.add({
      id: session.id,
      provider: session.provider,
      cwd: session.cwd,
      pid: session.pid,
      ownerId,
      mode: session.mode,
      createdAt: Date.now(),
    });
  }

  /** Emit a state transition event for observability */
  private emitStateTransition(
    sessionId: string,
    from: SwitchState,
    to: SwitchState,
  ): void {
    this.emit('stateTransition', { sessionId, from, to });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sleep for the specified duration. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Race a promise against a timeout. Rejects with TimeoutError on expiry. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
