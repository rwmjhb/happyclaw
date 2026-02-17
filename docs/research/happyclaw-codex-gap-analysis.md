# HappyClaw Codex Provider — Gap Analysis Report

**Date**: 2026-02-17
**Author**: codebase-researcher (codex-rewrite team)
**Purpose**: Catalog the current HappyClaw Codex implementation, identify gaps vs. what Codex MCP actually supports (per Happy Coder's implementation), and map every file/function that needs to change.

---

## Part A: Current HappyClaw Codex Implementation

### A.1 CodexMCPProvider (`src/providers/codex-mcp.ts`)

**Classes**: `CodexMCPProvider`, `CodexMCPSession`, `CodexLocalSession`

#### CodexMCPProvider (lines 49-66)

```typescript
export class CodexMCPProvider implements SessionProvider {
  readonly name = 'codex';
  readonly supportedModes: readonly SessionMode[] = ['local', 'remote'];

  async spawn(options: SpawnOptions): Promise<ProviderSession> {
    if (options.mode === 'local') return new CodexLocalSession(options);
    return new CodexMCPSession(options);
  }

  async resume(sessionId, options): Promise<ProviderSession> {
    return this.spawn({ ...options, resumeSessionId: sessionId });
  }
}
```

- Simple factory: delegates to `CodexMCPSession` (remote) or `CodexLocalSession` (local).
- Resume is just spawn with `resumeSessionId` injected.

#### CodexMCPSession (lines 72-356)

The remote MCP session. Key behaviors:

| Aspect | Current Implementation |
|--------|----------------------|
| **Transport** | Custom `McpStdioBridge` (raw JSON-RPC framing over stdio) |
| **Command** | `codex mcp-server` (resolved via `resolveCodexPath()` shell lookup) |
| **Session ID** | Self-generated: `codex-${Date.now()}` or passed `resumeSessionId` |
| **MCP Initialize** | Sends `initialize` RPC with `protocolVersion: '2024-11-05'`, followed by `notifications/initialized` |
| **Send input** | `tools/call { name: 'send_message', arguments: { message } }` |
| **Permission response** | `tools/call { name: 'respond_permission', arguments: { approved } }` |
| **Notifications handled** | `notifications/message`, `notifications/tools/call_progress`, `notifications/permission_request`, `notifications/error` |
| **Message buffering** | Internal `messageBuffer: SessionMessage[]` with cursor pagination |
| **Event emission** | `eventHandlers[]` and `messageHandlers[]` arrays |
| **Read** | Synchronous buffer slice (cursor-based) |
| **waitForReady()** | Resolves when `initialize` RPC completes |

**Critical observation**: The current implementation treats Codex MCP as a **stateless tool server** — it sends `tools/call` with tool names like `send_message` and `respond_permission`. This is likely wrong.

#### CodexLocalSession (lines 362-476)

- Simple `spawn('codex', args, { stdio: 'inherit' })`.
- No PTY, no message capture.
- `send()` / `read()` throw errors (local mode means terminal-owned IO).
- Headless guard in SessionManager blocks this in gateway environments.

### A.2 McpStdioBridge (`src/providers/mcp-bridge.ts`)

Custom JSON-RPC transport layer:

- **Framing**: Content-Length header + body (standard MCP/LSP framing).
- **Request/response**: Auto-incrementing integer `id`, pending map with 30s timeout.
- **Notifications**: Emitted as EventEmitter `'notification'` events.
- **Process management**: SIGTERM + 5s SIGKILL fallback.
- **Error handling**: Stderr captured and emitted, exit codes forwarded.

**This is a solid low-level transport** but it duplicates what `@modelcontextprotocol/sdk`'s `Client + StdioClientTransport` provides natively. Happy Coder uses the official MCP SDK.

### A.3 Test Coverage (`tests/unit/codex-mcp.test.ts`)

329 lines, covers:

- `McpStdioBridge`: Content-Length framing, request/response resolution, notification emission, error handling, partial data, close cleanup.
- `CodexMCPProvider`: Name, supported modes.
- `CodexMCPSession`: Notification handling (message, tool_progress, permission_request, error, unknown), cursor-based read.

**Not tested**:
- `send()` (actual tools/call invocation)
- `respondToPermission()` (tools/call with respond_permission)
- `initialize()` handshake
- `CodexLocalSession` (any tests)
- Session resume flow
- Error recovery / reconnection

### A.4 How session_spawn handles provider=codex (`src/openclaw-plugin.ts`)

In `session_spawn.execute()` (line 423):

```typescript
const session = await manager.spawn(
  params.provider as string,  // 'codex'
  { cwd, mode, initialPrompt, permissionMode, model, ... },
  caller.userId,
);
```

This passes ALL Claude-specific SpawnOptions to the Codex provider. **Most of these are silently ignored** by `CodexMCPSession`'s constructor:

- `initialPrompt` — **IGNORED** (no equivalent of pushing initial message to Codex)
- `permissionMode` — **IGNORED** (Codex has its own execution policies)
- `model` — **IGNORED** (Codex manages its own model selection)
- `maxTurns`, `maxBudgetUsd` — **IGNORED**
- `allowedTools`, `disallowedTools` — **IGNORED**
- `continueSession`, `forkSession` — **IGNORED**
- `agents`, `mcpServers`, `plugins` — **IGNORED**
- `sandbox` — **IGNORED** (Codex has its own sandbox mechanism)

Only `cwd`, `mode`, `args`, and `resumeSessionId` are actually used.

---

## Part B: OpenClaw Plugin Architecture

### B.1 Plugin SDK Types

**No `openclaw` package in node_modules.** Types are defined inline in `src/openclaw-plugin.ts` (lines 27-53):

```typescript
interface OpenClawPluginApi {
  id: string;
  name: string;
  pluginConfig?: Record<string, unknown>;
  logger: { info, warn, error };
  registerTool: (tool: unknown, opts?) => void;
  on: (hookName: string, handler: (...args: unknown[]) => void) => void;
}

interface OpenClawPluginToolContext {
  agentAccountId?: string;
  messageChannel?: string;
  workspaceDir?: string;
  agentId?: string;
  sessionKey?: string;
  sandboxed?: boolean;
}
```

### B.2 Tool Registration Pattern

The plugin uses a **factory pattern** — a single `registerTool()` call with a factory function that receives per-agent context:

```typescript
api.registerTool(
  (ctx: OpenClawPluginToolContext) => {
    const caller = { userId: ctx.agentAccountId ?? 'anonymous', channelId: ctx.messageChannel ?? 'unknown' };
    return createOpenClawTools(manager, audit, caller, pushAdapter);
  },
);
```

Each tool returns `{ content: [{ type: "text", text }] }` via `textResult()`.

### B.3 Tool Parameters

All tools use `@sinclair/typebox` for parameter schemas (`Type.Object()`, `Type.String()`, etc.).

### B.4 Hooks

- **`before_tool_call`**: Blocks `exec("claude|codex ...")` commands, suggesting `session_spawn` instead.
- **`gateway_stop`**: Stops health checker, disposes push adapter and event bus, stops all sessions.

### B.5 Shared Infrastructure

Created in `register()`:
- `SessionManager` (headless: true)
- `EventBus` — batches events with priority queue
- `AuditLogger` — fire-and-forget audit trail
- `HealthChecker` — periodic session health monitoring
- `TelegramPushAdapter` (optional, if bot token configured)

---

## Part C: Claude SDK Provider (Reference Pattern)

### C.1 ClaudeRemoteSession (`src/providers/claude-sdk.ts`)

The gold standard for our provider pattern. Key design patterns to preserve:

| Pattern | Implementation | Codex Must Match |
|---------|---------------|-----------------|
| **waitForReady()** | Promise that resolves when `session_id` received from SDK stream | YES — Codex needs this for real session ID |
| **AsyncQueue input** | `inputQueue: AsyncQueue<SDKUserMessage>` fed into `sdkQuery({ prompt: queue })` | Different — Codex uses two-tool pattern |
| **Message buffering** | `messageBuffer: SessionMessage[]` with cursor pagination | Same pattern, reusable |
| **Event handlers** | `eventHandlers: EventHandler[]` + `messageHandlers: MessageHandler[]` | Same pattern |
| **Permission handling** | `canUseTool` callback with `PermissionResult` promise, resolved by `respondToPermission()` | Codex uses MCP Elicitation |
| **Permission timeout** | 5 min auto-deny via `pendingPermissions` Map | Need similar for Codex |
| **Stream listening** | `for await (const message of this.queryInstance)` driving `handleSDKMessage()` | Codex uses notification-based events |
| **Graceful stop** | `inputQueue.end()` + optional `queryInstance.close()` | Need equivalent for MCP Client |

### C.2 What's Provider-Specific vs Shared

**Provider-specific** (must be reimplemented per provider):
- Transport setup (SDK `query()` vs MCP `Client`)
- Message parsing (`handleSDKMessage()` vs notification handler)
- Input mechanism (AsyncQueue vs tool calls)
- Permission protocol (SDK `canUseTool` vs MCP Elicitation)
- Session ID extraction

**Shared via SessionManager** (DO NOT change):
- Session Map tracking (`sessions`, `switchStates`, `messageBuffers`)
- ACL enforcement (`acl.setOwner`, `acl.assertOwner`)
- CWD whitelist
- Headless mode guard
- Cursor-based `readMessages()` + `waitForMessages()`
- Mode switching state machine
- Persistence layer
- Event forwarding to EventBus

### C.3 Critical Shared Interfaces (`src/types/index.ts`)

Must be preserved exactly:

```typescript
interface ProviderSession {
  readonly id: string;
  readonly provider: string;
  readonly cwd: string;
  readonly pid: number;
  mode: SessionMode;
  send(input: string): Promise<void>;
  read(options?): Promise<ReadResult>;
  switchMode(target: SessionMode): Promise<void>;
  respondToPermission(requestId: string, approved: boolean): Promise<void>;
  stop(force?: boolean): Promise<void>;
  onEvent(handler: EventHandler): void;
  onMessage(handler: MessageHandler): void;
  waitForReady?(): Promise<void>;
}

interface SessionProvider {
  readonly name: string;
  readonly supportedModes: readonly SessionMode[];
  spawn(options: SpawnOptions): Promise<ProviderSession>;
  resume(sessionId: string, options: SpawnOptions): Promise<ProviderSession>;
}
```

---

## Part D: Gap Analysis Matrix

### D.1 Transport & Connection

| Feature | Happy Coder Does | HappyClaw Has | Gap |
|---------|-----------------|---------------|-----|
| MCP SDK usage | `@modelcontextprotocol/sdk` Client + StdioClientTransport | Custom `McpStdioBridge` (raw JSON-RPC) | **Major**: Should use official SDK for protocol compliance, Elicitation support, and maintainability |
| Protocol version | Uses SDK's latest MCP protocol | Hardcoded `2024-11-05` | **Minor**: May miss newer features |
| Process spawn | `sandbox-exec` wrapping for macOS | Direct `spawn('codex', ['mcp-server'])` | **Medium**: No sandboxing support |
| Version detection | `codex --version` parsing at startup | None | **Medium**: No version compatibility check |
| RUST_LOG filtering | Filters RUST_LOG from env to reduce stderr noise | None | **Minor**: Codex stderr may be noisy |

### D.2 Tool Protocol (Two-Tool Pattern)

| Feature | Happy Coder Does | HappyClaw Has | Gap |
|---------|-----------------|---------------|-----|
| Start conversation | `codex` tool: `{ session_id, prompt, execution_policy, images? }` | `tools/call { name: 'send_message', arguments: { message } }` | **CRITICAL**: Wrong tool name, wrong argument shape, missing execution_policy |
| Continue conversation | `codex-reply` tool: `{ session_id, reply }` | Same `send_message` for all messages | **CRITICAL**: No two-tool distinction |
| Session ID tracking | Extracted from tool result (codex returns session_id + conversation_id) | Self-generated `codex-${Date.now()}` | **CRITICAL**: Not using real Codex session IDs |
| Conversation ID | Separate `conversation_id` from Codex, used for resume | Not tracked | **Major**: Can't properly resume conversations |
| Execution policy | `{ full_auto, auto_edit, suggest, ask_human }` per-session config | Not supported | **Major**: No control over Codex autonomy level |
| Image support | Optional `images` array in start tool | Not supported | **Minor**: Image input not available |

### D.3 Event/Notification System

| Feature | Happy Coder Does | HappyClaw Has | Gap |
|---------|-----------------|---------------|-----|
| Event notification type | `codex/event` with rich subtype catalog | Four hardcoded notification methods | **CRITICAL**: Missing most event types |
| Event subtypes | `agent_message`, `agent_reasoning`, `exec_command_begin/end/output`, `code_apply_begin/end`, `get_patch_begin/end`, `background_event`, `mcp_server_*`, `agent_tool_*`, `task_complete` | Only: message, tools/call_progress, permission_request, error | **Major**: Missing 15+ event subtypes |
| Streaming text | Continuous `agent_message` events with incremental text | Buffered from notifications/message | **Medium**: No streaming display |
| Command execution events | `exec_command_begin` + `exec_command_output` (streaming) + `exec_command_end` | Not tracked | **Major**: No visibility into Codex command execution |
| Code changes | `code_apply_begin/end` with patch info | Not tracked | **Major**: No visibility into file modifications |
| Background events | `background_event` for internal state changes | Not tracked | **Minor**: Nice to have for debugging |

### D.4 Permission Handling

| Feature | Happy Coder Does | HappyClaw Has | Gap |
|---------|-----------------|---------------|-----|
| Permission protocol | MCP Elicitation (`ElicitRequestSchema`) | `tools/call { name: 'respond_permission', arguments: { approved } }` | **CRITICAL**: Wrong protocol — Codex uses MCP Elicitation, not a custom tool |
| Elicitation fields | `message`, `description`, `requestedSchema` with form fields | Only `approved: boolean` | **CRITICAL**: No permission detail forwarding |
| Elicitation response | `ElicitResultSchema` with action + content | Boolean approve/deny | **Major**: Loses structured response capability |
| Permission requestId | From Elicitation callback | Self-generated or from notification | **Medium**: ID correlation may be broken |

### D.5 Session Management

| Feature | Happy Coder Does | HappyClaw Has | Gap |
|---------|-----------------|---------------|-----|
| Session config | `CodexSessionConfig` with executionPolicy, cwd, model, etc. | Only `cwd` and `args` used | **Major**: Most config fields ignored |
| Default timeout | 14-day `DEFAULT_TIMEOUT` for long-running tasks | 30s bridge RPC timeout | **Major**: Long tasks will time out |
| Session resume | Via `session_id` in `codex` tool call | Restarts MCP server process | **Medium**: Not a true resume |
| Process cleanup | Proper MCP client disconnect + process kill | Bridge close + SIGTERM/SIGKILL | **Minor**: Similar approach, slightly less graceful |

### D.6 SpawnOptions Usage

| SpawnOptions Field | Claude Provider Uses | Codex Provider Uses | Gap |
|-------------------|---------------------|-------------------|-----|
| `cwd` | Yes (SDK cwd) | Yes (process cwd) | OK |
| `mode` | Yes (local/remote) | Yes (local/remote) | OK |
| `args` | Yes (CLI args) | Yes (appended to mcp-server) | OK |
| `resumeSessionId` | Yes (SDK resume) | Partially (sets session ID, doesn't resume) | **Major** |
| `initialPrompt` | Yes (pushed to AsyncQueue) | **IGNORED** | **Critical** |
| `permissionMode` | Yes (SDK permissionMode) | **IGNORED** | **Major** — maps to executionPolicy |
| `model` | Yes (SDK model) | **IGNORED** | **Medium** |
| `maxTurns` | Yes (SDK maxTurns) | **IGNORED** | **Minor** (Codex may not support) |
| `maxBudgetUsd` | Yes (SDK maxBudgetUsd) | **IGNORED** | **Minor** |
| `allowedTools` | Yes (SDK allowedTools) | **IGNORED** | **Minor** |
| `disallowedTools` | Yes (SDK disallowedTools) | **IGNORED** | **Minor** |
| `continueSession` | Yes (SDK continue) | **IGNORED** | **Medium** |
| `forkSession` | Yes (SDK forkSession) | **IGNORED** | **Minor** |
| `sandbox` | Yes (SDK sandbox) | **IGNORED** | **Medium** — Codex has own sandbox |

---

## Part E: Files That Need to Change

### E.1 Must Rewrite

| File | What Changes | Risk Level |
|------|-------------|------------|
| `src/providers/codex-mcp.ts` | **Complete rewrite** of `CodexMCPSession`. Replace McpStdioBridge usage with `@modelcontextprotocol/sdk` Client. Implement two-tool pattern (`codex` / `codex-reply`). Handle `codex/event` notifications. Implement Elicitation-based permissions. | HIGH — core provider logic |
| `src/providers/mcp-bridge.ts` | **May be deletable** if we switch to official MCP SDK. Or keep as fallback for other MCP servers. | LOW — only used by codex-mcp.ts |
| `tests/unit/codex-mcp.test.ts` | **Complete rewrite** to test new event handling, two-tool pattern, Elicitation permissions, session tracking. | MEDIUM — follows implementation |

### E.2 Must Modify

| File | What Changes | Risk Level |
|------|-------------|------------|
| `package.json` | Add `@modelcontextprotocol/sdk` dependency | LOW |
| `src/types/index.ts` | Add Codex-specific SpawnOptions fields (executionPolicy, images). May need to extend `PermissionDetail` for Elicitation fields. | MEDIUM — shared interface, must not break Claude |
| `src/openclaw-plugin.ts` | Map `session_spawn` params to Codex-specific options (execution policy mapping from permissionMode, etc.). May need new params for Codex-specific features. | MEDIUM |
| `src/providers/index.ts` | Update exports if class names change | LOW |

### E.3 Must NOT Change (preserve contract)

| File | Reason |
|------|--------|
| `src/session-manager.ts` | Shared session lifecycle — all providers depend on this. The `ProviderSession` interface contract is the integration point. |
| `src/providers/claude-sdk.ts` | Claude provider must continue working identically. |
| `src/providers/generic-pty.ts` | Gemini PTY provider must continue working. |
| `src/security/` | ACL and CWD whitelist are provider-agnostic. |
| `src/event-bus.ts` | Event routing is provider-agnostic. |
| `src/push/telegram-push-adapter.ts` | Consumes `SessionMessage` and `SessionEvent` — provider-agnostic. |

### E.4 Opportunities for Shared Abstractions

| Pattern | Currently | Could Be Shared |
|---------|----------|----------------|
| Message buffering + cursor pagination | Duplicated in each provider's `read()` | `SessionManager.readMessages()` already does this — providers should NOT have their own buffer. The current codex-mcp.ts has redundant buffering. |
| Event handler registration | Duplicated `eventHandlers[]` + `messageHandlers[]` in every provider | Could extract a `BaseSession` class, but might be over-engineering for 3 providers. |
| Process lifecycle (SIGTERM + SIGKILL timeout) | Duplicated in CodexLocalSession, ClaudeLocalSession, PTYLocalSession | Could extract, but it's only ~15 lines each. |

---

## Part F: Summary of Critical Gaps (Priority Order)

1. **Wrong tool protocol**: Using `send_message`/`respond_permission` instead of `codex`/`codex-reply` two-tool pattern.
2. **Wrong permission protocol**: Using custom tool call instead of MCP Elicitation.
3. **Missing event types**: Only 4 notification types handled vs. 15+ `codex/event` subtypes.
4. **Self-generated session IDs**: Not extracting real `session_id` + `conversation_id` from Codex.
5. **No execution policy**: Cannot control Codex autonomy level (full_auto, suggest, etc.).
6. **Custom transport**: `McpStdioBridge` should be replaced with official `@modelcontextprotocol/sdk`.
7. **initialPrompt ignored**: Codex sessions start without a task — the first `codex` tool call should carry the prompt.
8. **30s timeout vs 14-day timeout**: Long-running Codex tasks will time out prematurely.
9. **No sandbox wrapping**: Codex processes not sandboxed on macOS.
10. **Redundant message buffer**: Both provider and SessionManager maintain message buffers.

---

## Part G: Interface Compatibility Notes

The rewrite MUST satisfy `ProviderSession` exactly:

```typescript
interface ProviderSession {
  readonly id: string;        // Must be real Codex session_id
  readonly provider: string;  // 'codex'
  readonly cwd: string;
  readonly pid: number;       // MCP server process PID
  mode: SessionMode;

  send(input: string): Promise<void>;                    // Maps to codex-reply tool
  read(options?): Promise<ReadResult>;                    // Buffer + cursor (can delegate to SessionManager)
  switchMode(target: SessionMode): Promise<void>;         // Stop + resume
  respondToPermission(requestId: string, approved: boolean): Promise<void>;  // MCP Elicitation response
  stop(force?: boolean): Promise<void>;                  // MCP client disconnect + kill
  onEvent(handler: EventHandler): void;
  onMessage(handler: MessageHandler): void;
  waitForReady?(): Promise<void>;                        // Resolves after MCP init + first codex tool call
}
```

Key mapping:
- `send()` → `codex-reply` tool call (for subsequent messages after spawn)
- `respondToPermission()` → Resolve MCP Elicitation callback
- `waitForReady()` → After MCP initialize + first `codex` tool call returns session_id
- Session spawn → MCP connect + `codex` tool call with prompt + execution_policy
