# Happy Coder (slopus/happy) - Codex MCP Client Analysis

> Research report for HappyClaw Codex provider rewrite.
> Source: https://github.com/slopus/happy — `packages/happy-cli/src/codex/`

---

## Table of Contents

1. [MCP SDK Usage Pattern](#1-mcp-sdk-usage-pattern)
2. [Two-Tool Pattern: `codex` + `codex-reply`](#2-two-tool-pattern-codex--codex-reply)
3. [Full `codex/event` Notification Catalog](#3-full-codexevent-notification-catalog)
4. [MCP Elicitation Protocol for Permissions](#4-mcp-elicitation-protocol-for-permissions)
5. [Session Tracking](#5-session-tracking)
6. [CodexSessionConfig](#6-codexsessionconfig)
7. [Sandbox Wrapping Mechanism](#7-sandbox-wrapping-mechanism)
8. [Version Detection](#8-version-detection)
9. [Timeout Handling](#9-timeout-handling)
10. [RUST_LOG Environment Filtering](#10-rust_log-environment-filtering)
11. [Execution Policy Mapping](#11-execution-policy-mapping)
12. [Session Protocol Mapping](#12-session-protocol-mapping)
13. [Auxiliary Components](#13-auxiliary-components)
14. [Architecture Summary](#14-architecture-summary)

---

## 1. MCP SDK Usage Pattern

Happy Coder uses the standard `@modelcontextprotocol/sdk` Client + StdioClientTransport pattern. The client is a thin wrapper class `CodexMcpClient`.

### Key Imports

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
```

### Client Initialization

```typescript
this.client = new Client(
    { name: 'happy-codex-client', version: '1.0.0' },
    { capabilities: { elicitation: {} } }  // <-- Enables elicitation protocol
);
```

**Critical detail**: The `capabilities: { elicitation: {} }` declaration is required. This tells the Codex MCP server that this client supports the elicitation protocol, which is how Codex asks for permission to run commands.

### Transport Setup

```typescript
this.transport = new StdioClientTransport({
    command: transportCommand,     // 'codex' or sandbox-wrapped
    args: transportArgs,           // ['mcp-server'] or ['mcp']
    env: transportEnv,             // Filtered process.env + RUST_LOG + CODEX_SANDBOX
});
```

### Connection Sequence

```
1. getCodexMcpCommand()           → Determine 'mcp' vs 'mcp-server'
2. initializeSandbox() (optional) → Set up seatbelt sandbox
3. wrapForMcpTransport() (opt.)   → Wrap command for sandbox
4. new StdioClientTransport(...)  → Create transport
5. registerPermissionHandlers()   → Set up ElicitRequestSchema handler
6. client.connect(transport)      → Start the MCP connection
```

### Notification Handler Registration

The `codex/event` notification is registered at construction time via Zod schema:

```typescript
this.client.setNotificationHandler(z.object({
    method: z.literal('codex/event'),
    params: z.object({
        msg: z.any()
    })
}).passthrough(), (data) => {
    const msg = data.params.msg;
    this.updateIdentifiersFromEvent(msg);
    this.handler?.(msg);
});
```

**Note**: `.passthrough()` is important to allow extra fields in the notification payload without Zod validation errors.

---

## 2. Two-Tool Pattern: `codex` + `codex-reply`

Codex exposes exactly two MCP tools from its MCP server:

### Tool 1: `codex` (Start Session)

**Purpose**: Start a new Codex session with a prompt and configuration.

```typescript
async startSession(config: CodexSessionConfig, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
    const response = await this.client.callTool({
        name: 'codex',
        arguments: config as any    // CodexSessionConfig is the argument shape
    }, undefined, {
        signal: options?.signal,
        timeout: DEFAULT_TIMEOUT,   // 14 days
    });
    this.extractIdentifiers(response);
    return response as CodexToolResponse;
}
```

**Argument shape** (`CodexSessionConfig`):

```typescript
{
    prompt: string;                    // Required: the user message
    'approval-policy'?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
    'base-instructions'?: string;
    config?: Record<string, any>;      // e.g. { mcp_servers: {...} }
    cwd?: string;
    'include-plan-tool'?: boolean;
    model?: string;
    profile?: string;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}
```

**Actual call in runCodex.ts**:

```typescript
const startConfig: CodexSessionConfig = {
    prompt: first ? message.message + '\n\n' + CHANGE_TITLE_INSTRUCTION : message.message,
    sandbox: executionPolicy.sandbox,
    'approval-policy': executionPolicy.approvalPolicy,
    config: { mcp_servers: mcpServers }
};
if (message.mode.model) {
    startConfig.model = message.mode.model;
}
// Optional resume support
if (resumeFile) {
    (startConfig.config as any).experimental_resume = resumeFile;
}

await client.startSession(startConfig, { signal: abortController.signal });
```

### Tool 2: `codex-reply` (Continue Session)

**Purpose**: Send follow-up messages to an existing session.

```typescript
async continueSession(prompt: string, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
    if (!this.sessionId) {
        throw new Error('No active session. Call startSession first.');
    }
    if (!this.conversationId) {
        this.conversationId = this.sessionId;  // Fallback
    }

    const args = {
        sessionId: this.sessionId,
        conversationId: this.conversationId,
        prompt
    };

    const response = await this.client.callTool({
        name: 'codex-reply',
        arguments: args
    }, undefined, {
        signal: options?.signal,
        timeout: DEFAULT_TIMEOUT
    });
    this.extractIdentifiers(response);
    return response as CodexToolResponse;
}
```

**Argument shape**:

```typescript
{
    sessionId: string;        // From previous startSession response or events
    conversationId: string;   // From previous response or events (fallback: sessionId)
    prompt: string;           // The follow-up user message
}
```

### Tool Response Shape (`CodexToolResponse`)

```typescript
interface CodexToolResponse {
    content: Array<{
        type: 'text' | 'image' | 'resource';
        text?: string;
        data?: any;
        mimeType?: string;
    }>;
    isError?: boolean;
}
```

### Lifecycle Flow

```
User Message 1 → codex(config)     → session starts, events stream in
                                    → response arrives (session complete or paused)
                                    → extract sessionId + conversationId

User Message 2 → codex-reply(args) → continues existing session
                                    → events stream in
                                    → response arrives

Mode Change    → clearSession()    → discard sessionId/conversationId
               → codex(newConfig)  → start fresh session with new policy
```

---

## 3. Full `codex/event` Notification Catalog

Events arrive via the `codex/event` notification method. The payload is `{ params: { msg: <event object> } }` where the event has a `type` field.

### Complete Event Type List (from runCodex.ts handler + sessionProtocolMapper.ts)

| Event Type | Fields | Description |
|---|---|---|
| `task_started` | - | Session turn begins; thinking = true |
| `task_complete` | - | Session turn ends; thinking = false |
| `turn_aborted` | `reason?`, `error?` | Turn was aborted (user abort or error) |
| `agent_message` | `message: string` | Text output from the agent |
| `agent_reasoning` | `text: string` | Complete reasoning block |
| `agent_reasoning_delta` | `delta: string` | Streaming reasoning token |
| `agent_reasoning_section_break` | - | Reasoning section boundary |
| `exec_command_begin` | `command`, `call_id?/callId?`, `cwd?`, `description?`, `subagent?/parent_call_id?` | Bash command started |
| `exec_command_end` | `output?`, `error?`, `call_id?/callId?` | Bash command completed |
| `exec_approval_request` | `call_id?/callId?`, `command`, `cwd`, `description?` | Command needs approval (mapped same as exec_command_begin) |
| `patch_apply_begin` | `auto_approved?`, `changes: Record<string,unknown>`, `call_id?/callId?` | File patch started |
| `patch_apply_end` | `stdout?`, `stderr?`, `success: boolean`, `call_id?/callId?` | File patch completed |
| `turn_diff` | `unified_diff: string` | Diff output for the turn |
| `token_count` | (various) | Token usage info (ignored in mapping) |

### Event Handling in runCodex.ts

```typescript
client.setHandler((msg) => {
    if (msg.type === 'agent_message') {
        messageBuffer.addMessage(msg.message, 'assistant');
    } else if (msg.type === 'agent_reasoning_delta') {
        // Skip in UI
    } else if (msg.type === 'agent_reasoning') {
        messageBuffer.addMessage(`[Thinking] ${msg.text.substring(0, 100)}...`, 'system');
    } else if (msg.type === 'exec_command_begin') {
        messageBuffer.addMessage(`Executing: ${msg.command}`, 'tool');
    } else if (msg.type === 'exec_command_end') {
        const output = msg.output || msg.error || 'Command completed';
        messageBuffer.addMessage(`Result: ${truncatedOutput}...`, 'result');
    } else if (msg.type === 'task_started') {
        messageBuffer.addMessage('Starting task...', 'status');
    } else if (msg.type === 'task_complete') {
        messageBuffer.addMessage('Task completed', 'status');
        sendReady();
    } else if (msg.type === 'turn_aborted') {
        messageBuffer.addMessage('Turn aborted', 'status');
        sendReady();
    } else if (msg.type === 'patch_apply_begin') {
        messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
    } else if (msg.type === 'patch_apply_end') {
        messageBuffer.addMessage(success ? stdout : `Error: ${stderr}`, 'result');
    } else if (msg.type === 'turn_diff') {
        diffProcessor.processDiff(msg.unified_diff);
    }
});
```

### Subagent Support in Events

Events can include subagent identifiers via `subagent`, `parent_call_id`, or `parentCallId` fields. The sessionProtocolMapper resolves these to stable session-level subagent IDs:

```typescript
function pickProviderSubagent(message: Record<string, unknown>): string | undefined {
    const candidates = [message.subagent, message.parent_call_id, message.parentCallId];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 0) {
            return candidate;
        }
    }
    return undefined;
}
```

---

## 4. MCP Elicitation Protocol for Permissions

Codex uses the MCP **Elicitation** protocol (not custom RPC) to request permission to execute commands. This is the most architecturally significant pattern.

### How It Works

1. Client declares `capabilities: { elicitation: {} }` during handshake
2. Client registers a request handler for `ElicitRequestSchema`
3. When Codex wants to run a command that needs approval, it sends an **elicitation request** (server → client)
4. Client responds with `{ decision: 'approved' | 'denied' }` (client → server)

### Request Handler Registration

```typescript
private registerPermissionHandlers(): void {
    this.client.setRequestHandler(
        ElicitRequestSchema,
        async (request) => {
            const params = request.params as unknown as {
                message: string,
                codex_elicitation: string,
                codex_mcp_tool_call_id: string,
                codex_event_id: string,
                codex_call_id: string,
                codex_command: string[],
                codex_cwd: string
            };

            if (!this.permissionHandler) {
                return { decision: 'denied' as const };
            }

            const result = await this.permissionHandler.handleToolCall(
                params.codex_call_id,
                'CodexBash',
                {
                    command: params.codex_command,
                    cwd: params.codex_cwd
                }
            );

            return { decision: result.decision };
        }
    );
}
```

### Elicitation Request Fields (from Codex)

| Field | Type | Description |
|---|---|---|
| `message` | `string` | Human-readable description |
| `codex_elicitation` | `string` | Elicitation type identifier |
| `codex_mcp_tool_call_id` | `string` | MCP tool call ID |
| `codex_event_id` | `string` | Codex internal event ID |
| `codex_call_id` | `string` | Unique call identifier (used as permission request ID) |
| `codex_command` | `string[]` | The command to execute (array form) |
| `codex_cwd` | `string` | Working directory for the command |

### Elicitation Response

```typescript
{ decision: 'approved' | 'approved_for_session' | 'denied' | 'abort' }
```

**Note**: The MCP spec `ElicitRequestSchema` is a standard MCP request/response. The `codex_*` prefixed fields are Codex-specific extensions. The response shape is `{ decision: string }`.

### Permission Flow (BasePermissionHandler)

```
Codex MCP Server
    │
    ├──▶ ElicitRequest { codex_call_id, codex_command, codex_cwd }
    │
CodexMcpClient
    │
    ├──▶ permissionHandler.handleToolCall(callId, 'CodexBash', { command, cwd })
    │         │
    │         ├──▶ Store in pendingRequests Map
    │         ├──▶ Update agentState with pending request
    │         └──▶ Return Promise<PermissionResult> (awaits user decision)
    │
    │    [User responds via RPC 'permission' handler on Happy session]
    │
    │         ├──▶ pendingRequests.get(response.id)
    │         ├──▶ Resolve promise with { decision }
    │         └──▶ Move to completedRequests in agentState
    │
    └──◀ Return { decision } to Codex
```

### PermissionResult Type

```typescript
interface PermissionResult {
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}
```

### Permission Response (from user/mobile app)

```typescript
interface PermissionResponse {
    id: string;         // Matches codex_call_id
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}
```

---

## 5. Session Tracking

Session and conversation IDs are extracted from two sources: tool responses and event notifications.

### Extraction from Tool Responses

```typescript
private extractIdentifiers(response: any): void {
    // Source 1: response.meta
    const meta = response?.meta || {};
    if (meta.sessionId) this.sessionId = meta.sessionId;
    if (meta.conversationId) this.conversationId = meta.conversationId;

    // Source 2: response root
    if (response?.sessionId) this.sessionId = response.sessionId;
    if (response?.conversationId) this.conversationId = response.conversationId;

    // Source 3: response.content array items
    const content = response?.content;
    if (Array.isArray(content)) {
        for (const item of content) {
            if (!this.sessionId && item?.sessionId) this.sessionId = item.sessionId;
            if (!this.conversationId && item?.conversationId) this.conversationId = item.conversationId;
        }
    }
}
```

### Extraction from Events

```typescript
private updateIdentifiersFromEvent(event: any): void {
    const candidates: any[] = [event];
    if (event.data && typeof event.data === 'object') {
        candidates.push(event.data);
    }

    for (const candidate of candidates) {
        const sessionId = candidate.session_id ?? candidate.sessionId;
        if (sessionId) this.sessionId = sessionId;

        const conversationId = candidate.conversation_id ?? candidate.conversationId;
        if (conversationId) this.conversationId = conversationId;
    }
}
```

**Key observations**:
- Both `snake_case` and `camelCase` forms are handled (`session_id` / `sessionId`)
- Event data may be nested under `event.data`
- Multiple extraction strategies ensure robustness across Codex versions
- `conversationId` falls back to `sessionId` if not present

### Session Lifecycle Methods

```typescript
getSessionId(): string | null;
hasActiveSession(): boolean;
clearSession(): void;                    // Clears both IDs (for mode change)
storeSessionForResume(): string | null;  // Capture ID before abort
forceCloseSession(): Promise<void>;      // disconnect() + clearSession()
```

### Resume File Discovery

When resuming after an abort or mode change, Happy searches for Codex session transcripts:

```typescript
function findCodexResumeFile(sessionId: string | null): string | null {
    const codexHomeDir = process.env.CODEX_HOME || join(os.homedir(), '.codex');
    const rootDir = join(codexHomeDir, 'sessions');
    // Recursively find files matching `-${sessionId}.jsonl`
    // Return newest match by mtime
}
```

The resume file is then passed as `config.experimental_resume` in the next `startSession`.

---

## 6. CodexSessionConfig

```typescript
interface CodexSessionConfig {
    prompt: string;
    'approval-policy'?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
    'base-instructions'?: string;
    config?: Record<string, any>;        // MCP servers, experimental_resume, etc.
    cwd?: string;
    'include-plan-tool'?: boolean;
    model?: string;
    profile?: string;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}
```

### Field Details

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | `string` | Yes | The user prompt / task description |
| `approval-policy` | enum | No | How Codex handles command approval |
| `base-instructions` | `string` | No | Foundational instructions prepended to session |
| `config` | `Record<string,any>` | No | Arbitrary config; used for `mcp_servers` and `experimental_resume` |
| `cwd` | `string` | No | Working directory for the session |
| `include-plan-tool` | `boolean` | No | Whether to include planning tool |
| `model` | `string` | No | Model override (e.g. `o3-mini`) |
| `profile` | `string` | No | Codex CLI profile name |
| `sandbox` | enum | No | Sandbox level for filesystem access |

### Approval Policy Values

| Value | Behavior |
|---|---|
| `untrusted` | Ask for all non-trusted commands |
| `on-failure` | Auto-run, ask only on failure |
| `on-request` | Let model decide when to ask |
| `never` | Never ask (sandbox enforces safety) |

### Sandbox Values

| Value | Behavior |
|---|---|
| `read-only` | Read-only filesystem |
| `workspace-write` | Can write in workspace directory |
| `danger-full-access` | Full system access |

---

## 7. Sandbox Wrapping Mechanism

Happy uses `@anthropic-ai/sandbox-runtime` (`SandboxManager`) to optionally sandbox Codex in a seatbelt-like environment on macOS/Linux.

### Initialization Flow

```typescript
// In CodexMcpClient.connect():
if (this.sandboxConfig?.enabled) {
    if (process.platform === 'win32') {
        logger.warn('Sandbox not supported on Windows');
    } else {
        this.sandboxCleanup = await initializeSandbox(this.sandboxConfig, process.cwd());
        const wrappedTransport = await wrapForMcpTransport('codex', [mcpCommand]);
        transportCommand = wrappedTransport.command;   // 'sh'
        transportArgs = wrappedTransport.args;         // ['-c', 'wrapped codex mcp-server']
        this.sandboxEnabled = true;
    }
}
```

### Sandbox Manager API (from `src/sandbox/manager.ts`)

```typescript
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';

export async function initializeSandbox(sandboxConfig, sessionPath): Promise<() => Promise<void>> {
    const runtimeConfig = buildSandboxRuntimeConfig(sandboxConfig, sessionPath);
    await SandboxManager.initialize(runtimeConfig);
    return async () => { await SandboxManager.reset(); };
}

export async function wrapForMcpTransport(command, args): Promise<{ command: 'sh'; args: ['-c', string] }> {
    const wrappedCommand = await SandboxManager.wrapWithSandbox(`${command} ${args.join(' ')}`);
    return { command: 'sh', args: ['-c', wrappedCommand] };
}
```

### SandboxConfig Type

```typescript
interface SandboxConfig {
    enabled: boolean;
    workspaceRoot?: string;
    sessionIsolation: 'strict' | 'workspace' | 'custom';
    customWritePaths: string[];
    denyReadPaths: string[];           // Default: ['~/.ssh', '~/.aws', '~/.gnupg']
    extraWritePaths: string[];         // Default: ['/tmp']
    denyWritePaths: string[];          // Default: ['.env']
    networkMode: 'blocked' | 'allowed' | 'custom';
    allowedDomains: string[];
    deniedDomains: string[];
    allowLocalBinding: boolean;
}
```

### CODEX_SANDBOX Environment Flag

When sandbox is active, `CODEX_SANDBOX=seatbelt` is set to disable Codex's proxy auto-discovery that can panic under seatbelt sandboxes:

```typescript
if (this.sandboxEnabled) {
    transportEnv.CODEX_SANDBOX = 'seatbelt';
}
```

### Cleanup on Disconnect

```typescript
async disconnect(): Promise<void> {
    // ... close client/transport ...
    if (this.sandboxCleanup) {
        await this.sandboxCleanup();  // SandboxManager.reset()
        this.sandboxCleanup = null;
    }
    this.sandboxEnabled = false;
}
```

---

## 8. Version Detection

Happy dynamically detects the installed Codex version to choose the correct MCP subcommand.

```typescript
function getCodexMcpCommand(): string | null {
    try {
        const version = execSync('codex --version', { encoding: 'utf8' }).trim();
        const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+(?:-alpha\.\d+)?)/);
        if (!match) return null;

        const versionStr = match[1];
        const [major, minor, patch] = versionStr.split(/[-.]/).map(Number);

        // Version >= 0.43.0-alpha.5 uses 'mcp-server'
        if (major > 0 || minor > 43) return 'mcp-server';
        if (minor === 43 && patch === 0) {
            if (versionStr.includes('-alpha.')) {
                const alphaNum = parseInt(versionStr.split('-alpha.')[1]);
                return alphaNum >= 5 ? 'mcp-server' : 'mcp';
            }
            return 'mcp-server'; // 0.43.0 stable
        }
        return 'mcp'; // Older versions
    } catch (error) {
        return null; // Codex not installed
    }
}
```

**Version → Subcommand mapping**:

| Version | Subcommand |
|---|---|
| `>= 0.43.0-alpha.5` | `codex mcp-server` |
| `< 0.43.0-alpha.5` | `codex mcp` |
| Not installed / unparseable | `null` (error thrown) |

**Error message on null**:

```
Codex CLI not found or not executable.

To install codex:
  npm install -g @openai/codex

Alternatively, use Claude:
  happy claude
```

---

## 9. Timeout Handling

```typescript
const DEFAULT_TIMEOUT = 14 * 24 * 60 * 60 * 1000; // 14 days = 1,209,600,000 ms
```

**Rationale** (from code comment):
> 14 days, which is the half of the maximum possible timeout (~28 days for int32 value in NodeJS)

Node.js `setTimeout` uses a 32-bit signed integer for milliseconds, with max value `2^31 - 1 = 2,147,483,647 ms ~= 24.8 days`. Happy uses half of this as a safe margin.

The timeout is passed to `client.callTool()`:

```typescript
const response = await this.client.callTool({
    name: 'codex',
    arguments: config as any
}, undefined, {
    signal: options?.signal,
    timeout: DEFAULT_TIMEOUT,
});
```

Both `startSession` and `continueSession` use this timeout.

---

## 10. RUST_LOG Environment Filtering

Codex is a Rust binary that uses `RUST_LOG` for log configuration. Happy filters noisy rollout messages:

```typescript
const rolloutListFilter = 'codex_core::rollout::list=off';
const existingRustLog = transportEnv.RUST_LOG?.trim();

if (!existingRustLog) {
    transportEnv.RUST_LOG = rolloutListFilter;
} else if (!existingRustLog.includes('codex_core::rollout::list=')) {
    transportEnv.RUST_LOG = `${existingRustLog},${rolloutListFilter}`;
}
// If already set, don't override
```

**Comment from code**:
> Codex currently logs noisy rollout fallback messages at ERROR level during state-db migration. Keep all other logs intact, only mute this module.

---

## 11. Execution Policy Mapping

The `executionPolicy.ts` maps Happy's `PermissionMode` to Codex's `approval-policy` and `sandbox` settings.

### Special Case: Sandbox Managed by Happy

When Happy manages the sandbox externally, Codex is given full access internally:

```typescript
if (sandboxManagedByHappy) {
    return {
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
    };
}
```

### PermissionMode Mapping Table

| Happy PermissionMode | Codex approval-policy | Codex sandbox |
|---|---|---|
| `default` | `untrusted` | `workspace-write` |
| `read-only` | `never` | `read-only` |
| `safe-yolo` | `on-failure` | `workspace-write` |
| `yolo` | `on-failure` | `danger-full-access` |
| `bypassPermissions` (Claude) | `on-failure` | `danger-full-access` |
| `acceptEdits` (Claude) | `on-request` | `workspace-write` |
| `plan` (Claude) | `untrusted` | `workspace-write` |
| default fallback | `untrusted` | `workspace-write` |

---

## 12. Session Protocol Mapping

The `sessionProtocolMapper.ts` converts Codex MCP events into Happy's unified session protocol envelopes.

### Key Mappings

| Codex Event | Session Envelope |
|---|---|
| `task_started` | `{ t: 'turn-start' }` (creates new turnId) |
| `task_complete` | `{ t: 'turn-end', status }` (clears turnId) |
| `turn_aborted` | `{ t: 'turn-end', status }` (clears turnId) |
| `agent_message` | `{ t: 'text', text }` |
| `agent_reasoning` | `{ t: 'text', text, thinking: true }` |
| `exec_command_begin` | `{ t: 'tool-call-start', name: 'CodexBash', ... }` |
| `exec_approval_request` | `{ t: 'tool-call-start', name: 'CodexBash', ... }` |
| `exec_command_end` | `{ t: 'tool-call-end', call }` |
| `patch_apply_begin` | `{ t: 'tool-call-start', name: 'CodexPatch', ... }` |
| `patch_apply_end` | `{ t: 'tool-call-end', call }` |
| `token_count` | (ignored) |

### Turn End Status Resolution

```typescript
function pickTurnEndStatus(message, type): 'completed' | 'failed' | 'cancelled' {
    // Direct status from message
    if (rawStatus === 'completed' | 'failed' | 'cancelled') return rawStatus;
    if (rawStatus === 'canceled') return 'cancelled'; // normalize spelling

    // turn_aborted defaults to 'cancelled' unless error present
    if (type === 'turn_aborted') {
        if (/(fail|error)/i.test(reason) || error exists) return 'failed';
        return 'cancelled';
    }

    // Error field present → failed
    if (message.error !== undefined && message.error !== null) return 'failed';

    return 'completed';
}
```

---

## 13. Auxiliary Components

### HappyMcpStdioBridge

A minimal STDIO MCP server that bridges to Happy's HTTP MCP server. Used to give Codex access to Happy's tools (currently just `change_title`):

```typescript
const mcpServers = {
    happy: {
        command: bridgeCommand,        // bin/happy-mcp.mjs
        args: ['--url', happyServer.url]
    }
};
// Passed in config.config.mcp_servers to Codex
```

### DiffProcessor

Tracks `turn_diff` events and emits synthetic `CodexDiff` tool call/result pairs when the diff changes:

```typescript
processDiff(unifiedDiff: string): void {
    if (this.previousDiff !== unifiedDiff) {
        // Emit tool-call for CodexDiff
        // Immediately emit tool-call-result
    }
    this.previousDiff = unifiedDiff;
}
```

### ReasoningProcessor

Accumulates `agent_reasoning_delta` tokens into reasoning blocks, emitting `CodexReasoning` tool calls for the session protocol. Extends `BaseReasoningProcessor`.

### Abort vs Kill

Two distinct termination modes:
- **Abort** (`handleAbort`): Stops current inference, keeps session alive. Stores sessionId for potential resume.
- **Kill** (`handleKillSession`): Terminates entire process. Archives session, force-closes transport, exits.

### Keep-Alive

```typescript
session.keepAlive(thinking, 'remote');
const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
}, 2000);  // Every 2 seconds
```

### Disconnect with Force Kill

```typescript
async disconnect(): Promise<void> {
    const pid = this.transport?.pid ?? null;
    try {
        await this.client.close();
    } catch {
        try { await this.transport?.close?.(); } catch {}
    }
    // Last resort: SIGKILL if child still alive
    if (pid) {
        try {
            process.kill(pid, 0); // Check if alive
            process.kill(pid, 'SIGKILL');
        } catch { /* not running */ }
    }
    this.transport = null;
    this.connected = false;
    // Sandbox cleanup...
    // Preserve sessionId for potential reconnection
}
```

---

## 14. Architecture Summary

### Component Diagram

```
┌──────────────────────────────────────────────────────────┐
│                    runCodex.ts (Orchestrator)             │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐   │
│  │ MessageQueue │  │ PermHandler  │  │ ReasoningProc │   │
│  │   (batches)  │  │  (approval)  │  │  (streaming)  │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬────────┘   │
│         │                 │                  │            │
│  ┌──────▼─────────────────▼──────────────────▼────────┐  │
│  │            CodexMcpClient (MCP Wrapper)             │  │
│  │                                                     │  │
│  │  ┌─────────────────┐  ┌──────────────────────────┐  │  │
│  │  │ Client (MCP SDK)│  │ StdioClientTransport     │  │  │
│  │  │ + elicitation   │  │ codex mcp-server         │  │  │
│  │  └─────────────────┘  │ (optionally sandboxed)   │  │  │
│  │                       └──────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌──────────────────┐  ┌─────────────────────────────┐   │
│  │ ExecutionPolicy  │  │ SessionProtocolMapper       │   │
│  │ (mode→policy)    │  │ (events→envelopes)          │   │
│  └──────────────────┘  └─────────────────────────────┘   │
│                                                          │
│  ┌──────────────────┐  ┌─────────────────────────────┐   │
│  │ DiffProcessor    │  │ HappyMcpStdioBridge         │   │
│  │ (turn_diff)      │  │ (change_title proxy)        │   │
│  └──────────────────┘  └─────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Thin MCP wrapper**: `CodexMcpClient` is a stateful but minimal wrapper; all business logic lives in `runCodex.ts`.
2. **Elicitation for permissions**: Uses MCP's standard elicitation protocol, not custom notification/response.
3. **Two-tool simplicity**: `codex` starts, `codex-reply` continues. No complex tool discovery.
4. **Defensive ID extraction**: Multiple extraction strategies for session/conversation IDs handle different Codex versions.
5. **Mode change = new session**: When permission mode changes, the session is cleared and restarted.
6. **Resume via transcript files**: After abort or mode change, the previous session's `.jsonl` transcript is passed to Codex for context recovery.
7. **External sandbox wrapping**: Sandbox is applied at the transport level (wrapping the command), not inside Codex.
8. **Graceful degradation**: Sandbox failure falls back to non-sandboxed execution. Connection errors fall back to offline stub.

### Implications for HappyClaw

1. **MCP Client, not SDK**: Codex integration uses `@modelcontextprotocol/sdk` Client (not Codex's own SDK). HappyClaw should do the same.
2. **Elicitation is required**: The `capabilities: { elicitation: {} }` capability must be declared for permission handling.
3. **Event streaming is notification-based**: Events arrive via `codex/event` notifications, not tool responses. The tool call blocks until the entire turn completes.
4. **Session identity is fragile**: Must extract from multiple locations with snake_case/camelCase fallbacks.
5. **The `config` bag is extensible**: MCP servers and experimental features go in `config: { mcp_servers, experimental_resume }`.
6. **Sandbox is optional and external**: Can be skipped in headless/gateway environments.
7. **Timeout must be very long**: 14-day timeout reflects that tool calls block for the entire turn.

---

*Report generated 2026-02-17 by happy-researcher for the codex-rewrite team.*
