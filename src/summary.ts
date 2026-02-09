/**
 * Session output summarization.
 *
 * Extracts statistics from a SessionMessage[] buffer:
 * message counts by type, tools used, files modified, errors, and duration.
 */

import type { SessionMessage } from './types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structured summary of a session's message history */
export interface SessionSummary {
  totalMessages: number;
  messagesByType: Record<string, number>;
  toolsUsed: string[];
  filesModified: string[];
  errorsCount: number;
  lastActivity: number;
  status: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------

/**
 * Produce a structured summary from a list of session messages.
 *
 * - Counts messages by type
 * - Extracts unique tool names from tool_use messages (metadata.tool)
 * - Extracts unique file paths from metadata.file
 * - Counts error messages
 * - Calculates duration from first to last message timestamp
 * - Determines status from the last message type
 */
export function summarizeSession(messages: SessionMessage[]): SessionSummary {
  if (messages.length === 0) {
    return {
      totalMessages: 0,
      messagesByType: {},
      toolsUsed: [],
      filesModified: [],
      errorsCount: 0,
      lastActivity: 0,
      status: 'running',
      durationMs: 0,
    };
  }

  const messagesByType: Record<string, number> = {};
  const tools = new Set<string>();
  const files = new Set<string>();
  let errorsCount = 0;

  for (const msg of messages) {
    messagesByType[msg.type] = (messagesByType[msg.type] ?? 0) + 1;

    if (msg.type === 'tool_use' && msg.metadata?.tool) {
      tools.add(msg.metadata.tool);
    }

    if (msg.metadata?.file) {
      files.add(msg.metadata.file);
    }

    if (msg.type === 'error') {
      errorsCount++;
    }
  }

  const first = messages[0];
  const last = messages[messages.length - 1];
  const durationMs = last.timestamp - first.timestamp;

  const status = deriveStatus(last);

  return {
    totalMessages: messages.length,
    messagesByType,
    toolsUsed: Array.from(tools).sort(),
    filesModified: Array.from(files).sort(),
    errorsCount,
    lastActivity: last.timestamp,
    status,
    durationMs: Math.max(0, durationMs),
  };
}

// ---------------------------------------------------------------------------
// Human-readable formatting
// ---------------------------------------------------------------------------

/**
 * Format a SessionSummary into a human-readable multi-line string.
 */
export function formatSummaryText(summary: SessionSummary): string {
  const lines: string[] = [];

  // Message counts
  const typeParts = Object.entries(summary.messagesByType)
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');

  lines.push(
    `Session summary: ${summary.totalMessages} messages (${typeParts})`,
  );

  // Tools
  if (summary.toolsUsed.length > 0) {
    lines.push(`Tools used: ${summary.toolsUsed.join(', ')}`);
  }

  // Files
  if (summary.filesModified.length > 0) {
    lines.push(`Files modified: ${summary.filesModified.join(', ')}`);
  }

  // Errors
  if (summary.errorsCount > 0) {
    lines.push(`Errors: ${summary.errorsCount}`);
  }

  // Duration
  lines.push(`Duration: ${formatDuration(summary.durationMs)}`);

  // Status
  lines.push(`Status: ${summary.status}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive session status from the last message */
function deriveStatus(lastMessage: SessionMessage): string {
  switch (lastMessage.type) {
    case 'result':
      return 'completed';
    case 'error':
      return 'error';
    default:
      return 'running';
  }
}

/** Format milliseconds into a human-readable duration string */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? `${hours}h ${remainingMinutes}m`
    : `${hours}h`;
}
