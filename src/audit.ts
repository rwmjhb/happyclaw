/**
 * AuditLogger — append-only JSON-lines audit log for session operations.
 *
 * Records all session.* tool invocations for security auditing and
 * debugging. Each entry is a single JSON line appended to a log file.
 *
 * Reference: Phase 4 — audit logging
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  timestamp: number;
  userId: string;
  action: string;
  sessionId: string;
  details?: Record<string, unknown>;
}

export interface AuditLoggerOptions {
  /** Directory for the audit log file (default: ~/.happyclaw) */
  logDir?: string;
}

export interface AuditReadOptions {
  /** Maximum number of entries to return (most recent first) */
  limit?: number;
  /** Only return entries after this timestamp */
  since?: number;
}

// ---------------------------------------------------------------------------
// AuditLogger
// ---------------------------------------------------------------------------

export class AuditLogger {
  private readonly logPath: string;
  private dirCreated = false;

  constructor(options: AuditLoggerOptions = {}) {
    const logDir = options.logDir ?? path.join(os.homedir(), '.happyclaw');
    this.logPath = path.join(logDir, 'audit.log');
  }

  /** Append a single audit entry as a JSON line. */
  async log(entry: AuditEntry): Promise<void> {
    await this.ensureDir();
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(this.logPath, line, 'utf-8');
  }

  /**
   * Read recent audit entries.
   *
   * Returns entries in reverse chronological order (newest first).
   * Optionally filter by `since` timestamp and limit result count.
   */
  async readLog(options?: AuditReadOptions): Promise<AuditEntry[]> {
    let content: string;
    try {
      content = await fs.readFile(this.logPath, 'utf-8');
    } catch {
      return []; // Log file doesn't exist yet
    }

    const lines = content.trim().split('\n').filter(Boolean);
    let entries: AuditEntry[] = [];

    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Skip malformed lines
      }
    }

    if (options?.since !== undefined) {
      entries = entries.filter((e) => e.timestamp >= options.since!);
    }

    // Newest first
    entries.reverse();

    if (options?.limit !== undefined) {
      entries = entries.slice(0, options.limit);
    }

    return entries;
  }

  /** Get the resolved log file path. */
  get filePath(): string {
    return this.logPath;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async ensureDir(): Promise<void> {
    if (this.dirCreated) return;
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    this.dirCreated = true;
  }
}
