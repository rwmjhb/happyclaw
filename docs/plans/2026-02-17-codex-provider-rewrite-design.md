# Codex Provider Rewrite — Design Document

> Date: 2026-02-17
> Status: Draft — pending Codex cross-model review
> Based on: happy-coder-codex-analysis.md + happyclaw-codex-gap-analysis.md

---

## 1. Motivation

The current `CodexMCPSession` was built on assumptions about Codex's MCP protocol that turned out to be wrong. It uses fictional tool names (`send_message`, `respond_permission`), fictional notification methods, and self-generated session IDs. The rewrite aligns with Codex's actual MCP protocol as documented by Happy Coder's production implementation.

**Scope**: Rewrite the Codex remote provider only. Claude SDK provider, SessionManager, EventBus, TelegramPushAdapter, and all security modules remain untouched.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│              CodexMCPSession (rewritten)              │
│                                                       │
│  ┌──────────────────┐  ┌──────────────────────────┐  │
│  │ MCP Client       │  │ StdioClientTransport     │  │
│  │ (@mcp/sdk)       │  │ codex mcp-server         │  │
│  │ + elicitation    │  │ (PATH-resolved)          │  │
│  └──────────────────┘  └──────────────────────────┘  │
│                                                       │
│  ┌──────────────────┐  ┌──────────────────────────┐  │
│  │ Event Handler    │  │ Permission Handler       │  │
│  │ codex/event →    │  │ ElicitRequest →          │  │
│  │ SessionMessage   │  │ pendingPermissions Map   │  │
│  └──────────────────┘  └──────────────────────────┘  │
│                                                       │
│  State: idle → starting → running → stopped           │
│  Tools: codex (start) → codex-reply (continue)        │
└───────────────────────┬───────────────────────────────┘
                        │ implements ProviderSession
                        ▼
┌─────────────────────────────────────────────────────┐
│              SessionManager (unchanged)               │
│  ACL, EventBus, MessageBuffer, TelegramPush          │
└─────────────────────────────────────────────────────┘
```

---

## 3. Key Design Decisions

### 3.1 Use official MCP SDK (not custom McpStdioBridge)

**Decision**: Replace `McpStdioBridge` with `@modelcontextprotocol/sdk` Client + StdioClientTransport.

**Rationale**:
- Elicitation protocol support built-in (critical for permissions)
- Zod-validated notification handling
- Proper MCP lifecycle management (connect/close)
- Maintained by the MCP community, not us

**Impact**: Add `@modelcontextprotocol/sdk` and `zod` to dependencies. Keep `mcp-bridge.ts` for potential future use with other MCP servers.

### 3.2 Two-tool session pattern

**Decision**: First `send()` calls `codex` tool (start session), subsequent calls use `codex-reply` tool.

```typescript
class CodexMCPSession {
  private sessionStarted = false;
  private codexSessionId: string | null = null;
  private conversationId: string | null = null;

  async send(input: string): Promise<void> {
    if (!this.sessionStarted) {
      // First message → codex tool (startSession)
      await this.startSession(input);
    } else {
      // Subsequent → codex-reply tool (continueSession)
      await this.continueSession(input);
    }
  }
}
```

### 3.3 initialPrompt triggers session start in constructor

**Decision**: If `SpawnOptions.initialPrompt` is provided, call `startSession()` during initialization (after MCP connect). This matches Claude SDK provider behavior where `initialPrompt` pushes the first message to the AsyncQueue.

```
Constructor:
  1. Create Client + Transport
  2. Register codex/event handler
  3. Register ElicitRequestSchema handler
  4. readyPromise = connect + optionally startSession(initialPrompt)
