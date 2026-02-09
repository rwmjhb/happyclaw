/**
 * Slash command interception for session input.
 *
 * Parses user input before forwarding to session.send.
 * Recognized commands:
 * - /clear: reset session (clear session ID, start fresh)
 * - /compact: compress conversation context
 * - /cost: show cost info from session's last result
 *
 * Unrecognized commands and regular input are forwarded to the provider.
 *
 * Reference: docs/technical-proposal.md §4.1 (Slash command handling)
 */

import type { ProviderSession } from './types/index.js';

// ---------------------------------------------------------------------------
// Command result
// ---------------------------------------------------------------------------

export interface CommandResult {
  /** Whether the input was handled as a slash command */
  handled: boolean;
  /** Human-readable response to return to the user (if handled) */
  response?: string;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

type CommandHandler = (
  session: ProviderSession,
  args: string,
) => Promise<CommandResult>;

/**
 * /clear — Reset the session.
 *
 * Sends a special clear signal. The provider's send() implementation
 * should interpret this as a session reset (e.g., SDK clears session_id,
 * PTY sends /clear to the CLI).
 */
async function handleClear(
  session: ProviderSession,
  _args: string,
): Promise<CommandResult> {
  await session.send('/clear');
  return {
    handled: true,
    response: `Session ${session.id} cleared. A new conversation will start on the next message.`,
  };
}

/**
 * /compact — Compress conversation context.
 *
 * Forwards /compact to the session so the provider can handle
 * context compaction (SDK sends as user message, CLI processes natively).
 */
async function handleCompact(
  session: ProviderSession,
  args: string,
): Promise<CommandResult> {
  const compactInput = args ? `/compact ${args}` : '/compact';
  await session.send(compactInput);
  return {
    handled: true,
    response: `Compaction requested for session ${session.id}.`,
  };
}

/**
 * /cost — Show cost information.
 *
 * Reads the session's recent messages looking for result-type messages
 * that may contain cost info. This is a read-only command.
 */
async function handleCost(
  session: ProviderSession,
  _args: string,
): Promise<CommandResult> {
  // Read the last few messages looking for cost/result info
  const { messages } = await session.read({ limit: 20 });

  // Look for the most recent result message (contains cost info)
  const resultMessages = messages.filter((m) => m.type === 'result');
  const lastResult = resultMessages[resultMessages.length - 1];

  if (lastResult) {
    return {
      handled: true,
      response: `Session ${session.id} cost info:\n${lastResult.content}`,
    };
  }

  return {
    handled: true,
    response: `No cost information available for session ${session.id}. Cost data appears after the AI completes a response.`,
  };
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

const commands: Record<string, CommandHandler> = {
  '/clear': handleClear,
  '/compact': handleCompact,
  '/cost': handleCost,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse and execute a slash command if the input matches one.
 *
 * Returns { handled: true, response } if a command was executed,
 * or { handled: false } if the input should be forwarded to the session.
 */
export async function parseCommand(
  session: ProviderSession,
  input: string,
): Promise<CommandResult> {
  const trimmed = input.trim();

  // Must start with /
  if (!trimmed.startsWith('/')) {
    return { handled: false };
  }

  // Extract command name and arguments
  const spaceIndex = trimmed.indexOf(' ');
  const commandName = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const args = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();

  const handler = commands[commandName.toLowerCase()];
  if (!handler) {
    return { handled: false }; // Unknown command, forward to provider
  }

  return handler(session, args);
}

/**
 * List all registered slash commands with descriptions.
 */
export function listCommands(): Array<{ command: string; description: string }> {
  return [
    { command: '/clear', description: 'Reset the session (start fresh conversation)' },
    { command: '/compact', description: 'Compress conversation context to save tokens' },
    { command: '/cost', description: 'Show cost information for the session' },
  ];
}
