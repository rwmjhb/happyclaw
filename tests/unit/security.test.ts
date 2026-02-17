import { describe, it, expect, beforeEach } from 'vitest';
import { SessionACL } from '../../src/security/acl.js';
import { CwdWhitelist } from '../../src/security/cwd-whitelist.js';

describe('SessionACL', () => {
  let acl: SessionACL;

  beforeEach(() => {
    acl = new SessionACL();
  });

  describe('setOwner', () => {
    it('binds a session to an owner', () => {
      acl.setOwner('session-1', 'user-a');
      expect(acl.getOwner('session-1')).toBe('user-a');
    });

    it('throws when reassigning owner to an already-owned session', () => {
      acl.setOwner('session-1', 'user-a');
      expect(() => acl.setOwner('session-1', 'user-b')).toThrow(
        'already has an owner',
      );
    });

    it('throws when reassigning the same owner', () => {
      acl.setOwner('session-1', 'user-a');
      expect(() => acl.setOwner('session-1', 'user-a')).toThrow(
        'already has an owner',
      );
    });
  });

  describe('canAccess', () => {
    it('returns true when user is the owner', () => {
      acl.setOwner('session-1', 'user-a');
      expect(acl.canAccess('user-a', 'session-1')).toBe(true);
    });

    it('returns false when user is not the owner', () => {
      acl.setOwner('session-1', 'user-a');
      expect(acl.canAccess('user-b', 'session-1')).toBe(false);
    });

    it('returns false for sessions with no owner (defensive)', () => {
      expect(acl.canAccess('user-a', 'nonexistent')).toBe(false);
    });
  });

  describe('assertOwner', () => {
    it('does not throw when user is the owner', () => {
      acl.setOwner('session-1', 'user-a');
      expect(() => acl.assertOwner('user-a', 'session-1')).not.toThrow();
    });

    it('throws "not found in ACL" for unknown sessions', () => {
      expect(() => acl.assertOwner('user-a', 'unknown')).toThrow(
        'not found in ACL',
      );
    });

    it('throws "Access denied" when user does not own the session', () => {
      acl.setOwner('session-1', 'user-a');
      expect(() => acl.assertOwner('user-b', 'session-1')).toThrow(
        'Access denied',
      );
    });
  });

  describe('removeSession', () => {
    it('removes ownership record', () => {
      acl.setOwner('session-1', 'user-a');
      acl.removeSession('session-1');
      expect(acl.getOwner('session-1')).toBeUndefined();
    });

    it('allows re-binding after removal', () => {
      acl.setOwner('session-1', 'user-a');
      acl.removeSession('session-1');
      acl.setOwner('session-1', 'user-b');
      expect(acl.getOwner('session-1')).toBe('user-b');
    });

    it('is a no-op for non-existent sessions', () => {
      expect(() => acl.removeSession('nonexistent')).not.toThrow();
    });
  });

  describe('getOwner', () => {
    it('returns undefined for sessions with no owner', () => {
      expect(acl.getOwner('nonexistent')).toBeUndefined();
    });

    it('returns the owner userId', () => {
      acl.setOwner('session-1', 'user-a');
      expect(acl.getOwner('session-1')).toBe('user-a');
    });
  });
});

describe('CwdWhitelist', () => {
  describe('allowed path', () => {
    it('allows paths within whitelisted directories', () => {
      const whitelist = new CwdWhitelist(['/home/alice/projects']);
      expect(whitelist.check('/home/alice/projects/my-app')).toBe(true);
    });

    it('allows the exact whitelisted directory', () => {
      const whitelist = new CwdWhitelist(['/home/alice/projects']);
      expect(whitelist.check('/home/alice/projects')).toBe(true);
    });

    it('allows deeply nested paths', () => {
      const whitelist = new CwdWhitelist(['/home/alice/projects']);
      expect(
        whitelist.check('/home/alice/projects/app/src/components'),
      ).toBe(true);
    });
  });

  describe('denied path', () => {
    it('denies paths outside whitelisted directories', () => {
      const whitelist = new CwdWhitelist(['/home/alice/projects']);
      expect(whitelist.check('/etc/passwd')).toBe(false);
    });

    it('denies paths that partially match (prefix attack)', () => {
      const whitelist = new CwdWhitelist(['/home/alice/projects']);
      // "/home/alice/projects-evil" should NOT be allowed
      expect(whitelist.check('/home/alice/projects-evil')).toBe(false);
    });

    it('denies paths in parent directories', () => {
      const whitelist = new CwdWhitelist(['/home/alice/projects']);
      expect(whitelist.check('/home/alice')).toBe(false);
    });
  });

  describe('empty whitelist allows all', () => {
    it('allows any path when whitelist is empty', () => {
      const whitelist = new CwdWhitelist([]);
      expect(whitelist.check('/etc/passwd')).toBe(true);
      expect(whitelist.check('/tmp')).toBe(true);
      expect(whitelist.check('/home/alice/projects')).toBe(true);
    });
  });

  describe('path normalization', () => {
    it('resolves relative paths', () => {
      const whitelist = new CwdWhitelist(['/home/alice/projects']);
      // path.resolve will resolve this relative to process.cwd() — the key
      // is that '../etc' with a base of /home/alice/projects normalizes correctly
      // We just test that the whitelist itself normalizes its entries
      expect(whitelist.check('/home/alice/projects/app/../app/src')).toBe(
        true,
      );
    });

    it('handles path traversal attacks', () => {
      const whitelist = new CwdWhitelist(['/home/alice/projects']);
      // /home/alice/projects/../.ssh normalizes to /home/alice/.ssh
      expect(whitelist.check('/home/alice/projects/../.ssh')).toBe(false);
    });
  });

  describe('assertAllowed', () => {
    it('does not throw for allowed paths', () => {
      const whitelist = new CwdWhitelist(['/home/alice/projects']);
      expect(() =>
        whitelist.assertAllowed('/home/alice/projects/my-app'),
      ).not.toThrow();
    });

    it('throws for denied paths with descriptive message', () => {
      const whitelist = new CwdWhitelist(['/home/alice/projects']);
      expect(() => whitelist.assertAllowed('/etc/passwd')).toThrow(
        'cwd not in whitelist',
      );
    });
  });

  describe('multiple whitelist entries', () => {
    it('allows paths matching any entry', () => {
      const whitelist = new CwdWhitelist([
        '/home/alice/projects',
        '/tmp/sandboxes',
      ]);
      expect(whitelist.check('/home/alice/projects/app')).toBe(true);
      expect(whitelist.check('/tmp/sandboxes/test')).toBe(true);
      expect(whitelist.check('/var/log')).toBe(false);
    });
  });
});