```

### 3.4 Execution policy mapping

**Decision**: Map `SpawnOptions.permissionMode` to Codex's `approval-policy` + `sandbox` pair, following Happy Coder's proven mapping:

| HappyClaw permissionMode | Codex approval-policy | Codex sandbox |
|---|---|---|
| `default` | `untrusted` | `workspace-write` |
| `bypassPermissions` | `never` | `danger-full-access` |
| `acceptEdits` | `on-request` | `workspace-write` |
| `plan` | `untrusted` | `read-only` |

### 3.5 Permission via MCP Elicitation

**Decision**: Use standard MCP Elicitation protocol. Store pending permission requests as Promises in a Map, resolve when `respondToPermission()` is called.

```typescript
// Registration
client.setRequestHandler(ElicitRequestSchema, async (request) => {
  const { codex_call_id, codex_command, codex_cwd } = request.params;

  // Emit event for remote user
  this.emitEvent({
    type: 'permission_request',
    permissionDetail: {
      requestId: codex_call_id,
      toolName: 'CodexBash',
      input: { command: codex_command, cwd: codex_cwd },
    },
  });

  // Wait for respondToPermission() call
  const decision = await this.waitForPermissionDecision(codex_call_id);
  return { decision };
});

// Resolution
async respondToPermission(requestId: string, approved: boolean): Promise<void> {
  const resolver = this.pendingPermissions.get(requestId);
  if (resolver) {
    resolver(approved ? 'approved' : 'denied');
    this.pendingPermissions.delete(requestId);
  }
}
```

**Timeout**: 5 minutes auto-deny (matching Claude provider).

### 3.6 14-day tool call timeout

**Decision**: Use `14 * 24 * 60 * 60 * 1000` ms timeout for `callTool()`. Codex tool calls block for the entire agent turn while events stream via notifications.

### 3.7 Session ID extraction (defensive)

**Decision**: Extract `sessionId` and `conversationId` from both tool responses AND events, checking multiple locations with snake_case/camelCase fallbacks:

```typescript
// From tool response
response.meta?.sessionId | response.sessionId | response.content[].sessionId

