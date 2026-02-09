import { describe, it, expect } from 'vitest';
import { AsyncQueue } from '../../src/types/index.js';

describe('AsyncQueue', () => {
  describe('push and iterate', () => {
    it('yields items that were pushed before iteration', async () => {
      const queue = new AsyncQueue<number>();
      queue.push(1);
      queue.push(2);
      queue.push(3);
      queue.end();

      const results: number[] = [];
      for await (const item of queue) {
        results.push(item);
      }
      expect(results).toEqual([1, 2, 3]);
    });

    it('yields items pushed during iteration', async () => {
      const queue = new AsyncQueue<string>();

      const results: string[] = [];
      const consumer = (async () => {
        for await (const item of queue) {
          results.push(item);
        }
      })();

      // Push with small delays to ensure consumer is waiting
      await tick();
      queue.push('a');
      await tick();
      queue.push('b');
      await tick();
      queue.end();

      await consumer;
      expect(results).toEqual(['a', 'b']);
    });

    it('handles interleaved push and consume', async () => {
      const queue = new AsyncQueue<number>();
      const results: number[] = [];

      const consumer = (async () => {
        for await (const item of queue) {
          results.push(item);
        }
      })();

      queue.push(10);
      queue.push(20);
      await tick();
      queue.push(30);
      await tick();
      queue.end();

      await consumer;
      expect(results).toEqual([10, 20, 30]);
    });
  });

  describe('multiple consumers', () => {
    it('distributes items across consumers from the same iterator', async () => {
      const queue = new AsyncQueue<number>();
      queue.push(1);
      queue.push(2);
      queue.push(3);
      queue.end();

      // Single async iterator — items consumed in order
      const iter = queue[Symbol.asyncIterator]();
      const r1 = await iter.next();
      const r2 = await iter.next();
      const r3 = await iter.next();
      const r4 = await iter.next();

      expect(r1).toEqual({ value: 1, done: false });
      expect(r2).toEqual({ value: 2, done: false });
      expect(r3).toEqual({ value: 3, done: false });
      expect(r4.done).toBe(true);
    });
  });

  describe('close behavior', () => {
    it('iteration ends when end() is called', async () => {
      const queue = new AsyncQueue<number>();
      queue.push(1);
      queue.end();

      const results: number[] = [];
      for await (const item of queue) {
        results.push(item);
      }
      expect(results).toEqual([1]);
    });

    it('resolves waiting consumers when end() is called', async () => {
      const queue = new AsyncQueue<number>();

      const consumer = (async () => {
        const results: number[] = [];
        for await (const item of queue) {
          results.push(item);
        }
        return results;
      })();

      // Consumer is now waiting for items
      await tick();
      queue.end();

      const results = await consumer;
      expect(results).toEqual([]);
    });

    it('throws when pushing to an ended queue', () => {
      const queue = new AsyncQueue<number>();
      queue.end();

      expect(() => queue.push(1)).toThrow('Cannot push to ended queue');
    });

    it('isEnded reflects queue state', () => {
      const queue = new AsyncQueue<number>();
      expect(queue.isEnded).toBe(false);

      queue.end();
      expect(queue.isEnded).toBe(true);
    });

    it('empty queue with immediate end yields nothing', async () => {
      const queue = new AsyncQueue<number>();
      queue.end();

      const results: number[] = [];
      for await (const item of queue) {
        results.push(item);
      }
      expect(results).toEqual([]);
    });
  });

  describe('backpressure handling', () => {
    it('buffers items when no consumer is waiting', async () => {
      const queue = new AsyncQueue<number>();

      // Push many items without consuming
      for (let i = 0; i < 100; i++) {
        queue.push(i);
      }
      queue.end();

      const results: number[] = [];
      for await (const item of queue) {
        results.push(item);
      }
      expect(results).toHaveLength(100);
      expect(results[0]).toBe(0);
      expect(results[99]).toBe(99);
    });

    it('delivers items immediately when consumer is already waiting', async () => {
      const queue = new AsyncQueue<number>();
      const timestamps: number[] = [];

      const consumer = (async () => {
        for await (const _ of queue) {
          timestamps.push(Date.now());
        }
      })();

      // Wait for consumer to start waiting
      await tick();

      // Push items — they should be delivered immediately to the waiting consumer
      queue.push(1);
      await tick();
      queue.push(2);
      await tick();
      queue.end();

      await consumer;
      expect(timestamps).toHaveLength(2);
    });
  });
});

/** Helper: yield control to the event loop so pending microtasks execute */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
