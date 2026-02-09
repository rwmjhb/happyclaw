/**
 * Discord message formatter.
 *
 * Converts SessionMessage[] to Discord-safe markdown chunks
 * within the 1900 character limit (2000 max, with margin).
 * Also supports Discord embed objects for richer formatting.
 */

import type { SessionMessage, SessionEvent } from '../types/index.js';
import { redactSensitive } from '../redact.js';

const MAX_LENGTH = 1900;
const MAX_CHUNKS = 3;

/** Format a single message to Discord markdown */
function formatMessage(msg: SessionMessage): string {
  switch (msg.type) {
    case 'code':
      return `\`\`\`${msg.metadata?.language ?? ''}\n${msg.content}\n\`\`\`\n`;
    case 'tool_use':
      return `**Tool:** \`${msg.metadata?.tool ?? 'unknown'}\`\n${msg.content}\n`;
    case 'tool_result':
      return `**Result:** ${msg.content}\n`;
    case 'thinking':
      return `*Thinking...*\n`;
    case 'error':
      return `**Error:** ${msg.content}\n`;
    case 'result':
      return `**Done:** ${msg.content}\n`;
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
 * Format messages for Discord.
 *
 * Returns an array of message chunks, each within the character limit.
 * If there are more than 3 chunks, returns a summary instead.
 */
export function formatForDiscord(messages: SessionMessage[]): string[] {
  if (messages.length === 0) return [];

  const chunks: string[] = [];
  let current = '';

  for (const msg of messages) {
    const formatted = redactSensitive(formatMessage(msg));
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

// ---------------------------------------------------------------------------
// Discord Embed support
// ---------------------------------------------------------------------------

/** Discord embed object structure */
export interface DiscordEmbed {
  title?: string;
  description: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

/** Embed color constants */
const EMBED_COLOR_GREEN = 0x00ff00;
const EMBED_COLOR_RED = 0xff0000;
const EMBED_COLOR_YELLOW = 0xffff00;
const EMBED_COLOR_PERMISSION = 0xffaa00;

/** Discord embed description limit */
const EMBED_DESCRIPTION_LIMIT = 4000;

/**
 * Format messages as a Discord embed object.
 *
 * Color is determined by message content:
 * - Green: no errors
 * - Red: only errors
 * - Yellow: mixed (errors + other messages)
 */
export function formatAsEmbed(messages: SessionMessage[]): DiscordEmbed {
  if (messages.length === 0) {
    return {
      title: 'Session Output',
      description: 'No messages.',
      color: EMBED_COLOR_GREEN,
    };
  }

  const counts: Record<string, number> = {};
  let hasErrors = false;
  let hasNonErrors = false;

  for (const msg of messages) {
    counts[msg.type] = (counts[msg.type] ?? 0) + 1;
    if (msg.type === 'error') {
      hasErrors = true;
    } else {
      hasNonErrors = true;
    }
  }

  const color = determineEmbedColor(hasErrors, hasNonErrors);
  const isSummarized = messages.length > 10;
  const title = isSummarized ? 'Session Summary' : 'Session Output';

  const description = buildEmbedDescription(messages);

  const fields = Object.entries(counts).map(([type, count]) => ({
    name: type,
    value: String(count),
    inline: true,
  }));

  return {
    title,
    description,
    color,
    fields,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format a permission request event as a Discord embed.
 */
export function formatPermissionEmbed(event: SessionEvent): DiscordEmbed {
  const detail = event.permissionDetail;
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

  if (detail?.toolName) {
    fields.push({ name: 'Tool', value: `\`${detail.toolName}\``, inline: true });
  }

  if (detail?.input !== undefined) {
    const inputStr = typeof detail.input === 'string'
      ? detail.input
      : JSON.stringify(detail.input, null, 2);
    const truncated = inputStr.length > 200
      ? inputStr.slice(0, 197) + '...'
      : inputStr;
    fields.push({ name: 'Input', value: redactSensitive(truncated) });
  }

  if (detail?.decisionReason) {
    fields.push({ name: 'Reason', value: detail.decisionReason });
  }

  return {
    title: 'Permission Request',
    description: redactSensitive(event.summary),
    color: EMBED_COLOR_PERMISSION,
    fields,
    footer: { text: 'Reply with session.respond to approve/deny' },
    timestamp: new Date(event.timestamp).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Embed helpers
// ---------------------------------------------------------------------------

function determineEmbedColor(
  hasErrors: boolean,
  hasNonErrors: boolean,
): number {
  if (hasErrors && hasNonErrors) return EMBED_COLOR_YELLOW;
  if (hasErrors) return EMBED_COLOR_RED;
  return EMBED_COLOR_GREEN;
}

function buildEmbedDescription(messages: SessionMessage[]): string {
  let description = '';

  for (const msg of messages) {
    const formatted = redactSensitive(formatMessage(msg));
    if (description.length + formatted.length > EMBED_DESCRIPTION_LIMIT) {
      const remaining = EMBED_DESCRIPTION_LIMIT - description.length - 20;
      if (remaining > 0) {
        description += formatted.slice(0, remaining) + '\n...(truncated)';
      }
      break;
    }
    description += formatted;
  }

  return description || 'No content.';
}
