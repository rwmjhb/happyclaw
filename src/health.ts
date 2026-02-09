/**
 * HealthChecker — periodic process health monitoring for sessions.
 *
 * Runs a configurable heartbeat that checks whether each session's
 * underlying process (PID) is still alive. Dead sessions are
 * automatically cleaned up and an error event is emitted.
 *
 * Reference: Phase 4 — process health checking
 */

import type { SessionManager } from './session-manager.js';
import type { SessionEvent } from './types/index.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface HealthCheckerOptions {
  /** Heartbeat interval in milliseconds (default: 30_000) */
  intervalMs?: number;
}

// ---------------------------------------------------------------------------
// HealthChecker
// ---------------------------------------------------------------------------

export class HealthChecker {
  private readonly manager: SessionManager;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(manager: SessionManager, options: HealthCheckerOptions = {}) {
    this.manager = manager;
    this.intervalMs = options.intervalMs ?? 30_000;
  }

  /** Start the periodic heartbeat. No-op if already running. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkAll();
    }, this.intervalMs);
    // Allow the process to exit even if the timer is still running
    this.timer.unref();
  }

  /** Stop the periodic heartbeat. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Whether the heartbeat timer is currently active. */
  get running(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Check a single session's process health.
   *
   * Returns true if the process is alive, false if dead (and cleaned up).
   */
  async checkSession(sessionId: string): Promise<boolean> {
    const session = this.manager.get(sessionId);
    if (isProcessAlive(session.pid)) {
      return true;
    }

    // Process is dead — emit error event and clean up
    this.manager.emit('event', {
      type: 'error',
      severity: 'urgent',
      sessionId,
      timestamp: Date.now(),
      summary: `Process ${session.pid} (${session.provider}) is no longer running. Cleaning up session.`,
    } satisfies SessionEvent);

    await this.manager.stop(sessionId).catch(() => {
      // stop() may throw if the process is already gone; that's expected
    });

    return false;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Check all active sessions. */
  private async checkAll(): Promise<void> {
    const sessions = this.manager.list();
    for (const session of sessions) {
      try {
        await this.checkSession(session.id);
      } catch {
        // Session may have been removed by a concurrent operation; skip
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a process is alive using signal 0. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
