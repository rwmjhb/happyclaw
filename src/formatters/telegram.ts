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

// ---------------------------------------------------------------------------
// Codex command cleaning
// ---------------------------------------------------------------------------

/**
 * Extract the actual command from Codex's raw shell invocation format.
 * e.g. "/bin/zsh,-lc,pnpm test -- --run foo.test.ts" → "pnpm test -- --run foo.test.ts"
 * e.g. "/bin/bash,-lc,npm run build" → "npm run build"
 */
function cleanCodexCommand(raw: string): string {
  // Pattern: /bin/zsh,-lc,<actual command> or /bin/bash,-lc,<actual command>
  const match = raw.match(/^\/bin\/(?:z|ba)sh,-lc,(.+)$/s);
  if (match) return match[1];

  // Array-style: ["/bin/zsh", "-lc", "actual command"]
  // Sometimes the content is already the command array joined by comma
  const arrayMatch = raw.match(/^\/bin\/(?:z|ba)sh,-l?c?,(.+)$/s);
  if (arrayMatch) return arrayMatch[1];

  return raw;
}

// ---------------------------------------------------------------------------
// Diff detection
// ---------------------------------------------------------------------------

/** Check if text content looks like a unified diff (safety net). */
function isDiffContent(content: string): boolean {
  return content.startsWith('diff --git ') ||
    (content.includes('--- a/') && content.includes('+++ b/'));
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

/** Format a single message to Telegram markdown. Returns '' to skip. */
function formatMessage(msg: SessionMessage): string {
  switch (msg.type) {
    case 'code':
      return `\`\`\`${msg.metadata?.language ?? ''}\n${msg.content}\n\`\`\`\n`;
    case 'tool_use': {
      const tool = msg.metadata?.tool ?? 'unknown';
      // Silent tools: skip entirely
      if (SILENT_TOOLS.has(tool)) return '';
      // Codex commands: clean up raw shell invocation format
      const content = tool === 'CodexBash'
        ? cleanCodexCommand(msg.content)
        : msg.content;
      // Truncate to avoid spam
      const preview = content.length > 120
        ? content.slice(0, 117) + '...'
        : content;
      return `*Tool:* \`${tool}\`\n${preview}\n`;
    }
    case 'tool_result': {
      const tool = msg.metadata?.tool;
      // Skip long results (likely raw JSON/diff output), show short ones
      if (msg.content.length > 200) return '';
      // Skip diff content in short results too
      if (isDiffContent(msg.content)) return '';
      // CodexBash/CodexPatch: skip generic confirmations that add no value
      if (tool === 'CodexPatch' && /^Patch applied\b/.test(msg.content)) return '';
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
      // Safety net: skip diff content that leaked through as 'text'
      if (isDiffContent(msg.content)) return '';
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

// Export for testing
export { cleanCodexCommand, isDiffContent, formatMessage };
