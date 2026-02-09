import type { SessionACL as ISessionACL } from '../types/index.js';

/**
 * SessionACL — owner-based access control for sessions.
 *
 * Binds each session to an owner (OpenClaw userId) at creation time.
 * All subsequent operations on that session require the caller's userId
 * to match the owner. This MUST happen before any event forwarding
 * to prevent session hijacking.
 */
export class SessionACL implements ISessionACL {
  private owners = new Map<string, string>();

  /**
   * Bind a session to an owner. Must be called exactly once per session,
   * immediately after spawn/resume and BEFORE forwarding any events.
   * Throws if the session already has an owner.
   */
  setOwner(sessionId: string, userId: string): void {
    if (this.owners.has(sessionId)) {
      throw new Error(
        `Session ${sessionId} already has an owner. Cannot reassign.`,
      );
    }
    this.owners.set(sessionId, userId);
  }

  /**
   * Check whether a user can access a session.
   * Returns false if session has no owner (defensive — treat as denied).
   */
  canAccess(userId: string, sessionId: string): boolean {
    const owner = this.owners.get(sessionId);
    return owner !== undefined && owner === userId;
  }

  /**
   * Assert that a user owns a session. Throws a descriptive error if not.
   * Use this in tool handlers where access denial should abort the operation.
   */
  assertOwner(userId: string, sessionId: string): void {
    if (!this.owners.has(sessionId)) {
      throw new Error(`Session ${sessionId} not found in ACL.`);
    }
    if (!this.canAccess(userId, sessionId)) {
      throw new Error(
        `User ${userId} does not own session ${sessionId}. Access denied.`,
      );
    }
  }

  /**
   * Remove a session from the ACL. Call this when a session is stopped/destroyed.
   */
  removeSession(sessionId: string): void {
    this.owners.delete(sessionId);
  }

  /**
   * Get the owner of a session, or undefined if not tracked.
   */
  getOwner(sessionId: string): string | undefined {
    return this.owners.get(sessionId);
  }
}
