/**
 * Session metadata persistence.
 *
 * Saves/loads session metadata to ~/.happyclaw/sessions.json so that
 * sessions can be reconciled on startup (orphan cleanup, live reconnect).
 *
 * File format: JSON array of PersistedSession objects.
 * All writes are atomic (write to temp, then rename) to prevent corruption.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { PersistedSession } from './types/index.js';

const DATA_DIR = path.join(os.homedir(), '.happyclaw');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

export class SessionPersistence {
  private readonly dataDir: string;
  private readonly filePath: string;

  constructor(options?: { dataDir?: string }) {
    this.dataDir = options?.dataDir ?? DATA_DIR;
    this.filePath = path.join(this.dataDir, 'sessions.json');
  }

  /** Ensure the data directory exists */
  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  /** Load all persisted sessions from disk */
  async load(): Promise<PersistedSession[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as PersistedSession[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /** Save all sessions atomically (write temp + rename) */
  async save(sessions: PersistedSession[]): Promise<void> {
    await this.ensureDir();
    const json = JSON.stringify(sessions, null, 2) + '\n';
    const tmpPath = this.filePath + '.tmp';
    await fs.writeFile(tmpPath, json, 'utf-8');
    await fs.rename(tmpPath, this.filePath);
  }

  /** Add a session to the persisted list */
  async add(session: PersistedSession): Promise<void> {
    const sessions = await this.load();
    // Replace if already exists (same id), otherwise append
    const idx = sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = session;
    } else {
      sessions.push(session);
    }
    await this.save(sessions);
  }

  /** Update a specific session's fields */
  async update(
    sessionId: string,
    updates: Partial<PersistedSession>,
  ): Promise<void> {
    const sessions = await this.load();
    const idx = sessions.findIndex((s) => s.id === sessionId);
    if (idx >= 0) {
      sessions[idx] = { ...sessions[idx], ...updates };
      await this.save(sessions);
    }
  }

  /** Remove a session from the persisted list */
  async remove(sessionId: string): Promise<void> {
    const sessions = await this.load();
    const filtered = sessions.filter((s) => s.id !== sessionId);
    if (filtered.length !== sessions.length) {
      await this.save(filtered);
    }
  }

  /** Remove multiple sessions by ID */
  async removeMany(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const idSet = new Set(sessionIds);
    const sessions = await this.load();
    const filtered = sessions.filter((s) => !idSet.has(s.id));
    if (filtered.length !== sessions.length) {
      await this.save(filtered);
    }
  }

  /** Get the persistence file path (for testing/debugging) */
  get path(): string {
    return this.filePath;
  }
}
