/**
 * ParserRuleSet — configurable rules for parsing PTY terminal output.
 *
 * Each CLI tool (Gemini, etc.) has different output patterns.
 * ParserRuleSet provides a pluggable interface for:
 * - Parsing raw terminal text into structured SessionMessage
 * - Detecting events (permission requests, errors, completion, etc.)
 * - Filtering dangerous input before sending to the PTY
 */

import type {
  SessionMessage,
  SessionEvent,
  SessionMessageType,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// ParserRuleSet interface
// ---------------------------------------------------------------------------

export interface ParserRuleSet {
  /** Parse cleaned (ANSI-stripped) terminal text into a SessionMessage, or null if not parseable */
  parse(clean: string): SessionMessage | null;

  /** Detect events from cleaned terminal text (permission prompts, errors, etc.) */
  detectEvent(clean: string, sessionId: string): SessionEvent | null;

  /** Filter user input before writing to PTY. Returns null to block the input. */
  filterInput(input: string): string | null;
}

// ---------------------------------------------------------------------------
// GeminiParserRules — parser rules for Gemini CLI
// ---------------------------------------------------------------------------

/**
 * Pattern-based parser for Gemini CLI output.
 *
 * Gemini CLI output patterns (approximate, subject to CLI version changes):
 * - Code blocks: ``` delimited
 * - Tool use: lines starting with "Using tool:" or similar
 * - Errors: lines starting with "Error:" or containing error indicators
 * - Thinking: lines like "Thinking..." or spinner patterns
 * - Permission prompts: "Allow?" / "Do you want to proceed?" patterns
 */
export class GeminiParserRules implements ParserRuleSet {
  private inCodeBlock = false;
  private codeBlockLang = '';
  private codeBlockBuffer = '';

  // Patterns for different output types
  private static readonly PATTERNS = {
    codeBlockStart: /^```(\w*)$/m,
    codeBlockEnd: /^```$/m,
    toolUse: /^(?:Using tool|Calling|Executing|Running):\s*(.+)/i,
    toolResult: /^(?:Tool result|Result|Output):\s*(.*)/i,
    error: /^(?:Error|ERROR|Failed|FAILED):\s*(.*)/i,
    thinking: /^(?:Thinking|Processing|Analyzing)\.\.\./i,
    permissionPrompt:
      /(?:Allow|Proceed|Continue|Do you want to)\?|(?:\(y\/n\)|\[Y\/n\]|\[yes\/no\])/i,
    waitingForInput: /^(?:>|>>>|\$)\s*$/,
  };

  // Dangerous input patterns to block
  private static readonly BLOCKED_INPUT = [
    /\x03/, // Ctrl+C
    /\x04/, // Ctrl+D (EOF)
    /\x1a/, // Ctrl+Z (suspend)
    /\x1b/, // ESC sequences that could manipulate terminal
  ];

  parse(clean: string): SessionMessage | null {
    const trimmed = clean.trim();
    if (!trimmed) return null;

    // Handle code block state
    if (this.inCodeBlock) {
      if (GeminiParserRules.PATTERNS.codeBlockEnd.test(trimmed)) {
        this.inCodeBlock = false;
        const msg: SessionMessage = {
          type: 'code',
          content: this.codeBlockBuffer,
          timestamp: Date.now(),
          metadata: {
            language: this.codeBlockLang || undefined,
          },
        };
        this.codeBlockBuffer = '';
        this.codeBlockLang = '';
        return msg;
      }
      this.codeBlockBuffer += (this.codeBlockBuffer ? '\n' : '') + trimmed;
      return null; // Accumulating code block
    }

    // Check for code block start
    const codeStart = trimmed.match(GeminiParserRules.PATTERNS.codeBlockStart);
    if (codeStart) {
      this.inCodeBlock = true;
      this.codeBlockLang = codeStart[1] ?? '';
      this.codeBlockBuffer = '';
      return null; // Will emit when block ends
    }

    // Match against patterns
    const type = this.classifyLine(trimmed);
    if (!type) return null;

    return {
      type: type.type,
      content: type.content,
      timestamp: Date.now(),
      metadata: type.metadata,
    };
  }

  detectEvent(clean: string, sessionId: string): SessionEvent | null {
    const trimmed = clean.trim();
    if (!trimmed) return null;

    // Permission prompt detection
    if (GeminiParserRules.PATTERNS.permissionPrompt.test(trimmed)) {
      return {
        type: 'permission_request',
        severity: 'urgent',
        summary: `Gemini is asking for permission: ${trimmed.substring(0, 100)}`,
        sessionId,
        timestamp: Date.now(),
        // PTY mode: no structured requestId, use timestamp-based ID
        permissionDetail: {
          requestId: `pty-${Date.now()}`,
          toolName: 'unknown',
          input: trimmed,
        },
      };
    }

    // Error detection
    if (GeminiParserRules.PATTERNS.error.test(trimmed)) {
      return {
        type: 'error',
        severity: 'warning',
        summary: trimmed.substring(0, 200),
        sessionId,
        timestamp: Date.now(),
      };
    }

    // Waiting for input
    if (GeminiParserRules.PATTERNS.waitingForInput.test(trimmed)) {
      return {
        type: 'waiting_for_input',
        severity: 'info',
        summary: 'Gemini is waiting for input',
        sessionId,
        timestamp: Date.now(),
      };
    }

    return null;
  }

  filterInput(input: string): string | null {
    for (const pattern of GeminiParserRules.BLOCKED_INPUT) {
      if (pattern.test(input)) {
        return null; // Block dangerous control characters
      }
    }
    return input;
  }

  private classifyLine(
    line: string,
  ): { type: SessionMessageType; content: string; metadata?: SessionMessage['metadata'] } | null {
    let match: RegExpMatchArray | null;

    match = line.match(GeminiParserRules.PATTERNS.toolUse);
    if (match) {
      return { type: 'tool_use', content: match[1] ?? line, metadata: { tool: match[1] } };
    }

    match = line.match(GeminiParserRules.PATTERNS.toolResult);
    if (match) {
      return { type: 'tool_result', content: match[1] ?? line };
    }

    match = line.match(GeminiParserRules.PATTERNS.error);
    if (match) {
      return { type: 'error', content: match[1] ?? line };
    }

    if (GeminiParserRules.PATTERNS.thinking.test(line)) {
      return { type: 'thinking', content: line };
    }

    // Default: treat as text
    return { type: 'text', content: line };
  }
}
