/**
 * Telegram message formatter.
 *
 * Converts SessionMessage[] to Telegram-safe markdown chunks
 * within the 4000 character limit (4096 max, with margin).
 */

import type { SessionMessage } from '../types/index.js';
import { redactSensitive } from '../redact.js';

const MAX_LENGTH = 4000;
const MAX_CHUNKS = 3;

// Tools whose raw output is noise for TG users (internal bookkeeping, etc.)
const SILENT_TOOLS = new Set([
  'TodoWrite', 'TodoRead', 'Task', 'TaskCreate', 'TaskUpdate', 'TaskList',
  'TaskGet', 'EnterPlanMode', 'ExitPlanMode', 'Skill',
]);

/** Format a single message to Telegram markdown. Returns '' to skip. */
function formatMessage(msg: SessionMessage): string {
  switch (msg.type) {
    case 'code':
      return `\`\`\`${msg.metadata?.language ?? ''}\n${msg.content}\n\`\`\`\n`;
    case 'tool_use': {
      const tool = msg.metadata?.tool ?? 'unknown';
      // Silent tools: skip entirely
      if (SILENT_TOOLS.has(tool)) return '';
      // Other tools: show tool name only, truncate content to avoid JSON spam
      const preview = msg.content.length > 120
        ? msg.content.slice(0, 117) + '...'
        : msg.content;
      return `*Tool:* \`${tool}\`\n${preview}\n`;
    }
    case 'tool_result': {
      // Skip long results (likely raw JSON output), show short ones
      if (msg.content.length > 200) return '';
      return `*Result:* ${msg.content}\n`;
    }
    case 'thinking':
      return '';  // Skip thinking — noise in TG
    case 'error':
      return `*Error:* ${msg.content}\n`;
    case 'result':
      return `*Done:* ${msg.content}\n`;
    case 'text':
    default:
      return msg.content + '\n';
  }
}

/** Summarize a batch of messages into a short overview */
function summarize(messages: SessionMessage[]): string {
  const counts: Record<string, number> = {};
  for (const m of messages) {
    counts[m.type] = (counts[m.type] ?? 0) + 1;
  }

  const parts = Object.entries(counts).map(
    ([type, count]) => `${count} ${type}`,
  );
  return `Session output: ${parts.join(', ')} messages total.`;
}

/**
 * Format messages for Telegram.
 *
 * Returns an array of message chunks, each within the character limit.
 * If there are more than 3 chunks, returns a summary instead.
 */
export function formatForTelegram(messages: SessionMessage[]): string[] {
  if (messages.length === 0) return [];

  const chunks: string[] = [];
  let current = '';

  for (const msg of messages) {
    const raw = formatMessage(msg);
    if (!raw) continue;  // Filtered out (silent tool, thinking, etc.)
    const formatted = redactSensitive(raw);
    if (current.length + formatted.length > MAX_LENGTH) {
      if (current) chunks.push(current);
      current = formatted.length > MAX_LENGTH
        ? formatted.slice(0, MAX_LENGTH - 3) + '...'
        : formatted;
    } else {
      current += formatted;
    }
  }
  if (current) chunks.push(current);

  if (chunks.length > MAX_CHUNKS) {
    return [
      summarize(messages),
      '(Use session.read with cursor pagination for full output)',
    ];
  }

  return chunks;
}
