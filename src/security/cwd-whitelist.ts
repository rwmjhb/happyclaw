import path from 'node:path';

/**
 * CwdWhitelist — restricts which directories can be used as session cwd.
 *
 * Prevents AI sessions from operating in arbitrary filesystem locations.
 * All paths are resolved to absolute form to prevent path traversal attacks
 * (e.g., "/allowed/../etc" normalizes to "/etc" and gets rejected).
 *
 * An empty whitelist means no restrictions (all paths allowed).
 */
export class CwdWhitelist {
  private readonly allowedDirs: string[];

  constructor(allowedDirs: string[]) {
    this.allowedDirs = allowedDirs.map((d) => path.resolve(d));
  }

  /**
   * Check whether a cwd path is allowed.
   * Returns true if:
   * - The whitelist is empty (no restrictions), OR
   * - The resolved path starts with one of the allowed directories.
   */
  check(cwd: string): boolean {
    if (this.allowedDirs.length === 0) {
      return true;
    }
    const resolved = path.resolve(cwd);
    return this.allowedDirs.some(
      (allowed) =>
        resolved === allowed || resolved.startsWith(allowed + path.sep),
    );
  }

  /**
   * Assert that a cwd is allowed. Throws if denied.
   */
  assertAllowed(cwd: string): void {
    if (!this.check(cwd)) {
      const resolved = path.resolve(cwd);
      throw new Error(
        `cwd not in whitelist: ${resolved}. Allowed: [${this.allowedDirs.join(', ')}]`,
      );
    }
  }
}
