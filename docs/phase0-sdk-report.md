# Phase 0 SDK Validation Report

> Generated: 2026-02-09
> SDK Version: @anthropic-ai/claude-agent-sdk@0.2.37
> Claude Code Version: 2.1.37
> Node.js: v24.7.0
> Runner: Claude Opus 4.6

## 1. Package Info

- **Package**: `@anthropic-ai/claude-agent-sdk`
- **Version**: 0.2.37
- **Entry point**: `sdk.mjs` (ESM only)
- **Type definitions**: `sdk.d.ts`
- **Engine requirement**: Node.js >= 18.0.0
- **Peer dependency**: `zod@^4.0.0`
- **Claude Code Version bundled**: 2.1.37

### 1.1 Exported Functions

| Export | Type | Description |
|--------|------|-------------|
| `query()` | Function | Main API — starts a Claude session, returns `Query` (AsyncGenerator) |
| `createSdkMcpServer()` | Function | Creates an in-process MCP server for custom tools |
| `tool()` | Function | Helper to define MCP tool definitions |
| `unstable_v2_createSession()` | Function | V2 API (alpha) — persistent multi-turn session |
| `unstable_v2_prompt()` | Function | V2 API (alpha) — one-shot convenience |
| `unstable_v2_resumeSession()` | Function | V2 API (alpha) — resume by session ID |

### 1.2 Key Exported Types

| Type | Description |
|------|-------------|
| `Query` | AsyncGenerator<SDKMessage> with control methods (interrupt, close, streamInput, etc.) |
| `SDKMessage` | Union of all message types in the stream |
| `SDKUserMessage` | User input message for streaming input |
| `SDKAssistantMessage` | Assistant response with BetaMessage content |
| `SDKResultMessage` | Final result (success or error) |
| `SDKSystemMessage` | Init message with session config |
| `Options` | Full options for query() |
| `CanUseTool` | Permission callback type |
| `PermissionResult` | Return type of canUseTool callback |
| `PermissionMode` | `'default' \| 'acceptEdits' \| 'bypassPermissions' \| 'plan' \| 'delegate' \| 'dontAsk'` |
| `SettingSource` | `'user' \| 'project' \| 'local'` |
| `SDKSession` | V2 API (alpha) session interface |
| `SDKSessionOptions` | V2 API (alpha) session options |

## 2. API Validation Results

### 2.1 query()

**Actual signature:**
```typescript
function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
```

**Proposal's assumption:**
```typescript
query({
  prompt: userMessages,       // AsyncIterable<SDKUserMessage>
  options: { cwd, resume, permissionMode, canUseTool, systemPrompt, settingSources },
});
```

**Match: ✅ Confirmed**

