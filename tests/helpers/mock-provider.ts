/**
 * Mock implementations of SessionProvider and ProviderSession for testing.
 */
import { vi } from 'vitest';
import type {
  SessionProvider,
  ProviderSession,
  SpawnOptions,
  SessionMode,
  ReadResult,
  EventHandler,
  MessageHandler,
  SessionMessage,
  SessionEvent,
} from '../../src/types/index.js';

/**
 * Create a mock ProviderSession with all methods stubbed via vi.fn().
 */
export function createMockSession(
  overrides: Partial<ProviderSession> & { id: string } = { id: 'mock-session-1' },
): ProviderSession & {
  _eventHandlers: EventHandler[];
  _messageHandlers: MessageHandler[];
  _emitEvent: (event: SessionEvent) => void;
  _emitMessage: (message: SessionMessage) => void;
} {
  const eventHandlers: EventHandler[] = [];
  const messageHandlers: MessageHandler[] = [];

  const session: ProviderSession & {
    _eventHandlers: EventHandler[];
    _messageHandlers: MessageHandler[];
    _emitEvent: (event: SessionEvent) => void;
    _emitMessage: (message: SessionMessage) => void;
  } = {
    id: overrides.id ?? 'mock-session-1',
    provider: overrides.provider ?? 'claude',
    cwd: overrides.cwd ?? '/tmp/test-project',
    pid: overrides.pid ?? 12345,
    mode: overrides.mode ?? 'remote',

    send: vi.fn<(input: string) => Promise<void>>().mockResolvedValue(undefined),
    read: vi.fn<(opts?: { cursor?: string; limit?: number }) => Promise<ReadResult>>().mockResolvedValue({
      messages: [],
      nextCursor: 'cursor-0',
    }),
    switchMode: vi.fn<(target: SessionMode) => Promise<void>>().mockResolvedValue(undefined),
    respondToPermission: vi.fn<(requestId: string, approved: boolean) => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<(force?: boolean) => Promise<void>>().mockResolvedValue(undefined),
    onEvent: vi.fn((handler: EventHandler) => {
      eventHandlers.push(handler);
    }),
    onMessage: vi.fn((handler: MessageHandler) => {
      messageHandlers.push(handler);
    }),

    _eventHandlers: eventHandlers,
    _messageHandlers: messageHandlers,
    _emitEvent(event: SessionEvent) {
      for (const handler of eventHandlers) handler(event);
    },
    _emitMessage(message: SessionMessage) {
      for (const handler of messageHandlers) handler(message);
    },
  };

  return session;
}

/**
 * Create a mock SessionProvider that returns pre-configured mock sessions.
 */
export function createMockProvider(
  name: string = 'claude',
  sessions: Map<string, ProviderSession> = new Map(),
): SessionProvider & {
  _nextSession: ReturnType<typeof createMockSession> | null;
  _setNextSession: (session: ReturnType<typeof createMockSession>) => void;
} {
  let nextSession: ReturnType<typeof createMockSession> | null = null;

  const provider: SessionProvider & {
    _nextSession: ReturnType<typeof createMockSession> | null;
    _setNextSession: (session: ReturnType<typeof createMockSession>) => void;
  } = {
    name,
    supportedModes: ['local', 'remote'] as const,

    spawn: vi.fn(async (_options: SpawnOptions): Promise<ProviderSession> => {
      if (nextSession) {
        const s = nextSession;
        nextSession = null;
        return s;
      }
      return createMockSession({ id: `session-${Date.now()}` });
    }),

    resume: vi.fn(async (sessionId: string, _options: SpawnOptions): Promise<ProviderSession> => {
      const existing = sessions.get(sessionId);
      if (existing) return existing;
      if (nextSession) {
        const s = nextSession;
        nextSession = null;
        return s;
      }
      return createMockSession({ id: sessionId });
    }),

    _nextSession: nextSession,
    _setNextSession(session: ReturnType<typeof createMockSession>) {
      nextSession = session;
    },
  };

  return provider;
}
