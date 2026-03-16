# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HappyClaw is an **OpenClaw Plugin** that bridges AI CLI sessions (Claude Code, Codex, Gemini) into OpenClaw's tool system, enabling remote control from Telegram or Discord. It uses an SDK-first approach with PTY fallback.

**Primary language**: TypeScript (ESM, strict mode)
**Runtime**: Node.js
**Package manager**: pnpm

## Commands

```bash
# Install dependencies
pnpm install

# Build (TypeScript → dist/)
pnpm build

# Type-check without emitting
pnpm typecheck

# Run all tests
pnpm test

# Run a single test file
npx vitest run tests/unit/session-manager.test.ts

# Run tests matching a pattern
npx vitest run -t "spawn"

# Watch mode
pnpm test:watch

# Coverage (thresholds: 70% statements/functions/lines, 60% branches)
pnpm test:coverage

# Install plugin into OpenClaw
openclaw plugins install --link /path/to/happyclaw
```

## Architecture

### Provider Abstraction

Three providers implement the `SessionProvider` interface (`src/types/index.ts`):

| Provider | File | Mode | How it works |
|----------|------|------|-------------|
| `ClaudeSDKProvider` | `src/providers/claude-sdk.ts` | SDK `query()` (remote) / CLI `spawn` with stdio inherit (local) | Uses `@anthropic-ai/claude-agent-sdk`. Remote mode streams structured JSON; local mode gives native terminal UX. |
| `CodexMCPProvider` | `src/providers/codex-mcp.ts` | MCP Client → `codex mcp-server` | Two-tool pattern: `codex` (start) + `codex-reply` (continue). State machine: `connecting→working→idle→stopped`. |
| `GenericPTYProvider` | `src/providers/generic-pty.ts` | node-pty + @xterm/headless | For CLIs without SDKs (e.g., Gemini). Parses terminal output via configurable `ParserRuleSet`. |

### Core Components

- **`SessionManager`** (`src/session-manager.ts`) — Central session lifecycle: spawn, resume, read (cursor-paginated), switchMode (state machine: `running→draining→switching→running`), stop. Enforces ACL ownership, cwd whitelist, session limits. Emits `message`, `event`, `sessionEnd`, `stateTransition`.
- **`EventBus`** (`src/event-bus.ts`) — Debounced event routing with priority queue (permission_request > error > task_complete > info).
- **`TelegramPushAdapter`** (`src/push/telegram-push-adapter.ts`) — Zero-token push: streams Claude output directly to Telegram Bot API via debounced batches. Subscribes to SessionManager messages + EventBus events.
- **`AsyncQueue<T>`** (`src/types/index.ts`) — Push-based async iterable for feeding `SDKUserMessage` into SDK `query()`. Must push initialPrompt BEFORE starting the query to avoid deadlock.

### Plugin Entry Points

- **`src/openclaw-plugin.ts`** — OpenClaw plugin entry. Registers 8 tools (`session_list/spawn/resume/send/read/respond/switch/stop/summary`), slash commands, `before_tool_call` hook (blocks `exec("claude/codex ...")`), and `gateway_stop` cleanup. Uses factory pattern for per-agent CallerContext.
- **`src/plugin.ts`** — Internal tool definitions (shared logic, used by openclaw-plugin).
- **`src/openclaw-commands.ts`** — `/sessions_*` slash commands for direct TG/Discord control (zero token cost).

### Security Layer

- **`SessionACL`** (`src/security/acl.ts`) — Owner binding per session. Owner set BEFORE event forwarding starts. Format: "User X does not own session Y. Access denied."
- **`CwdWhitelist`** (`src/security/cwd-whitelist.ts`) — Restricts working directories.
- **`redactSensitive`** (`src/redact.ts`) — Strips secrets from message output.

### Supporting Modules

- `src/health.ts` — Periodic health checks on active sessions
- `src/audit.ts` — Audit logging for all tool operations
- `src/summary.ts` — Session summarization (message counts, tools used, files modified)
- `src/commands.ts` — Slash command parsing (/clear, /compact, /cost)
- `src/persistence.ts` — Session metadata persistence (~/.happyclaw/sessions.json)
- `src/formatters/telegram.ts` — Telegram message formatting with noise filtering (SILENT_TOOLS, CodexBash whitelist, CodexPatch filter)
- `src/formatters/discord.ts` — Discord formatting + embed support (no noise filtering yet)

## Key SDK Gotchas

- `query({ prompt: asyncIterable })` waits for first item — empty queue = infinite hang
- `systemPrompt: 'default'` sets literal string `"default"`. Use `{ type: 'preset', preset: 'claude_code' }` for actual default.
- `SDKUserMessage` requires `parent_tool_use_id: null` for top-level messages.
- `canUseTool` only fires when tool needs permission approval — pre-approved tools skip it entirely.
- `bypassPermissions` requires `allowDangerouslySkipPermissions: true` or silently falls back to default mode.
- `settingSources: ['user', 'project', 'local']` — omitting `'user'` hides global MCP servers/skills/plugins.
- Use SDK's `toolUseID` as `requestId`, not custom UUIDs.

## OpenClaw Plugin Conventions

- Tool schemas use `@sinclair/typebox` (`Type.Object()`), not raw JSON Schema.
- `execute()` signature: `(_id: string, params: Record<string, unknown>)` — no caller context; use factory pattern.
- Hook `before_tool_call` event: `{ toolName: string, params }` — NOT `tool`. Return: `{ block?, blockReason? }` — NOT `message`.
- `registerTool({ optional: true })` hides tools unless explicitly allowlisted in agent config.
- `Type.Record()` → `patternProperties` → Anthropic rejects. Use `Type.Unsafe({ additionalProperties: {schema} })`.

## Test Structure

- **Framework**: Vitest with `globals: true`
- **Tests**: `tests/unit/` (unit tests) + `tests/integration/` (full-stack)
- **Helpers**: `tests/helpers/mock-provider.ts` — mock SessionProvider for unit tests
- Coverage excludes provider implementations, barrel files, and the OpenClaw plugin entry (hard to test without OpenClaw runtime)

## Headless Mode

SessionManager has a `headless` option (auto-detects from `!process.stdout.isTTY`). When headless:
- `spawn()` and `switchMode()` block `mode: 'local'` — local mode needs a terminal.
- OpenClaw plugin always sets `headless: true` (gateway has no TTY).
- Tests pass `headless: false` to allow local mode testing.
