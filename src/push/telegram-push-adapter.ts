/**
 * TelegramPushAdapter — pushes Claude CLI output directly to Telegram via Bot API.
 *
 * Subscribes to SessionManager 'message' events and EventBus session events,
 * batches messages with debounce, formats via formatForTelegram(), and
 * POSTs to Telegram Bot API. Zero agent token cost.
 *
 * Wiring (in openclaw-plugin.ts):
 *   manager.on('message', (sid, msg) => adapter.handleMessage(sid, msg))
 *   eventBus.subscribeAll((events) => adapter.handleEvents(events))
 */

import type { SessionMessage, SessionEvent } from '../types/index.js';
import { formatForTelegram } from '../formatters/telegram.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TelegramPushConfig {
  /** Telegram Bot API token */
  botToken: string;
  /** Default chat ID for push notifications */
  defaultChatId: string;
  /** Debounce window for batching messages (default: 1500ms) */
  debounceMs?: number;
}

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// TelegramPushAdapter
// ---------------------------------------------------------------------------

export class TelegramPushAdapter {
  private readonly botToken: string;
  private readonly defaultChatId: string;
  private readonly debounceMs: number;
  private readonly logger: Logger;

  /** Session → Telegram chat ID mapping */
  private sessionChats = new Map<string, string>();

  /** Per-session message batches */
  private batches = new Map<string, SessionMessage[]>();
  /** Per-session debounce timers */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: TelegramPushConfig, logger?: Logger) {
    this.botToken = config.botToken;
    this.defaultChatId = config.defaultChatId;
    this.debounceMs = config.debounceMs ?? 1500;
    this.logger = logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  // -------------------------------------------------------------------------
  // Session binding
  // -------------------------------------------------------------------------

  /** Bind a session to a Telegram chat. Uses defaultChatId if none specified. */
  bindSession(sessionId: string, chatId?: string): void {
    const resolved = chatId ?? this.defaultChatId;
    this.sessionChats.set(sessionId, resolved);
    this.logger.info(`Push bind: session="${sessionId}" → chat=${resolved}`);
  }

  /** Unbind a session and flush remaining messages. */
  unbindSession(sessionId: string): void {
    this.flush(sessionId);
    this.sessionChats.delete(sessionId);
  }

  // -------------------------------------------------------------------------
  // Message handler (subscribe to manager.on('message'))
  // -------------------------------------------------------------------------

  /** Handle a new message from SessionManager. Batches with debounce. */
  handleMessage(sessionId: string, msg: SessionMessage): void {
    const chatId = this.sessionChats.get(sessionId);
    if (!chatId) {
      this.logger.warn(
        `Push skip: no binding for session="${sessionId}" (type=${msg.type}, bindings=[${[...this.sessionChats.keys()].join(',')}])`,
      );
      return;
    }

    let batch = this.batches.get(sessionId);
    if (!batch) {
      batch = [];
      this.batches.set(sessionId, batch);
    }
    batch.push(msg);

    // Reset debounce timer
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      sessionId,
      setTimeout(() => this.flush(sessionId), this.debounceMs),
    );
  }

  // -------------------------------------------------------------------------
  // Event handler (subscribe to eventBus.subscribeAll)
  // -------------------------------------------------------------------------

  /** Handle session events. Permission requests are sent immediately. */
  handleEvents(events: SessionEvent[]): void {
    for (const event of events) {
      const chatId = this.sessionChats.get(event.sessionId);
      if (!chatId) continue;

      let text: string;
      switch (event.type) {
        case 'permission_request': {
          const detail = event.permissionDetail;
          const inputStr = JSON.stringify(detail?.input ?? {});
          const truncated =
            inputStr.length > 500 ? inputStr.slice(0, 497) + '...' : inputStr;
          text =
            `*Permission Request*\n` +
            `Tool: \`${detail?.toolName ?? 'unknown'}\`\n` +
            `Input: \`${truncated}\`\n\n` +
            `Request ID: \`${detail?.requestId ?? 'unknown'}\`\n` +
            `Use session\\_respond to approve or deny.`;
          break;
        }
        case 'task_complete':
          text = `*Task Complete*\n${event.summary}`;
          break;
        case 'error':
          text = `*Error*\n${event.summary}`;
          break;
        default:
          // Skip non-critical events (ready, waiting_for_input)
          continue;
      }

      this.sendToTelegram(chatId, text).catch((err) => {
        this.logger.error(`TG push event failed: ${err}`);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Flush & send
  // -------------------------------------------------------------------------

  /** Flush batched messages for a session and send to Telegram. */
  private flush(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);

    const batch = this.batches.get(sessionId);
    if (!batch || batch.length === 0) return;
    this.batches.delete(sessionId);

    const chatId = this.sessionChats.get(sessionId);
    if (!chatId) return;

    const chunks = formatForTelegram(batch);
    this.logger.info(
      `Push flush: session="${sessionId}", msgs=${batch.length}, chunks=${chunks.length}`,
    );
    // Send chunks sequentially to preserve order
    this.sendChunksSequentially(chatId, chunks).catch((err) => {
      this.logger.error(`TG push flush failed: ${err}`);
    });
  }

  /** Send multiple chunks in order */
  private async sendChunksSequentially(
    chatId: string,
    chunks: string[],
  ): Promise<void> {
    for (const chunk of chunks) {
      await this.sendToTelegram(chatId, chunk);
    }
  }

  /** POST a message to Telegram Bot API with retry on rate limit. */
  private async sendToTelegram(
    chatId: string,
    text: string,
  ): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (res.ok) {
      this.logger.info(`Push sent OK: chat=${chatId}, len=${text.length}`);
    }

    if (!res.ok) {
      const resBody = await res.text().catch(() => 'unknown');

      // Retry once on 429 (rate limit)
      if (res.status === 429) {
        const retryAfter = parseInt(
          res.headers.get('Retry-After') ?? '5',
          10,
        );
        this.logger.warn(`TG rate limited, retrying in ${retryAfter}s`);
        await sleep(retryAfter * 1000);

        const retry = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        if (!retry.ok) {
          this.logger.error(`TG retry failed: ${retry.status}`);
        }
        return;
      }

      this.logger.warn(`TG API ${res.status}: ${resBody.slice(0, 200)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /** Flush all pending batches and clean up. */
  dispose(): void {
    for (const [sessionId] of this.batches) {
      this.flush(sessionId);
    }
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.batches.clear();
    this.sessionChats.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
