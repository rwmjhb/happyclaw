/**
 * EventBus — Centralized event routing with debounce and priority queue.
 *
 * Features:
 * - Debounce: batches rapid events within a configurable window (default 500ms)
 * - Priority queue: permission_request > error > task_complete > info events
 * - Subscriber routing: events delivered to registered handlers per session
 * - Global subscribers: handlers that receive events from all sessions
 *
 * This sits between SessionManager's raw event emissions and the
 * messaging platform adapters (Telegram/Discord).
 */

import { EventEmitter } from 'node:events';
import type { SessionEvent, SessionEventType } from './types/index.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EventBusOptions {
  /** Debounce window in ms (default: 500) */
  debounceMs?: number;
  /** Maximum batch size before force-flush (default: 20) */
  maxBatchSize?: number;
}

// ---------------------------------------------------------------------------
// Priority mapping
// ---------------------------------------------------------------------------

/** Event priority — lower number = higher priority */
const EVENT_PRIORITY: Record<SessionEventType, number> = {
  permission_request: 0,
  error: 1,
  waiting_for_input: 2,
  task_complete: 3,
  ready: 4,
};

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

export type EventHandler = (events: SessionEvent[]) => void;

export class EventBus extends EventEmitter {
  private readonly debounceMs: number;
  private readonly maxBatchSize: number;

  /** Per-session event batches (accumulated during debounce window) */
  private batches = new Map<string, SessionEvent[]>();
  /** Per-session debounce timers */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Per-session subscribers */
  private sessionHandlers = new Map<string, EventHandler[]>();
  /** Global subscribers (receive events from all sessions) */
  private globalHandlers: EventHandler[] = [];

  constructor(options: EventBusOptions = {}) {
    super();
    this.debounceMs = options.debounceMs ?? 500;
    this.maxBatchSize = options.maxBatchSize ?? 20;
  }

  // -------------------------------------------------------------------------
  // Publish
  // -------------------------------------------------------------------------

  /**
   * Publish a session event.
   *
   * The event is added to the session's batch. If the batch reaches
   * maxBatchSize, it's flushed immediately. Otherwise, a debounce timer
   * is started/reset.
   *
   * Exception: permission_request events are always flushed immediately
   * (they require timely user response).
   */
  publish(event: SessionEvent): void {
    const { sessionId } = event;

    // Permission requests bypass debounce — flush immediately
    if (event.type === 'permission_request') {
      this.deliverBatch(sessionId, [event]);
      return;
    }

    // Get or create batch
    let batch = this.batches.get(sessionId);
    if (!batch) {
      batch = [];
      this.batches.set(sessionId, batch);
    }

    batch.push(event);

    // Force flush if batch is full
    if (batch.length >= this.maxBatchSize) {
      this.flush(sessionId);
      return;
    }

    // Reset debounce timer
    const existingTimer = this.timers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    this.timers.set(
      sessionId,
      setTimeout(() => this.flush(sessionId), this.debounceMs),
    );
  }

  // -------------------------------------------------------------------------
  // Subscribe
  // -------------------------------------------------------------------------

  /**
   * Subscribe to events for a specific session.
   * Handler receives batched events sorted by priority.
   */
  subscribe(sessionId: string, handler: EventHandler): void {
    let handlers = this.sessionHandlers.get(sessionId);
    if (!handlers) {
      handlers = [];
      this.sessionHandlers.set(sessionId, handlers);
    }
    handlers.push(handler);
  }

  /**
   * Subscribe to events from all sessions.
   * Handler receives batched events sorted by priority.
   */
  subscribeAll(handler: EventHandler): void {
    this.globalHandlers.push(handler);
  }

  /** Remove a session-specific subscriber */
  unsubscribe(sessionId: string, handler: EventHandler): void {
    const handlers = this.sessionHandlers.get(sessionId);
    if (!handlers) return;
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
    if (handlers.length === 0) {
      this.sessionHandlers.delete(sessionId);
    }
  }

  /** Remove a global subscriber */
  unsubscribeAll(handler: EventHandler): void {
    const idx = this.globalHandlers.indexOf(handler);
    if (idx >= 0) this.globalHandlers.splice(idx, 1);
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /** Remove all subscriptions and pending batches for a session */
  removeSession(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);

    // Flush any remaining events before removing
    const batch = this.batches.get(sessionId);
    if (batch && batch.length > 0) {
      this.deliverBatch(sessionId, this.sortByPriority(batch));
    }
    this.batches.delete(sessionId);

    this.sessionHandlers.delete(sessionId);
  }

  /** Flush all sessions and clean up all timers */
  dispose(): void {
    for (const [sessionId] of this.timers) {
      this.flush(sessionId);
    }
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.batches.clear();
    this.sessionHandlers.clear();
    this.globalHandlers = [];
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Flush a session's batched events: sort by priority and deliver */
  private flush(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);

    const batch = this.batches.get(sessionId);
    if (!batch || batch.length === 0) return;
    this.batches.delete(sessionId);

    const sorted = this.sortByPriority(batch);
    this.deliverBatch(sessionId, sorted);
  }

  /** Sort events by priority (lower number = higher priority) */
  private sortByPriority(events: SessionEvent[]): SessionEvent[] {
    return [...events].sort((a, b) => {
      const pa = EVENT_PRIORITY[a.type] ?? 99;
      const pb = EVENT_PRIORITY[b.type] ?? 99;
      if (pa !== pb) return pa - pb;
      // Stable sort: preserve timestamp order within same priority
      return a.timestamp - b.timestamp;
    });
  }

  /** Deliver a batch to session-specific and global handlers */
  private deliverBatch(sessionId: string, events: SessionEvent[]): void {
    if (events.length === 0) return;

    // Session-specific handlers
    const sessionHandlers = this.sessionHandlers.get(sessionId);
    if (sessionHandlers) {
      for (const handler of sessionHandlers) {
        try {
          handler(events);
        } catch {
          // Don't let handler errors break event delivery
        }
      }
    }

    // Global handlers
    for (const handler of this.globalHandlers) {
      try {
        handler(events);
      } catch {
        // Don't let handler errors break event delivery
      }
    }

    // Also emit on the EventEmitter for generic listeners
    this.emit('events', sessionId, events);
  }
}