// From events
event.session_id | event.sessionId | event.data?.session_id
```

### 3.8 Keep CodexLocalSession minimal

**Decision**: Keep `CodexLocalSession` as-is (stdio inherit for native terminal). It's blocked in headless gateway anyway. Only apply the `resolveCodexPath()` fix.

---

## 4. Event Mapping

### codex/event → SessionMessage

| Codex Event | SessionMessage type | content | metadata |
|---|---|---|---|
| `agent_message` | `text` | `msg.message` | — |
| `agent_reasoning` | `thinking` | `msg.text` | — |
| `agent_reasoning_delta` | (skip) | — | — |
| `agent_reasoning_section_break` | (skip) | — | — |
| `exec_command_begin` | `tool_use` | `msg.command` | `{ tool: 'CodexBash', callId: msg.call_id }` |
| `exec_command_end` | `tool_result` | `msg.output \|\| msg.error` | `{ callId: msg.call_id }` |
| `patch_apply_begin` | `tool_use` | files summary | `{ tool: 'CodexPatch', callId: msg.call_id }` |
| `patch_apply_end` | `tool_result` | `msg.success ? stdout : stderr` | `{ callId: msg.call_id }` |
| `turn_diff` | `text` | `msg.unified_diff` | `{ isDiff: true }` |
| `token_count` | (skip) | — | — |

### codex/event → SessionEvent

| Codex Event | SessionEvent type | severity |
|---|---|---|
| `task_started` | `ready` | `info` |
| `task_complete` | `task_complete` | `info` |
| `turn_aborted` | `error` | `warning` |
| `exec_approval_request` | `permission_request` | `urgent` |

---

## 5. SpawnOptions → CodexSessionConfig Mapping

```typescript
function buildCodexConfig(options: SpawnOptions): CodexSessionConfig {
  const policy = resolveExecutionPolicy(options.permissionMode);

  return {
    prompt: options.initialPrompt ?? '',
    'approval-policy': policy.approvalPolicy,
    sandbox: policy.sandbox,
    cwd: options.cwd,
    model: options.model,
    config: {
      ...(options.mcpServers ? { mcp_servers: options.mcpServers } : {}),
    },
  };
}
```

**Unmapped SpawnOptions** (no Codex equivalent):
- `maxTurns`, `maxBudgetUsd` — Codex doesn't support these
- `allowedTools`, `disallowedTools` — Codex manages tools internally
- `plugins`, `agents`, `settingSources` — Claude-specific
- `enableFileCheckpointing`, `forkSession` — Claude-specific
- `debug`, `debugFile` — Could potentially map to RUST_LOG but low priority

---

## 6. File Changes

### 6.1 Full Rewrite

| File | Description |
|---|---|
| `src/providers/codex-mcp.ts` | New `CodexMCPSession` using official MCP SDK, two-tool pattern, Elicitation permissions, codex/event handling |
| `tests/unit/codex-mcp.test.ts` | New tests for event mapping, two-tool flow, permission flow, session ID extraction, timeout, execution policy |

### 6.2 Modify

| File | Change |
|---|---|
| `package.json` | Add `@modelcontextprotocol/sdk`, `zod` |
| `src/types/index.ts` | Extend `SessionMessage.type` to include `'thinking'`. Extend `PermissionDetail` with `command?: string[]`, `cwd?: string` for Codex elicitation fields. |
| `src/openclaw-plugin.ts` | Add `sandbox` param to `session_spawn` for Codex. Map `permissionMode` → execution policy in tool description. |

### 6.3 No Change (contract preserved)

| File | Reason |
|---|---|
| `src/session-manager.ts` | Shared lifecycle — ProviderSession interface is the boundary |
| `src/providers/claude-sdk.ts` | Must not touch Claude provider |
| `src/providers/generic-pty.ts` | Must not touch Gemini PTY provider |
| `src/providers/mcp-bridge.ts` | Keep for potential other MCP servers |
| `src/security/*` | Provider-agnostic |
| `src/push/*` | Consumes SessionMessage/SessionEvent — provider-agnostic |
| `src/event-bus.ts` | Provider-agnostic |

---

## 7. New Class Structure

```typescript
// src/providers/codex-mcp.ts

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export class CodexMCPSession implements ProviderSession {
  readonly provider = 'codex';
  readonly cwd: string;
  mode: SessionMode = 'remote';

  // MCP
  private client: Client;
  private transport: StdioClientTransport;

  // Session state
  private sessionStarted = false;
  private codexSessionId: string | null = null;
  private conversationId: string | null = null;

  // Permissions
  private pendingPermissions = new Map<string, (decision: string) => void>();
  private permissionTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  // Buffers & handlers
  private messageBuffer: SessionMessage[] = [];
  private eventHandlers: EventHandler[] = [];
  private messageHandlers: MessageHandler[] = [];

  // Config (stored for startSession)
  private spawnOptions: SpawnOptions;
  private readyPromise: Promise<void>;

  constructor(options: SpawnOptions) {
    this.cwd = options.cwd;
    this.spawnOptions = options;
    this.readyPromise = this.initialize(options);
  }

  // --- ProviderSession interface ---
  get id(): string { return this.codexSessionId ?? `codex-pending-${Date.now()}`; }
  get pid(): number { return this.transport?.pid ?? 0; }

  async waitForReady(): Promise<void> { await this.readyPromise; }

  async send(input: string): Promise<void> { /* two-tool pattern */ }
  async read(options?): Promise<ReadResult> { /* buffer slice */ }
  async switchMode(target: SessionMode): Promise<void> { /* stop */ }
  async respondToPermission(requestId, approved): Promise<void> { /* resolve elicitation */ }
  async stop(force?): Promise<void> { /* client.close + kill */ }
  onEvent(handler): void { /* push */ }
  onMessage(handler): void { /* push */ }

  // --- Private ---
  private async initialize(options: SpawnOptions): Promise<void> { /* connect + optional startSession */ }
  private async startSession(prompt: string): Promise<void> { /* codex tool */ }
  private async continueSession(prompt: string): Promise<void> { /* codex-reply tool */ }
  private handleCodexEvent(msg: Record<string, unknown>): void { /* event dispatch */ }
  private extractIdentifiers(source: unknown): void { /* defensive extraction */ }
  private resolveExecutionPolicy(mode?: string): { approvalPolicy, sandbox } { /* mapping */ }
  private bufferAndEmit(msg: SessionMessage): void { /* buffer + handlers */ }
  private emitEvent(event: SessionEvent): void { /* handlers */ }
}
```

---

## 8. Environment Setup

```typescript
function buildTransportEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }

  // Suppress noisy Codex rollout logs
  const filter = 'codex_core::rollout::list=off';
  if (!env.RUST_LOG) {
    env.RUST_LOG = filter;
  } else if (!env.RUST_LOG.includes('codex_core::rollout::list=')) {
    env.RUST_LOG = `${env.RUST_LOG},${filter}`;
  }

  return env;
}
```

---

## 9. Version Detection

```typescript
function getCodexMcpSubcommand(): string {
  try {
    const version = execSync(`${resolveCodexPath()} --version`, { encoding: 'utf8' }).trim();
    const match = version.match(/codex-cli\s+(\d+)\.(\d+)\.(\d+)/);
    if (!match) return 'mcp-server'; // default to modern
    const [, major, minor] = match.map(Number);
    if (major! > 0 || minor! >= 43) return 'mcp-server';
    return 'mcp';
  } catch {
    return 'mcp-server'; // default
  }
}
```

---

## 10. Test Strategy

### Unit Tests (vitest, mocked MCP SDK)

1. **Event mapping**: Each codex/event type → correct SessionMessage/SessionEvent
2. **Two-tool flow**: First send → `codex` tool, subsequent → `codex-reply`
3. **Session ID extraction**: From tool response (meta, root, content) and events (snake_case, camelCase)
4. **Permission flow**: Elicitation → emit event → respondToPermission → resolve
5. **Permission timeout**: 5 min auto-deny
6. **Execution policy**: Each permissionMode → correct approval-policy + sandbox
7. **Config building**: SpawnOptions → CodexSessionConfig mapping
8. **Stop/cleanup**: Client close, process kill, pending permission rejection

### Integration Test (manual)

1. `session_spawn provider=codex task="list files in /tmp"` from TG
2. Verify events stream to TG push
3. Test permission approval/deny flow
4. Test `session_send` (codex-reply continuation)
5. Test `session_stop`

---

## 11. Migration Plan

1. Add dependencies (`@modelcontextprotocol/sdk`, `zod`)
2. Rewrite `src/providers/codex-mcp.ts` (CodexMCPSession only, keep CodexLocalSession + CodexMCPProvider)
3. Update `src/types/index.ts` (add `'thinking'` message type, extend PermissionDetail)
4. Update `src/openclaw-plugin.ts` (execution policy params)
5. Rewrite `tests/unit/codex-mcp.test.ts`
6. Build + run all 415+ tests (ensure Claude provider unaffected)
7. Deploy + gateway restart
8. Manual TG integration test

---

## 12. Open Questions for Codex Review

1. Is the `codex/event` notification the only event channel, or are there other notification methods?
2. Are `codex` and `codex-reply` the only two tools exposed by `codex mcp-server`?
3. Does `codex-reply` work without `conversationId` (just `sessionId`)?
4. What happens if we call `codex-reply` before `codex`? Error? New session?
5. Is the Elicitation response format exactly `{ decision: string }` or are there other fields?
6. Does `codex mcp-server` respect `approval-policy: never` to skip all elicitation requests?
7. What's the minimum Codex version that supports the current MCP protocol?

---

*Design document by team-lead. Pending Codex (GPT-5.3) cross-model review.*
