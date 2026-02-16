import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TelegramPushAdapter } from '../../src/push/telegram-push-adapter.js';
import type { SessionMessage, SessionEvent } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    type: 'text',
    content: 'hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    type: 'ready',
    severity: 'info',
    summary: 'test event',
    sessionId: 'sess-1',
    timestamp: Date.now(),
    ...overrides,
  };
}

// Mock fetch globally
const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

vi.stubGlobal('fetch', mockFetch);

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelegramPushAdapter', () => {
  let adapter: TelegramPushAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockClear();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();

    adapter = new TelegramPushAdapter(
      {
        botToken: 'test-token',
        defaultChatId: '-123456',
        debounceMs: 100,
      },
      logger,
    );
  });

  afterEach(() => {
    adapter.dispose();
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Session binding
  // -----------------------------------------------------------------------

  describe('session binding', () => {
    it('should not send messages for unbound sessions', () => {
      adapter.handleMessage('unbound-session', makeMsg());
      vi.advanceTimersByTime(200);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should send messages for bound sessions', async () => {
      adapter.bindSession('sess-1');
      adapter.handleMessage('sess-1', makeMsg({ content: 'test output' }));
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chat_id).toBe('-123456');
      expect(body.text).toContain('test output');
    });

    it('should use custom chatId when specified', async () => {
      adapter.bindSession('sess-1', '-999');
      adapter.handleMessage('sess-1', makeMsg());
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chat_id).toBe('-999');
    });

    it('should stop sending after unbind', async () => {
      adapter.bindSession('sess-1');
      adapter.unbindSession('sess-1');
      adapter.handleMessage('sess-1', makeMsg());
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      // unbind may flush pending, but no new messages after unbind
      // Since there were no pending messages before unbind, nothing sent
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Message batching
  // -----------------------------------------------------------------------

  describe('message batching', () => {
    it('should batch messages within debounce window', async () => {
      adapter.bindSession('sess-1');
      adapter.handleMessage('sess-1', makeMsg({ content: 'line 1' }));
      adapter.handleMessage('sess-1', makeMsg({ content: 'line 2' }));
      adapter.handleMessage('sess-1', makeMsg({ content: 'line 3' }));

      // Not yet flushed
      expect(mockFetch).not.toHaveBeenCalled();

      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      // Flushed as one batch — formatForTelegram may produce 1 chunk
      expect(mockFetch).toHaveBeenCalled();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toContain('line 1');
      expect(body.text).toContain('line 2');
      expect(body.text).toContain('line 3');
    });

    it('should reset debounce timer on new messages', async () => {
      adapter.bindSession('sess-1');
      adapter.handleMessage('sess-1', makeMsg({ content: 'first' }));

      // Advance 80ms (within 100ms debounce)
      vi.advanceTimersByTime(80);
      expect(mockFetch).not.toHaveBeenCalled();

      // New message resets timer
      adapter.handleMessage('sess-1', makeMsg({ content: 'second' }));
      vi.advanceTimersByTime(80);
      expect(mockFetch).not.toHaveBeenCalled();

      // Full debounce from last message
      vi.advanceTimersByTime(30);
      await vi.runAllTimersAsync();

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toContain('first');
      expect(body.text).toContain('second');
    });

    it('should handle messages from multiple sessions independently', async () => {
      adapter.bindSession('sess-1');
      adapter.bindSession('sess-2', '-777');

      adapter.handleMessage('sess-1', makeMsg({ content: 'from sess-1' }));
      adapter.handleMessage('sess-2', makeMsg({ content: 'from sess-2' }));

      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(mockFetch).toHaveBeenCalledTimes(2);

      const bodies = mockFetch.mock.calls.map(
        (c: unknown[]) => JSON.parse((c[1] as { body: string }).body),
      );
      const chatIds = bodies.map((b: { chat_id: string }) => b.chat_id);
      expect(chatIds).toContain('-123456');
      expect(chatIds).toContain('-777');
    });
  });

  // -----------------------------------------------------------------------
  // Event handling
  // -----------------------------------------------------------------------

  describe('event handling', () => {
    it('should push permission_request events', async () => {
      adapter.bindSession('sess-1');
      adapter.handleEvents([
        makeEvent({
          type: 'permission_request',
          severity: 'urgent',
          sessionId: 'sess-1',
          permissionDetail: {
            requestId: 'req-123',
            toolName: 'Edit',
            input: { file: 'test.ts' },
          },
        }),
      ]);

      await vi.runAllTimersAsync();

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toContain('Permission Request');
      expect(body.text).toContain('Edit');
      expect(body.text).toContain('req-123');
    });

    it('should push task_complete events', async () => {
      adapter.bindSession('sess-1');
      adapter.handleEvents([
        makeEvent({
          type: 'task_complete',
          sessionId: 'sess-1',
          summary: 'All tests passed',
        }),
      ]);

      await vi.runAllTimersAsync();

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toContain('Task Complete');
      expect(body.text).toContain('All tests passed');
    });

    it('should push error events', async () => {
      adapter.bindSession('sess-1');
      adapter.handleEvents([
        makeEvent({
          type: 'error',
          severity: 'urgent',
          sessionId: 'sess-1',
          summary: 'Process crashed',
        }),
      ]);

      await vi.runAllTimersAsync();

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toContain('Error');
      expect(body.text).toContain('Process crashed');
    });

    it('should skip non-critical events (ready)', () => {
      adapter.bindSession('sess-1');
      adapter.handleEvents([
        makeEvent({ type: 'ready', sessionId: 'sess-1' }),
      ]);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip events for unbound sessions', () => {
      adapter.handleEvents([
        makeEvent({
          type: 'task_complete',
          sessionId: 'unbound',
          summary: 'done',
        }),
      ]);

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Telegram API interaction
  // -----------------------------------------------------------------------

  describe('Telegram API', () => {
    it('should POST to correct Bot API URL', async () => {
      adapter.bindSession('sess-1');
      adapter.handleMessage('sess-1', makeMsg());
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest-token/sendMessage',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    it('should use Markdown parse mode', async () => {
      adapter.bindSession('sess-1');
      adapter.handleMessage('sess-1', makeMsg());
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.parse_mode).toBe('Markdown');
      expect(body.disable_web_page_preview).toBe(true);
    });

    it('should retry on 429 rate limit', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Map([['Retry-After', '1']]),
          text: () => Promise.resolve('rate limited'),
        })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      adapter.bindSession('sess-1');
      adapter.handleMessage('sess-1', makeMsg());
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      // Should have retried
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('rate limited'),
      );
    });

    it('should log warning on non-429 API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('bad request'),
      });

      adapter.bindSession('sess-1');
      adapter.handleMessage('sess-1', makeMsg());
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('TG API 400'),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Dispose
  // -----------------------------------------------------------------------

  describe('dispose', () => {
    it('should flush pending messages on dispose', async () => {
      adapter.bindSession('sess-1');
      adapter.handleMessage('sess-1', makeMsg({ content: 'final' }));

      // Dispose before debounce
      adapter.dispose();
      await vi.runAllTimersAsync();

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toContain('final');
    });

    it('should clear all state on dispose', () => {
      adapter.bindSession('sess-1');
      adapter.handleMessage('sess-1', makeMsg());
      adapter.dispose();

      // After dispose, new messages should be ignored
      adapter.handleMessage('sess-1', makeMsg());
      vi.advanceTimersByTime(200);

      // Only the flush from dispose, nothing after
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