**Validation results (PoC #1):**
- `query()` returns a `Query` object that implements `AsyncGenerator<SDKMessage, void>`
- The returned object has all expected methods: `interrupt()`, `close()`, `streamInput()`, `initializationResult()`, `supportedCommands()`, `supportedModels()`, `mcpServerStatus()`, `accountInfo()`, `rewindFiles()`, `setPermissionMode()`, `setModel()`, `setMaxThinkingTokens()`, `setMcpServers()`, `reconnectMcpServer()`, `toggleMcpServer()`
- Accepts both `string` prompt (simple) and `AsyncIterable<SDKUserMessage>` (streaming input)
- Clean exit: iteration completes after `result` message

**Notes:**
- `prompt` as `string` is convenient for single-shot queries (not documented in proposal, but very useful)
- `Query` extends `AsyncGenerator`, which means standard `for await...of` works
- The `Query` interface also has `close()` for forceful termination (not just `AbortController`)

### 2.2 canUseTool

**Actual signature:**
```typescript
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    toolUseID: string;
    agentID?: string;
  }
) => Promise<PermissionResult>;
```

**Proposal's assumption:**
```typescript
canUseTool: (toolName, input, opts) => this.handlePermission(toolName, input, opts)
// opts assumed to have: { signal: AbortSignal }
```

**Match: ⚠️ Partial — signature more rich than assumed**

**Validation results (PoC #2):**
- The `canUseTool` callback parameter is accepted by `query()` without error
- **IMPORTANT FINDING**: `canUseTool` was NOT invoked during testing, even when Bash tool was used. This is because the callback is only called when a tool needs explicit permission approval — tools that are pre-approved (via user/project settings, allowedTools, or inherited environment) skip the callback entirely.
- The callback provides more context than the proposal assumed:
  - `options.suggestions` — permission update suggestions for "always allow" UX
  - `options.blockedPath` — the file path that triggered the permission request
  - `options.decisionReason` — human-readable reason for the permission check
  - `options.toolUseID` — unique ID per tool call (different from requestId in proposal)
  - `options.agentID` — sub-agent context

**PermissionResult type:**
```typescript
type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[]; toolUseID?: string }
  | { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?: string };
```

**Key differences from proposal:**
1. The `toolUseID` field in options replaces our proposal's custom `requestId` for correlating permission requests
2. `PermissionResult` supports `updatedInput` (modify tool input before execution) and `updatedPermissions` (update session permission rules)
3. `interrupt` flag on deny can halt the entire query, not just the tool call
4. The callback has `'ask'` behavior concept only in `PermissionBehavior` type, not in `PermissionResult`

### 2.3 Resume (--resume)

**Actual parameter:**
```typescript
options.resume?: string;  // Session ID to resume
options.continue?: boolean;  // Continue most recent session in cwd
options.forkSession?: boolean;  // Fork to new session ID on resume
options.sessionId?: string;  // Use specific session ID
options.resumeSessionAt?: string;  // Resume up to specific message UUID
```

**Proposal's assumption:**
```typescript
options: { resume: sessionId }
```

**Match: ✅ Confirmed (resume parameter exists and works)**

**Validation results (PoC #3):**
- Session ID is available from `session_id` field on every message (including `system:init`, `assistant`, `user`, `result`)
- `options.resume` accepts a session ID string and successfully resumes the session
- **Session ID is preserved across resume** — the resumed session has the same session_id
- Context is fully preserved — Claude recalled the secret code "ALPHA-7749" from the first session
- Additional resume features exist: `continue` (most recent session), `forkSession`, `resumeSessionAt`

**Key findings:**
- `forkSession: false` (default) means resume keeps the same session ID — confirms M-3 from review was already correct by default
- `resumeSessionAt` allows resuming from a specific point in conversation history (useful for error recovery)
- `sessionId` allows specifying a custom UUID for new sessions

### 2.4 systemPrompt / settingSources

**Actual parameters:**
```typescript
options.systemPrompt?: string | {
  type: 'preset';
  preset: 'claude_code';
  append?: string;
};

options.settingSources?: ('user' | 'project' | 'local')[];
```

**Proposal's assumption:**
```typescript
systemPrompt: 'default',         // string
settingSources: ['project'],     // array
```

**Match: ⚠️ Partial — systemPrompt is more flexible than assumed**

**Validation results (PoC #6):**

| Test | systemPrompt | settingSources | Result |
|------|-------------|----------------|--------|
| Custom string | `'You are a pirate...'` | `[]` | ✅ Works — Claude responds in pirate speak |
| Preset + append | `{ type: 'preset', preset: 'claude_code', append: '...' }` | `[]` | ✅ Works — Claude Code prompt + appended instruction |
| With project | `{ type: 'preset', preset: 'claude_code' }` | `['project']` | ✅ Works — loads CLAUDE.md |
| Isolation mode | `'You are a helpful assistant.'` | `[]` | ✅ Works — clean isolation |

**Key differences from proposal:**
1. `systemPrompt: 'default'` (string) in the proposal would set the entire system prompt to the literal string "default" — NOT load the default prompt. Should use `{ type: 'preset', preset: 'claude_code' }` instead.
2. `settingSources` when omitted or `[]` = SDK isolation mode (no filesystem settings loaded). Must include `'project'` to load CLAUDE.md.
3. There is no `settingSources: ['project']` equivalent in the string form — must use the array.

### 2.5 fd3 Pipe

**Proposal's assumption:**
```typescript
const child = spawn('claude', args, {
  stdio: ['inherit', 'inherit', 'inherit', 'pipe'],  // fd3 for thinking state
});
child.stdio[3].on('data', ...);  // JSON events
```

**Match: ❌ Not validated — fd3 emits no events in --print mode**

**Validation results (PoC #4):**
- `claude --print` with `stdio[3] = 'pipe'` completes successfully (exit code 0, stdout contains response)
- **fd3 emitted zero events** during the test
- This suggests fd3 events may only be emitted:
  - During interactive mode (not `--print`)
  - During longer operations with thinking/tool execution
  - Or may require a specific CLI flag to enable
- The `--print` mode is non-interactive and may bypass the fd3 event system entirely

**Recommendations:**
- fd3 pipe should be tested in interactive mode (which requires stdin to remain open and a TTY)
- For HappyClaw's local mode, the fd3 pipe behavior may work when spawned with `['inherit', 'inherit', 'inherit', 'pipe']` in a real terminal
- Consider using SDK `query()` with `includePartialMessages: true` as an alternative to fd3 for tracking thinking state

### 2.6 Message Types

**Complete SDKMessage type taxonomy from PoC #5:**

```typescript
type SDKMessage =
  | SDKAssistantMessage         // type: 'assistant'
  | SDKUserMessage              // type: 'user'
  | SDKUserMessageReplay        // type: 'user' + isReplay: true
  | SDKResultMessage            // type: 'result' (success | error variants)
  | SDKSystemMessage            // type: 'system', subtype: 'init'
  | SDKPartialAssistantMessage  // type: 'stream_event' (when includePartialMessages=true)
  | SDKCompactBoundaryMessage   // type: 'system', subtype: 'compact_boundary'
  | SDKStatusMessage            // type: 'system', subtype: 'status'
  | SDKHookStartedMessage       // type: 'system', subtype: 'hook_started'
  | SDKHookProgressMessage      // type: 'system', subtype: 'hook_progress'
  | SDKHookResponseMessage      // type: 'system', subtype: 'hook_response'
  | SDKToolProgressMessage      // type: 'tool_progress'
  | SDKAuthStatusMessage        // type: 'auth_status'
  | SDKTaskNotificationMessage  // type: 'system', subtype: 'task_notification'
  | SDKFilesPersistedEvent      // type: 'system', subtype: 'files_persisted'
  | SDKToolUseSummaryMessage    // type: 'tool_use_summary'
```

**Observed message sequence (simple query):**
```
system:init → assistant → result:success
```

**Observed message sequence (tool-using query):**
```
system:init → assistant (tool_use) → user (tool_result) → assistant (text) → result:success
```

**Message structure examples:**

**system:init:**
```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/private/tmp/happyclaw-phase0-test",
  "session_id": "uuid",
  "tools": ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", ...],
  "mcp_servers": [],
  "model": "claude-opus-4-6",
  "permissionMode": "acceptEdits",
  "slash_commands": ["compact", "cost", "init", ...],
  "apiKeySource": "none",
  "claude_code_version": "2.1.37",
  "output_style": "default",
  "agents": ["Bash", "general-purpose", "Explore", "Plan", ...],
  "skills": [...],
  "plugins": [...],
  "uuid": "uuid",
}
```

**assistant (with tool_use):**
```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_xxx",
    "role": "assistant",
    "content": [
      { "type": "tool_use", "id": "toolu_xxx", "name": "Read", "input": { "file_path": "..." } }
    ],
    "usage": { "input_tokens": 3, "output_tokens": 26, ... }
  },
  "parent_tool_use_id": null,
  "session_id": "uuid",
  "uuid": "uuid"
}
```

**user (tool_result):**
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "tool_result", "content": "...", "is_error": true, "tool_use_id": "toolu_xxx" }
    ]
  },
  "parent_tool_use_id": null,
  "session_id": "uuid",
  "uuid": "uuid",
  "tool_use_result": "Error: File does not exist."
}
```

**result:success:**
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 5308,
  "duration_api_ms": 5189,
  "num_turns": 2,
  "result": "The file does not exist.",
  "stop_reason": null,
  "session_id": "uuid",
  "total_cost_usd": 0.025,
  "usage": { "input_tokens": 4, "output_tokens": 97, ... },
  "modelUsage": { "claude-opus-4-6": { ... } },
  "permission_denials": [],
  "uuid": "uuid"
}
```

**Key differences from proposal:**
1. Proposal listed message types as `'system' | 'assistant' | 'user' | 'result'` — actual SDK has 16 distinct types
2. `assistant.message` is a full `BetaMessage` object (Anthropic API format) with `content` array of blocks
3. `user` messages include `tool_use_result` field for convenience (duplicates content block data)
4. `result` has subtypes: `success`, `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`
5. Every message has `uuid` and `session_id` fields

### 2.7 SDKUserMessage

**Actual type:**
```typescript
type SDKUserMessage = {
  type: 'user';
  message: MessageParam;            // Anthropic API MessageParam
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  uuid?: UUID;
  session_id: string;
};
```

**Proposal's assumption:**
```typescript
this.messages.push({
  type: 'user',
  session_id: this.sessionId,
  message: { role: 'user', content: input },
});
```

**Match: ⚠️ Partial — missing required `parent_tool_use_id` field**

**Key differences:**
1. `parent_tool_use_id` is required (not optional) — must be `null` for top-level messages
2. `message` field is `MessageParam` from `@anthropic-ai/sdk` — needs `role` and `content`
3. `session_id` is required
4. `isSynthetic` is optional — marks programmatically injected messages
5. `uuid` is optional on input (SDK assigns one if not provided)

**Corrected usage for HappyClaw:**
```typescript
const userMessage: SDKUserMessage = {
  type: 'user',
  session_id: sessionId,
  parent_tool_use_id: null,  // Required!
  message: { role: 'user', content: input },
};
```

## 3. Discrepancies Summary

| Feature | Proposal Assumption | Actual SDK | Status |
|---------|-------------------|------------|--------|
| Package name | `@anthropic-ai/claude-agent-sdk` | `@anthropic-ai/claude-agent-sdk` | ✅ Match |
| `query()` signature | `{ prompt, options }` | `{ prompt, options }` | ✅ Match |
| `query()` return type | AsyncIterable | `Query` (AsyncGenerator + control methods) | ✅ Match (richer) |
| `canUseTool` name | `canUseTool` | `canUseTool` | ✅ Match |
| `canUseTool` options | `{ signal }` | `{ signal, suggestions, blockedPath, decisionReason, toolUseID, agentID }` | ⚠️ Richer than assumed |
| `canUseTool` invocation | Called for every tool use | Only called when tool needs permission approval | ❌ Behavioral difference |
| `PermissionResult` | `{ behavior: 'allow'\|'deny' }` | + `updatedInput`, `updatedPermissions`, `interrupt` | ⚠️ Richer |
| `options.resume` | string (session ID) | string (session ID) | ✅ Match |
| Session ID preserved on resume | Uncertain (M-3 concern) | ✅ Preserved (same ID) | ✅ Confirmed |
| `systemPrompt` | `'default'` (string) | string \| `{ type: 'preset', preset: 'claude_code', append? }` | ⚠️ Must use preset object |
| `settingSources` | `['project']` | `('user'\|'project'\|'local')[]` | ✅ Match |
| `SDKUserMessage` | `{ type, session_id, message }` | `{ type, session_id, message, parent_tool_use_id }` | ⚠️ Missing required field |
| Message types | 4 types | 16 types | ❌ Significantly more types |
| fd3 pipe events | JSON events during execution | No events in `--print` mode | ❓ Needs interactive testing |
| `requestId` for permissions | Custom UUID | SDK provides `toolUseID` | ⚠️ Use SDK's toolUseID instead |

## 4. Recommendations for Phase 1

### 4.1 Critical Changes

1. **Fix `systemPrompt` usage**: Replace `systemPrompt: 'default'` with `{ type: 'preset', preset: 'claude_code' }` in all code. The string form sets a literal system prompt, not a preset.

2. **Fix `SDKUserMessage` construction**: Add required `parent_tool_use_id: null` to all user messages sent via streaming input.

3. **Use SDK's `toolUseID` for permission correlation**: Instead of generating our own `requestId`, use the `toolUseID` from `canUseTool` options. This is the SDK's native correlation ID.

4. **Handle canUseTool not being called**: `canUseTool` is only called when a tool requires permission approval. If tools are pre-approved (via settings, `allowedTools`, or `acceptEdits` mode), the callback is skipped. HappyClaw's permission handling must account for this — use `permissionMode: 'default'` without pre-approving tools to ensure the callback fires.

### 4.2 Important Enhancements

5. **Handle all 16 message types**: The proposal only handles 4 message types. Phase 1 must handle or explicitly ignore: `stream_event`, `tool_progress`, `auth_status`, `system:status`, `system:compact_boundary`, `system:hook_*`, `system:task_notification`, `system:files_persisted`, `tool_use_summary`.

6. **Use `Query` control methods**: The `Query` interface provides `interrupt()`, `setPermissionMode()`, `setModel()`, `setMcpServers()` — these should be exposed through the Provider interface for dynamic control.

7. **Consider V2 Session API**: The SDK has an unstable `SDKSession` API (`unstable_v2_createSession()`, `unstable_v2_resumeSession()`) that provides a cleaner multi-turn interface with `send()` / `stream()`. While alpha, it closely matches HappyClaw's `ProviderSession` design. Monitor for stability.

8. **Use `options.continue`** instead of manually tracking last session ID per cwd — the SDK provides `continue: true` to resume the most recent session in a directory.

### 4.3 Architecture Refinements

9. **fd3 pipe for local mode**: fd3 events may only work in interactive mode. Since HappyClaw's local mode runs in user's terminal (stdio inherit), this should work in practice. But consider `includePartialMessages: true` as an alternative for programmatic thinking-state tracking.

10. **Permission mode strategy**: For remote mode, use `permissionMode: 'default'` with `canUseTool` callback (not `'bypassPermissions'`). For local mode, inherit whatever the user has configured.

11. **`PermissionResult.updatedPermissions`**: When a user says "always allow", pass the `suggestions` from `canUseTool` options back as `updatedPermissions` in the result. This updates the session's permission rules persistently.

12. **Cost tracking**: Every `result` message includes `total_cost_usd` and per-model `modelUsage`. Expose this through `session.read()` for cost monitoring.

### 4.4 Low Priority

13. **`options.maxBudgetUsd`**: SDK supports budget limits natively — expose through `session.spawn` options.

14. **`options.maxTurns`**: Built-in turn limits — useful for safety.

15. **`options.hooks`**: SDK supports programmatic hooks (PreToolUse, PostToolUse, etc.) — could replace some of HappyClaw's custom event handling.

16. **`createSdkMcpServer()`**: Can create in-process MCP tools — HappyClaw could expose its own tools to Claude this way.

## 5. V2 Session API (Alpha) — Potential Future Path

The SDK exports an unstable V2 API that is remarkably similar to HappyClaw's `ProviderSession` design:

```typescript
// Create session
const session: SDKSession = unstable_v2_createSession({ model: '...', canUseTool: ... });

// Send messages
await session.send("Hello");
await session.send({ type: 'user', message: ..., parent_tool_use_id: null, session_id: '...' });

// Stream responses
for await (const msg of session.stream()) { ... }

// Resume
const resumed = unstable_v2_resumeSession(sessionId, options);

// Cleanup
session.close();
await session[Symbol.asyncDispose]();
```

This API provides `sessionId`, `send()`, `stream()`, `close()` — almost exactly what `ProviderSession` needs. If it stabilizes, HappyClaw could adopt it and simplify the `ClaudeRemoteSession` implementation significantly.

## 6. Test Execution Log

| Script | Result | Duration | Key Finding |
|--------|--------|----------|-------------|
| 01-query-basic.ts | ✅ Pass | ~3s | Query returns AsyncGenerator with control methods |
| 02-can-use-tool.ts | ⚠️ Partial | ~3s | canUseTool accepted but not invoked (tools pre-approved) |
| 03-resume-session.ts | ✅ Pass | ~8s | Resume preserves context and session ID |
| 04-fd3-pipe.ts | ⚠️ Partial | ~5s | fd3 emits 0 events in --print mode |
| 05-message-types.ts | ✅ Pass | ~5s | Mapped 16 message types, captured full JSON |
| 06-system-prompt.ts | ✅ Pass | ~15s | All 4 systemPrompt/settingSources variants work |
