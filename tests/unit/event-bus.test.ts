import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus } from '../../src/event-bus.js';
import type { SessionEvent, SessionEventType } from '../../src/types/index.js';

function makeEvent(
  overrides: Partial<SessionEvent> = {},
): SessionEvent {
  return {
    type: overrides.type ?? 'ready',
    severity: overrides.severity ?? 'info',
    summary: overrides.summary ?? 'test event',
    sessionId: overrides.sessionId ?? 'session-1',
    timestamp: overrides.timestamp ?? Date.now(),
    ...overrides,
  };
}

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new EventBus({ debounceMs: 100, maxBatchSize: 5 });
  });

  afterEach(() => {
    bus.dispose();
    vi.useRealTimers();
  });

  describe('debouncing', () => {
    it('batches events within the debounce window', () => {
      const received: SessionEvent[][] = [];
      bus.subscribe('s1', (events) => received.push(events));

      bus.publish(makeEvent({ sessionId: 's1', summary: 'e1' }));
      bus.publish(makeEvent({ sessionId: 's1', summary: 'e2' }));
      bus.publish(makeEvent({ sessionId: 's1', summary: 'e3' }));

      // Not yet flushed
      expect(received).toHaveLength(0);

      // Advance past debounce window
      vi.advanceTimersByTime(150);

      // All 3 events delivered as single batch
      expect(received).toHaveLength(1);
      expect(received[0]).toHaveLength(3);
    });

    it('resets debounce timer on each new event', () => {
      const received: SessionEvent[][] = [];
      bus.subscribe('s1', (events) => received.push(events));

      bus.publish(makeEvent({ sessionId: 's1', summary: 'e1' }));
      vi.advanceTimersByTime(80); // Not past 100ms yet

      bus.publish(makeEvent({ sessionId: 's1', summary: 'e2' }));
      vi.advanceTimersByTime(80); // Timer was reset, still not flushed

      expect(received).toHaveLength(0);

      vi.advanceTimersByTime(50); // Now past 100ms from last event
      expect(received).toHaveLength(1);
      expect(received[0]).toHaveLength(2);
    });

    it('flushes immediately when batch reaches maxBatchSize', () => {
      const received: SessionEvent[][] = [];
      bus.subscribe('s1', (events) => received.push(events));

      // Push 5 events (maxBatchSize = 5)
      for (let i = 0; i < 5; i++) {
        bus.publish(makeEvent({ sessionId: 's1', summary: `e${i}` }));
      }

      // Should have flushed immediately without waiting for timer
      expect(received).toHaveLength(1);
      expect(received[0]).toHaveLength(5);
    });
  });

  describe('permission_request bypass', () => {
    it('flushes permission_request events immediately (no debounce)', () => {
      const received: SessionEvent[][] = [];
      bus.subscribe('s1', (events) => received.push(events));

      bus.publish(makeEvent({
        sessionId: 's1',
        type: 'permission_request',
        summary: 'Tool needs approval',
      }));

      // Should be delivered immediately — no timer advance needed
      expect(received).toHaveLength(1);
      expect(received[0]).toHaveLength(1);
      expect(received[0][0].type).toBe('permission_request');
    });

    it('does not batch permission_request with other pending events', () => {
      const received: SessionEvent[][] = [];
      bus.subscribe('s1', (events) => received.push(events));

      // Push a regular event first (pending in batch)
      bus.publish(makeEvent({ sessionId: 's1', type: 'ready', summary: 'ready' }));

      // Push a permission_request — should flush as its own batch
      bus.publish(makeEvent({
        sessionId: 's1',
        type: 'permission_request',
        summary: 'approve?',
      }));

      // Permission request delivered immediately
      expect(received).toHaveLength(1);
      expect(received[0][0].type).toBe('permission_request');

      // The ready event is still pending
      vi.advanceTimersByTime(150);

      // Now the regular event batch is flushed
      expect(received).toHaveLength(2);
      expect(received[1][0].type).toBe('ready');
    });
  });

  describe('priority sorting', () => {
    it('sorts batched events by priority (permission > error > task_complete > ready)', () => {
      const received: SessionEvent[][] = [];
      bus.subscribe('s1', (events) => received.push(events));

      // Publish in reverse priority order
      bus.publish(makeEvent({ sessionId: 's1', type: 'ready', timestamp: 1 }));
      bus.publish(makeEvent({ sessionId: 's1', type: 'task_complete', timestamp: 2 }));
      bus.publish(makeEvent({ sessionId: 's1', type: 'error', timestamp: 3 }));
      // (permission_request bypasses, so test with remaining types)

      vi.advanceTimersByTime(150);

      expect(received).toHaveLength(1);
      const types = received[0].map((e) => e.type);
      expect(types).toEqual(['error', 'task_complete', 'ready']);
    });

    it('preserves timestamp order within same priority', () => {
      const received: SessionEvent[][] = [];
      bus.subscribe('s1', (events) => received.push(events));

      bus.publish(makeEvent({ sessionId: 's1', type: 'error', timestamp: 100, summary: 'first' }));
      bus.publish(makeEvent({ sessionId: 's1', type: 'error', timestamp: 200, summary: 'second' }));

      vi.advanceTimersByTime(150);

      expect(received[0][0].summary).toBe('first');
      expect(received[0][1].summary).toBe('second');
    });
  });

  describe('subscriptions', () => {
    it('delivers to session-specific subscribers', () => {
      const s1Events: SessionEvent[][] = [];
      const s2Events: SessionEvent[][] = [];

      bus.subscribe('s1', (events) => s1Events.push(events));
      bus.subscribe('s2', (events) => s2Events.push(events));

      bus.publish(makeEvent({ sessionId: 's1', summary: 'for s1' }));
      bus.publish(makeEvent({ sessionId: 's2', summary: 'for s2' }));

      vi.advanceTimersByTime(150);

      expect(s1Events).toHaveLength(1);
      expect(s1Events[0][0].summary).toBe('for s1');
      expect(s2Events).toHaveLength(1);
      expect(s2Events[0][0].summary).toBe('for s2');
    });

    it('delivers to global subscribers from all sessions', () => {
      const allEvents: SessionEvent[][] = [];
      bus.subscribeAll((events) => allEvents.push(events));

      bus.publish(makeEvent({ sessionId: 's1' }));
      bus.publish(makeEvent({ sessionId: 's2' }));

      vi.advanceTimersByTime(150);

      // Two separate batches (one per session)
      expect(allEvents).toHaveLength(2);
    });

    it('unsubscribe removes session handler', () => {
      const received: SessionEvent[][] = [];
      const handler = (events: SessionEvent[]) => received.push(events);

      bus.subscribe('s1', handler);
      bus.unsubscribe('s1', handler);

      bus.publish(makeEvent({ sessionId: 's1' }));
      vi.advanceTimersByTime(150);

      expect(received).toHaveLength(0);
    });

    it('unsubscribeAll removes global handler', () => {
      const received: SessionEvent[][] = [];
      const handler = (events: SessionEvent[]) => received.push(events);

      bus.subscribeAll(handler);
      bus.unsubscribeAll(handler);

      bus.publish(makeEvent({ sessionId: 's1' }));
      vi.advanceTimersByTime(150);

      expect(received).toHaveLength(0);
    });

    it('handler errors do not break other handlers', () => {
      const received: SessionEvent[][] = [];

      bus.subscribe('s1', () => {
        throw new Error('handler crash');
      });
      bus.subscribe('s1', (events) => received.push(events));

      bus.publish(makeEvent({ sessionId: 's1' }));
      vi.advanceTimersByTime(150);

      // Second handler should still receive events
      expect(received).toHaveLength(1);
    });
  });

  describe('removeSession', () => {
    it('flushes remaining events before removing', () => {
      const received: SessionEvent[][] = [];
      bus.subscribe('s1', (events) => received.push(events));

      bus.publish(makeEvent({ sessionId: 's1', summary: 'pending' }));

      // Remove session — should flush pending
      bus.removeSession('s1');

      expect(received).toHaveLength(1);
      expect(received[0][0].summary).toBe('pending');
    });

    it('removes all handlers and timers for the session', () => {
      const received: SessionEvent[][] = [];
      bus.subscribe('s1', (events) => received.push(events));

      bus.removeSession('s1');

      // Publishing after removal — no handler to receive
      bus.publish(makeEvent({ sessionId: 's1' }));
      vi.advanceTimersByTime(150);

      // Only the flush-on-remove delivery (empty since no prior events after clear)
      expect(received).toHaveLength(0);
    });
  });

  describe('dispose', () => {
    it('flushes all pending batches and clears state', () => {
      const s1Events: SessionEvent[][] = [];
      const s2Events: SessionEvent[][] = [];

      bus.subscribe('s1', (events) => s1Events.push(events));
      bus.subscribe('s2', (events) => s2Events.push(events));

      bus.publish(makeEvent({ sessionId: 's1' }));
      bus.publish(makeEvent({ sessionId: 's2' }));

      bus.dispose();

      // Events should have been flushed
      expect(s1Events).toHaveLength(1);
      expect(s2Events).toHaveLength(1);
    });
  });

  describe('EventEmitter integration', () => {
    it('emits "events" on the EventEmitter for generic listeners', () => {
      const emitted: { sessionId: string; events: SessionEvent[] }[] = [];
      bus.on('events', (sessionId: string, events: SessionEvent[]) => {
        emitted.push({ sessionId, events });
      });

      bus.publish(makeEvent({ sessionId: 's1' }));
      vi.advanceTimersByTime(150);

      expect(emitted).toHaveLength(1);
      expect(emitted[0].sessionId).toBe('s1');
    });
  });
});
