import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { SessionPersistence } from '../../src/persistence.js';
import type { PersistedSession } from '../../src/types/index.js';

describe('SessionPersistence', () => {
  let tmpDir: string;
  let persistence: SessionPersistence;

  const makeSession = (overrides: Partial<PersistedSession> = {}): PersistedSession => ({
    id: overrides.id ?? 'session-1',
    provider: overrides.provider ?? 'claude',
    cwd: overrides.cwd ?? '/tmp/project',
    pid: overrides.pid ?? 12345,
    ownerId: overrides.ownerId ?? 'user-1',
    mode: overrides.mode ?? 'remote',
    createdAt: overrides.createdAt ?? Date.now(),
  });

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `happyclaw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    persistence = new SessionPersistence({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('returns empty array when file does not exist', async () => {
      const result = await persistence.load();
      expect(result).toEqual([]);
    });

    it('returns empty array for invalid JSON (non-array)', async () => {
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'sessions.json'), '"not-an-array"');

      const result = await persistence.load();
      expect(result).toEqual([]);
    });

    it('throws on corrupt JSON (parse error)', async () => {
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'sessions.json'), '{broken json!!!');

      await expect(persistence.load()).rejects.toThrow();
    });

    it('loads saved sessions correctly', async () => {
      const sessions = [makeSession({ id: 'a' }), makeSession({ id: 'b' })];
      await persistence.save(sessions);

      const loaded = await persistence.load();
      expect(loaded).toHaveLength(2);
      expect(loaded[0].id).toBe('a');
      expect(loaded[1].id).toBe('b');
    });
  });

  describe('save', () => {
    it('creates data directory if missing', async () => {
      await persistence.save([makeSession()]);

      const stat = await fs.stat(tmpDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('writes valid JSON with trailing newline', async () => {
      await persistence.save([makeSession()]);

      const raw = await fs.readFile(path.join(tmpDir, 'sessions.json'), 'utf-8');
      expect(raw.endsWith('\n')).toBe(true);
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('overwrites previous content', async () => {
      await persistence.save([makeSession({ id: 'first' })]);
      await persistence.save([makeSession({ id: 'second' })]);

      const loaded = await persistence.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('second');
    });

    it('atomic write uses temp file + rename', async () => {
      // After save, there should be no .tmp file left
      await persistence.save([makeSession()]);

      const files = await fs.readdir(tmpDir);
      expect(files).not.toContain('sessions.json.tmp');
      expect(files).toContain('sessions.json');
    });
  });

  describe('add', () => {
    it('appends to empty file', async () => {
      await persistence.add(makeSession({ id: 'new' }));

      const loaded = await persistence.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('new');
    });

    it('replaces session with same id', async () => {
      await persistence.add(makeSession({ id: 'dup', pid: 100 }));
      await persistence.add(makeSession({ id: 'dup', pid: 200 }));

      const loaded = await persistence.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].pid).toBe(200);
    });

    it('appends session with different id', async () => {
      await persistence.add(makeSession({ id: 'a' }));
      await persistence.add(makeSession({ id: 'b' }));

      const loaded = await persistence.load();
      expect(loaded).toHaveLength(2);
    });
  });

  describe('update', () => {
    it('updates existing session fields', async () => {
      await persistence.add(makeSession({ id: 'upd', mode: 'remote' }));
      await persistence.update('upd', { mode: 'local', pid: 99999 });

      const loaded = await persistence.load();
      expect(loaded[0].mode).toBe('local');
      expect(loaded[0].pid).toBe(99999);
    });

    it('no-ops when session id not found', async () => {
      await persistence.add(makeSession({ id: 'exists' }));
      await persistence.update('does-not-exist', { mode: 'local' });

      const loaded = await persistence.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('exists');
    });
  });

  describe('remove', () => {
    it('removes session by id', async () => {
      await persistence.add(makeSession({ id: 'a' }));
      await persistence.add(makeSession({ id: 'b' }));
      await persistence.remove('a');

      const loaded = await persistence.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('b');
    });

    it('no-ops when session id not found', async () => {
      await persistence.add(makeSession({ id: 'a' }));
      await persistence.remove('nonexistent');

      const loaded = await persistence.load();
      expect(loaded).toHaveLength(1);
    });
  });

  describe('removeMany', () => {
    it('removes multiple sessions by id', async () => {
      await persistence.save([
        makeSession({ id: 'a' }),
        makeSession({ id: 'b' }),
        makeSession({ id: 'c' }),
      ]);

      await persistence.removeMany(['a', 'c']);

      const loaded = await persistence.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('b');
    });

    it('no-ops for empty array', async () => {
      await persistence.save([makeSession({ id: 'a' })]);
      await persistence.removeMany([]);

      const loaded = await persistence.load();
      expect(loaded).toHaveLength(1);
    });
  });

  describe('path', () => {
    it('returns the persistence file path', () => {
      expect(persistence.path).toBe(path.join(tmpDir, 'sessions.json'));
    });
  });

  describe('default data directory', () => {
    it('defaults to ~/.happyclaw', () => {
      const defaultPersistence = new SessionPersistence();
      expect(defaultPersistence.path).toBe(
        path.join(os.homedir(), '.happyclaw', 'sessions.json'),
      );
    });
  });
});
