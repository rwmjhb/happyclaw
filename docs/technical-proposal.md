# HappyClaw 技术方案 v2

> OpenClaw PTY Bridge Plugin — 将本机 Claude Code / Codex / Gemini CLI session 桥接到 OpenClaw

## 1. 背景与动机

### 1.1 问题

开发者在电脑上用 Claude Code (`claude`) 或 Codex (`codex`) 进行 AI 辅助开发时，离开工位后无法继续操控正在运行的 session。现有方案：

| 方案 | 缺点 |
|------|------|
| `claude --continue` | 不是接管进程，而是新建进程加载历史，原 session 需手动退出 |
| tmux + exec | 盲发输入，无法解析 AI 输出，体验差 |
| 全程 OpenClaw spawn | 失去本地终端的原生交互体验 |
| Happy Coder App | 需要额外的 Server 和 App，与 OpenClaw 生态割裂 |

### 1.2 目标

构建一个 OpenClaw Plugin，将本机运行中的 AI CLI session 桥接到 OpenClaw 的消息系统，实现：

1. **Session 管理** — 启动、恢复、停止 `claude`/`codex`/`gemini` session
2. **远程交互** — 通过 Telegram/Discord 发送指令、接收结构化输出
3. **事件推送** — 权限确认请求、错误、任务完成等关键事件主动推送
4. **模式切换** — 本地原生体验 / 远程控制模式无缝切换
5. **多工具支持** — Claude Code、Codex、Gemini CLI 按各自最优方式桥接

### 1.3 参考项目

[Happy Coder](https://github.com/slopus/happy)（MIT 协议）—— 实现了类似功能的开源项目。

## 2. Happy Coder 架构分析

### 2.1 核心发现：不是 PTY 桥接，而是 SDK 模式切换

深入分析 Happy Coder 源码后发现，它**没有使用 PTY 捕获终端输出**。实际实现是：

**本地模式（claudeLocal.ts）**：

```typescript
// stdio 直接继承给用户终端，和直接跑 claude 完全一样
const child = spawn('node', [claudeCliPath, ...args], {
  stdio: ['inherit', 'inherit', 'inherit', 'pipe'],  // fd3 用于追踪 thinking 状态
  cwd: opts.path,
});
```

**远程模式（claudeRemote.ts）**：

```typescript
// 使用 Claude Code SDK，结构化 JSON 流交互
const response = query({
  prompt: messages,  // AsyncIterable<SDKUserMessage>
  options: {
    cwd: opts.path,
    resume: startFrom,  // 恢复已有会话
    // --output-format stream-json
    // --input-format stream-json
    // --permission-prompt-tool stdio
  },
});

for await (const message of response) {
  // message.type: 'system' | 'assistant' | 'user' | 'result'
  onMessage(message);  // 结构化数据，无需解析终端输出
}
```

**模式切换（loop.ts）**：

```typescript
while (true) {
  switch (mode) {
    case 'local':
      const result = await claudeLocalLauncher(session);
      if (result.type === 'switch') mode = 'remote';  // 终止本地进程
      break;
    case 'remote':
      const reason = await claudeRemoteLauncher(session);
      if (reason === 'switch') mode = 'local';  // 终止远程进程
      break;
  }
  // 切换时用 --resume <sessionId> 恢复同一个会话
}
```

### 2.2 Happy Coder 的关键设计决策

| 维度 | 设计 | 说明 |
|------|------|------|
| Claude Code 远程交互 | Claude Code SDK | `--output-format stream-json` 结构化输出 |
| 权限处理 | SDK control_request/response | 不是解析 "Allow (y/n)"，而是 SDK 原生协议 |
| Slash 命令 | 拦截转换 | `/compact` `/clear` 在 parsers/specialCommands.ts 中拦截 |
| Codex 远程交互 | MCP 桥接 | codexMcpClient.ts + happyMcpStdioBridge.ts |
| 本地体验 | stdio inherit | 和直接跑 CLI 完全一样 |
| 模式切换 | 终止 + resume | 切换时杀进程，用 `--resume` 在新模式恢复 |

### 2.3 OpenClaw 已有能力对比

| 能力 | Happy Coder | OpenClaw | 差距 |
|------|-------------|----------|------|
| 后台进程管理 | Daemon | Gateway | ✅ 已有 |
| Session 系统 | Session Map | Session 管理 | ✅ 已有 |
| 消息路由 | Socket.IO → App | Telegram/Discord | ✅ 已有 |
| 工具调用 | RPC handlers | exec/read/write tools | ✅ 已有 |
| 加密传输 | E2E AES-256-GCM | 本地运行不需要 | N/A |
| **SDK 模式交互** | Claude SDK + MCP | 无 | ❌ 缺失 |
| **模式切换** | local/remote loop | 无 | ❌ 缺失 |
| **事件推送** | SDK 消息监听 | 无 | ❌ 缺失 |

**结论：OpenClaw 缺的是 SDK/CLI 桥接层 + 模式切换 + 事件推送。**

## 3. HappyClaw 架构设计

### 3.1 设计原则

基于 Happy Coder 源码分析和团队讨论，确定以下原则：

1. **SDK 优先**：对有 SDK 支持的工具（Claude Code），使用 SDK 结构化交互，不做脆弱的终端文本解析
2. **PTY 兜底**：对没有 SDK 的工具（Gemini 等），使用 PTY 桥接作为通用后备
3. **统一抽象**：上层 Plugin tools 不感知底层是 SDK 还是 PTY，通过 Provider 接口统一
4. **本地原生**：本地模式下 stdio inherit，和直接用 CLI 完全一样

### 3.2 总体架构

```
┌──────────────────────────────────────────────────────┐
│                  OpenClaw Gateway                     │
│                                                       │
│  ┌──────────────┐    ┌────────────────────────────┐  │
│  │  Main Agent   │    │    pty-bridge plugin        │  │
│  │  (马斯克等)    │◄──►│                             │  │
│  └──────────────┘    │  ┌────────────────────────┐ │  │
│                      │  │   Plugin Tools Layer    │ │  │
│                      │  │   pty.list / pty.spawn  │ │  │
│                      │  │   pty.send / pty.read   │ │  │
│                      │  │   pty.stop / pty.resume │ │  │
│                      │  └──────────┬─────────────┘ │  │
│                      │             │                │  │
│                      │  ┌──────────▼─────────────┐ │  │
│                      │  │   Session Manager       │ │  │
│                      │  │   (统一管理所有 session)  │ │  │
│                      │  └──────────┬─────────────┘ │  │
│                      │             │                │  │
│                      │  ┌──────────▼─────────────┐ │  │
│                      │  │   Provider Layer        │ │  │
│                      │  │   ┌──────────────────┐  │ │  │
│                      │  │   │ ClaudeSDKProvider │  │ │  │
│                      │  │   │ (SDK stream-json) │  │ │  │
│                      │  │   └──────────────────┘  │ │  │
│                      │  │   ┌──────────────────┐  │ │  │
│                      │  │   │ CodexMCPProvider  │  │ │  │
│                      │  │   │ (MCP bridge)      │  │ │  │
│                      │  │   └──────────────────┘  │ │  │
│                      │  │   ┌──────────────────┐  │ │  │
│                      │  │   │ GenericPTYProvider│  │ │  │
│                      │  │   │ (PTY fallback)    │  │ │  │
│                      │  │   └──────────────────┘  │ │  │
│                      │  └────────────────────────┘ │  │
│                      └────────────────────────────┘  │
│                                                       │
│  Telegram ◄──── 消息路由 ────► Discord                │
└──────────────────────────────────────────────────────┘
         │
         ▼
  ┌──────────────────────┐
  │  本机 CLI 进程          │
  │  ├── claude (SDK/PTY) │
  │  ├── codex  (MCP)     │
  │  └── gemini (PTY)     │
  └──────────────────────┘
```

### 3.3 核心模块

#### 3.3.1 Provider 接口（统一抽象层）

所有 CLI 工具的桥接方式统一为一个 Provider 接口，上层无需关心底层实现。

```typescript
/** Provider 支持的交互模式 */
type SessionMode = 'local' | 'remote';

/** 结构化消息（SDK 原生提供 / PTY 解析后提供） */
interface SessionMessage {
  type: 'text' | 'code' | 'tool_use' | 'tool_result' | 'thinking' | 'error' | 'result';
  content: string;
  metadata?: {
    tool?: string;
    file?: string;
    language?: string;
  };
}

/** 会话事件 */
interface SessionEvent {
  type: 'permission_request' | 'error' | 'waiting_for_input' | 'task_complete' | 'ready';
  severity: 'info' | 'warning' | 'urgent';
  summary: string;
  sessionId: string;
  timestamp: number;
  /** 权限请求的详细信息（SDK 模式下可提供精确的工具名和参数） */
  permissionDetail?: {
    toolName: string;
    input: unknown;
  };
}

/** 统一的 Provider 接口 */
interface SessionProvider {
  readonly name: string;  // 'claude' | 'codex' | 'gemini'
  readonly supportedModes: SessionMode[];

  /** 启动新 session */
  spawn(options: SpawnOptions): Promise<ProviderSession>;

  /** 恢复已有 session */
  resume(sessionId: string, options: SpawnOptions): Promise<ProviderSession>;
}

interface SpawnOptions {
  cwd: string;
  mode: SessionMode;
  args?: string[];
}

/** Provider 创建的 session 实例 */
interface ProviderSession {
  readonly id: string;
  readonly provider: string;
  readonly cwd: string;
  readonly pid: number;
  mode: SessionMode;

  /** 发送用户输入 */
  send(input: string): Promise<void>;

  /** 读取最近消息 */
  read(limit?: number): Promise<SessionMessage[]>;

  /** 切换模式（local ↔ remote） */
  switchMode(target: SessionMode): Promise<void>;

  /** 回复权限请求 */
  respondToPermission(requestId: string, approved: boolean): Promise<void>;

  /** 停止 session */
  stop(force?: boolean): Promise<void>;

  /** 事件监听 */
  onEvent(handler: (event: SessionEvent) => void): void;

  /** 消息监听（远程模式下的实时消息流） */
  onMessage(handler: (message: SessionMessage) => void): void;
}
```

#### 3.3.2 ClaudeSDKProvider

Claude Code 的首选桥接方式，使用官方 SDK 进行结构化交互。

```typescript
class ClaudeSDKProvider implements SessionProvider {
  readonly name = 'claude';
  readonly supportedModes: SessionMode[] = ['local', 'remote'];

  async spawn(options: SpawnOptions): Promise<ProviderSession> {
    if (options.mode === 'local') {
      // 本地模式：stdio inherit，原生体验
      return new ClaudeLocalSession(options);
    } else {
      // 远程模式：SDK stream-json
      return new ClaudeRemoteSession(options);
    }
  }

  async resume(sessionId: string, options: SpawnOptions): Promise<ProviderSession> {
    // 使用 --resume <sessionId> 恢复会话
    return this.spawn({ ...options, args: [...(options.args || []), '--resume', sessionId] });
  }
}
```

**本地模式（ClaudeLocalSession）**：

```typescript
class ClaudeLocalSession implements ProviderSession {
  private child: ChildProcess;

  constructor(options: SpawnOptions) {
    // 和直接跑 claude 完全一样
    this.child = spawn('claude', options.args || [], {
      stdio: ['inherit', 'inherit', 'inherit', 'pipe'],  // fd3 追踪状态
      cwd: options.cwd,
    });
  }

  async switchMode(target: SessionMode): Promise<void> {
    if (target === 'remote') {
      // 终止本地进程，返回 session ID 供远程模式 resume
      this.child.kill('SIGTERM');
    }
  }
  // ...
}
```

**远程模式（ClaudeRemoteSession）**：

```typescript
class ClaudeRemoteSession implements ProviderSession {
  private query: Query;  // Claude Code SDK Query 实例
  private messages: PushableAsyncIterable<SDKUserMessage>;

  constructor(options: SpawnOptions) {
    this.messages = new PushableAsyncIterable();
    this.query = query({
      prompt: this.messages,
      options: {
        cwd: options.cwd,
        resume: options.resumeSessionId,
        permissionMode: 'default',
        canCallTool: (toolName, input, opts) => this.handlePermission(toolName, input, opts),
      },
    });
    this.startListening();
  }

  async send(input: string): Promise<void> {
    // 结构化输入，不是 PTY 文本
    this.messages.push({
      type: 'user',
      message: { role: 'user', content: input },
    });
  }

  private async startListening(): Promise<void> {
    for await (const message of this.query) {
      // SDK 输出已是结构化数据
      if (message.type === 'assistant') {
        this.emitMessage(this.convertSDKMessage(message));
      }
      if (message.type === 'result') {
        this.emitEvent({ type: 'task_complete', ... });
      }
    }
  }

  private async handlePermission(toolName: string, input: unknown, opts: { signal: AbortSignal }): Promise<PermissionResult> {
    // 推送权限请求给远程用户，等待回复
    this.emitEvent({
      type: 'permission_request',
      severity: 'urgent',
      summary: `Claude 想要使用 ${toolName}`,
      permissionDetail: { toolName, input },
    });
    return this.waitForPermissionResponse(opts.signal);
  }
}
```

#### 3.3.3 GenericPTYProvider

通用的 PTY 桥接方案，用于没有专用 SDK 的 CLI 工具。

```typescript
class GenericPTYProvider implements SessionProvider {
  readonly name: string;
  readonly supportedModes: SessionMode[] = ['local', 'remote'];

  constructor(
    name: string,
    private cliPath: string,
    private parserRules: ParserRuleSet,  // 可配置的解析规则
  ) {
    this.name = name;
  }

  async spawn(options: SpawnOptions): Promise<ProviderSession> {
    if (options.mode === 'local') {
      // 本地模式：stdio inherit
      return new PTYLocalSession(this.cliPath, options);
    } else {
      // 远程模式：node-pty 捕获 I/O + 解析
      return new PTYRemoteSession(this.cliPath, options, this.parserRules);
    }
  }
}
```

**PTY 远程模式下的输出解析**：

```typescript
class PTYRemoteSession implements ProviderSession {
  private pty: IPty;
  private terminal: Terminal;  // xterm-headless 终端模拟器
  private outputBuffer: SessionMessage[] = [];

  constructor(cliPath: string, options: SpawnOptions, private rules: ParserRuleSet) {
    this.pty = spawn(cliPath, options.args || [], {
      cwd: options.cwd,
      cols: 200,  // 宽终端减少换行
      rows: 50,
    });
    this.terminal = new Terminal({ cols: 200, rows: 50 });

    this.pty.onData((data) => {
      this.terminal.write(data);
      this.parseAndEmit(data);
    });
  }

  private parseAndEmit(raw: string): void {
    const clean = stripAnsi(raw);
    const parsed = this.rules.parse(clean);
    if (parsed) {
      this.outputBuffer.push(parsed);
      this.emitMessage(parsed);
    }

    // 基于规则检测事件
    const event = this.rules.detectEvent(clean);
    if (event) {
      this.emitEvent(event);
    }
  }
}
```

#### 3.3.4 Session Manager

统一管理所有 Provider 创建的 session。

```typescript
class SessionManager {
  private sessions = new Map<string, ProviderSession>();
  private providers = new Map<string, SessionProvider>();

  registerProvider(provider: SessionProvider): void {
    this.providers.set(provider.name, provider);
  }

  async spawn(providerName: string, options: SpawnOptions): Promise<ProviderSession> {
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`Unknown provider: ${providerName}`);

    const session = await provider.spawn(options);
    this.sessions.set(session.id, session);

    // 监听事件，转发给 OpenClaw 消息系统
    session.onEvent((event) => this.forwardEvent(event));
    session.onMessage((msg) => this.bufferMessage(session.id, msg));

    return session;
  }

  list(filter?: { cwd?: string; provider?: string }): ProviderSession[] {
    let results = Array.from(this.sessions.values());
    if (filter?.cwd) results = results.filter(s => s.cwd === filter.cwd);
    if (filter?.provider) results = results.filter(s => s.provider === filter.provider);
    return results;
  }

  async switchMode(sessionId: string, target: SessionMode): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    // 切换模式：终止当前进程 → resume 新模式
    const oldSession = session;
    const provider = this.providers.get(session.provider)!;

    await oldSession.stop();
    const newSession = await provider.resume(sessionId, {
      cwd: oldSession.cwd,
      mode: target,
    });

    this.sessions.set(sessionId, newSession);
    newSession.onEvent((event) => this.forwardEvent(event));
    newSession.onMessage((msg) => this.bufferMessage(sessionId, msg));
  }
}
```

### 3.4 OpenClaw Plugin 接口

```typescript
const tools = {
  'pty.list': {
    description: '列出本机活跃的 AI CLI sessions',
    parameters: {
      cwd: { type: 'string', description: '按项目目录过滤', optional: true },
      provider: { type: 'string', enum: ['claude', 'codex', 'gemini'], optional: true }
    },
    handler: async ({ cwd, provider }) => {
      const sessions = sessionManager.list({ cwd, provider });
      return sessions.map(s => ({
        id: s.id,
        provider: s.provider,
        cwd: s.cwd,
        mode: s.mode,
        pid: s.pid,
      }));
    }
  },

  'pty.spawn': {
    description: '启动新的 AI CLI session',
    parameters: {
      provider: { type: 'string', enum: ['claude', 'codex', 'gemini'] },
      cwd: { type: 'string', description: '项目目录' },
      mode: { type: 'string', enum: ['local', 'remote'], default: 'local' }
    },
    handler: async ({ provider, cwd, mode }) => sessionManager.spawn(provider, { cwd, mode })
  },

  'pty.resume': {
    description: '恢复已有的 CLI session（使用 --resume 加载会话历史）',
    parameters: {
      sessionId: { type: 'string' },
      mode: { type: 'string', enum: ['local', 'remote'], default: 'remote' }
    },
    handler: async ({ sessionId, mode }) => sessionManager.resume(sessionId, { mode })
  },

  'pty.send': {
    description: '向 CLI session 发送输入',
    parameters: {
      sessionId: { type: 'string' },
      input: { type: 'string' }
    },
    handler: async ({ sessionId, input }) => {
      const session = sessionManager.get(sessionId);
      await session.send(input);
    }
  },

  'pty.read': {
    description: '读取 CLI session 最近输出',
    parameters: {
      sessionId: { type: 'string' },
      limit: { type: 'number', optional: true, default: 50 }
    },
    handler: async ({ sessionId, limit }) => {
      const session = sessionManager.get(sessionId);
      return session.read(limit);
    }
  },

  'pty.respond': {
    description: '回复权限确认请求',
    parameters: {
      sessionId: { type: 'string' },
      requestId: { type: 'string' },
      approved: { type: 'boolean' }
    },
    handler: async ({ sessionId, requestId, approved }) => {
      const session = sessionManager.get(sessionId);
      await session.respondToPermission(requestId, approved);
    }
  },

  'pty.switch': {
    description: '切换 session 的本地/远程模式',
    parameters: {
      sessionId: { type: 'string' },
      mode: { type: 'string', enum: ['local', 'remote'] }
    },
    handler: async ({ sessionId, mode }) => sessionManager.switchMode(sessionId, mode)
  },

  'pty.stop': {
    description: '停止 CLI session',
    parameters: {
      sessionId: { type: 'string' },
      force: { type: 'boolean', optional: true, default: false }
    },
    handler: async ({ sessionId, force }) => {
      const session = sessionManager.get(sessionId);
      await session.stop(force);
    }
  }
};
```

### 3.5 多 Session 选择机制

同一个项目目录下可能同时存在多个 session，Agent 引导用户选择。

**Agent 行为规则**：

- `pty.list` 按 `cwd` 过滤后只有 **1 个 session** → 直接操作
- 有 **多个 session** → 列出摘要（provider、运行时长、当前状态），让用户选择
- 用户指定了 provider（如"看看 codex"）→ 先按 provider 过滤，仍多个才问
- 当前目录 **没有 session** → 提示用户是否要 spawn 新的

**典型交互**：

```
用户（Discord）: "看看 claude 跑到哪了"

Agent 调用: pty.list({ cwd: "~/projects/my-app" })
→ 返回 1 个 claude session

Agent 调用: pty.read(sessionId)
→ 返回结构化消息列表

Agent: Claude 正在实现用户认证模块：
  - ✅ 已完成 src/auth/service.ts
  - 🔧 正在编辑 src/auth/routes.ts
```

### 3.6 Agent MEMORY.md 配置示例

```markdown
## PTY Bridge

本机已安装 pty-bridge 插件，可以管理 Claude Code / Codex / Gemini CLI sessions。

### 使用方式

1. 查看 session：使用 `pty.list` 列出活跃 session（可按 cwd 和 provider 过滤）
2. 多个 session 时：展示列表让用户选择，单个时直接操作
3. 交互：使用 `pty.send` 发送输入，`pty.read` 读取输出
4. 权限确认：收到 permission_request 事件时，使用 `pty.respond` 回复
5. 停止：使用 `pty.stop` 停止 session

### 事件通知

插件会自动检测并推送：
- 权限确认请求（需要用户回复）
- 错误和异常
- AI 等待输入
- 任务完成
```

## 4. 技术方案详解

### 4.1 Claude Code：SDK 模式

**方案**：使用 Claude Code 官方 SDK（`@anthropic-ai/claude-code` 或直接调用 CLI 的 stream-json 模式）。

**本地模式**：

```typescript
// stdio inherit — 用户在本地终端直接和 Claude Code 交互
const child = spawn('claude', args, {
  stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
  cwd,
});

// fd3 管道追踪 thinking 状态
child.stdio[3].on('data', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'fetch-start') emitEvent({ type: 'thinking' });
  if (msg.type === 'fetch-end') emitEvent({ type: 'ready' });
});
```

**远程模式**：

```typescript
// SDK stream-json — 结构化交互
const response = query({
  prompt: userMessages,
  options: {
    cwd,
    resume: sessionId,
    canCallTool: async (toolName, input, { signal }) => {
      // 推送权限请求给远程用户
      emitEvent({
        type: 'permission_request',
        permissionDetail: { toolName, input },
      });
      // 等待远程用户回复
      return waitForResponse(signal);
    },
  },
});
```

**权限处理**（SDK 原生协议，不需要解析文本）：

```
Claude Code → control_request { subtype: 'can_use_tool', tool_name: 'Bash', input: {...} }
           ← control_response { subtype: 'success', response: { behavior: 'allow' } }
```

**Slash 命令处理**：

```typescript
function handleSpecialCommand(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed === '/clear') {
    session.clearSessionId();  // 重置会话
    return true;
  }
  if (trimmed.startsWith('/compact')) {
    // 发给 SDK 处理 context compaction
    messages.push({ type: 'user', message: { role: 'user', content: trimmed } });
    return true;
  }
  return false;  // 不是特殊命令，正常发送
}
```

**模式切换**：

```
本地 → 远程：
  1. 终止本地 Claude Code 进程（SIGTERM）
  2. 以 SDK 模式启动新进程（--resume <sessionId> --output-format stream-json）
  3. 会话上下文通过 Claude Code 的 session 持久化机制恢复

远程 → 本地：
  1. 终止 SDK 模式进程
  2. 以本地模式启动新进程（--resume <sessionId>，stdio inherit）
  3. 用户在终端看到恢复的会话
```

### 4.2 Codex：MCP 桥接（待调研）

参考 Happy Coder 的 `codexMcpClient.ts` + `happyMcpStdioBridge.ts`，通过 MCP（Model Context Protocol）桥接 Codex。

**待 Phase 3 详细设计。**

### 4.3 Gemini / 其他 CLI：PTY 通用桥接

对没有 SDK 的工具，使用 PTY 桥接作为通用方案。

```typescript
class PTYRemoteSession {
  private pty: IPty;
  private rules: ParserRuleSet;

  async send(input: string): Promise<void> {
    this.pty.write(input + '\n');
  }

  async read(limit?: number): Promise<SessionMessage[]> {
    return this.outputBuffer.slice(-(limit || 50));
  }
}
```

PTY 方案的已知限制：
- 输出解析依赖可配置的规则集，可能因 CLI 版本变化而失效
- 权限检测不如 SDK 精确，采用保守策略（宁可多通知）
- 降级模式：解析失败时发送原始文本

### 4.4 输出格式化与推送

无论 SDK 还是 PTY，最终都转换为统一的 `SessionMessage` 格式，再适配到 Telegram/Discord：

```typescript
const MAX_TELEGRAM_LENGTH = 4000;

function formatForTelegram(messages: SessionMessage[]): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const msg of messages) {
    const formatted = formatMessage(msg);
    if (current.length + formatted.length > MAX_TELEGRAM_LENGTH) {
      chunks.push(current);
      current = formatted;
    } else {
      current += formatted;
    }
  }

  if (current) chunks.push(current);

  // 超过 3 段时发摘要
  if (chunks.length > 3) {
    return [summarize(messages), '(发 "查看完整输出" 获取全文)'];
  }
  return chunks;
}

function formatMessage(msg: SessionMessage): string {
  switch (msg.type) {
    case 'code':
      return `\`\`\`${msg.metadata?.language || ''}\n${msg.content}\n\`\`\`\n`;
    case 'tool_use':
      return `🔧 ${msg.metadata?.tool}: ${msg.content}\n`;
    case 'error':
      return `❌ ${msg.content}\n`;
    case 'thinking':
      return `💭 思考中...\n`;
    default:
      return msg.content + '\n';
  }
}
```

## 5. 实现计划

### Phase 1: Claude Code SDK 模式 MVP（3-4 天）

**目标**：通过 OpenClaw 远程操控 Claude Code session

- [ ] 项目脚手架（TypeScript + ESM）
- [ ] SessionProvider 接口定义
- [ ] ClaudeSDKProvider: 远程模式（SDK stream-json 交互）
- [ ] ClaudeSDKProvider: 本地模式（stdio inherit + fd3 追踪）
- [ ] SessionManager: spawn / send / read / list / stop
- [ ] 权限请求推送 + pty.respond 回复
- [ ] OpenClaw Plugin 注册（暴露 tools）
- [ ] 集成测试：Telegram → spawn claude → 交互 → 权限确认 → 读输出

### Phase 2: 模式切换 + 多 Session（2-3 天）

**目标**：支持 local/remote 模式切换和多 session 管理

- [ ] ClaudeSDKProvider: switchMode（local ↔ remote）
- [ ] pty.resume / pty.switch 工具
- [ ] 多 session 管理 + session 选择逻辑
- [ ] Slash 命令拦截处理（/clear, /compact）
- [ ] Session 元数据持久化（~/.happyclaw/sessions.json）
- [ ] 事件推送优化：Telegram inline buttons

### Phase 3: Codex + Gemini 支持（3-4 天）

**目标**：拓展到 Codex 和 Gemini CLI

- [ ] GenericPTYProvider: PTY 桥接基础实现
- [ ] Gemini CLI 解析规则集
- [ ] Codex MCP 桥接方案调研与实现
- [ ] Provider 自动注册（检测本机已安装的 CLI 工具）

### Phase 4: 打磨与优化（2-3 天）

- [ ] 进程健康检查 + 崩溃通知
- [ ] Session 自动清理（超时 / 进程已退出）
- [ ] 安全加固：session owner 绑定、cwd 白名单、审计日志
- [ ] 错误恢复策略
- [ ] 单元测试 + 集成测试完善
- [ ] 文档完善

## 6. 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| 运行时 | Node.js (ESM) | 与 OpenClaw 保持一致 |
| Claude Code 交互 | Claude Code SDK / CLI stream-json | 结构化输入输出 |
| PTY 管理 | `node-pty` | 通用 CLI 桥接后备方案 |
| 终端模拟 | `xterm-headless` | PTY 模式下的终端状态解析 |
| 终端清理 | `strip-ansi` | ANSI 码清理 |
| 类型系统 | TypeScript (strict) | 类型安全 |
| 测试 | Vitest | 轻量快速 |
| 包管理 | pnpm | 高效的依赖管理 |

## 7. 目录结构

```
happyclaw/
├── docs/
│   ├── technical-proposal.md      # 本文档
│   └── archive/                   # 旧版文档归档
├── src/
│   ├── index.ts                   # Plugin 入口
│   ├── plugin.ts                  # OpenClaw Plugin 注册
│   ├── session/
│   │   ├── manager.ts             # Session Manager
│   │   ├── types.ts               # 统一类型定义（Provider, Session, Message, Event）
│   │   └── persistence.ts         # Session 元数据持久化
│   ├── providers/
│   │   ├── provider.ts            # SessionProvider 接口
│   │   ├── claude/
│   │   │   ├── sdk-provider.ts    # ClaudeSDKProvider
│   │   │   ├── local-session.ts   # 本地模式（stdio inherit）
│   │   │   ├── remote-session.ts  # 远程模式（SDK stream-json）
│   │   │   └── commands.ts        # Slash 命令拦截
│   │   ├── codex/
│   │   │   └── mcp-provider.ts    # CodexMCPProvider（Phase 3）
│   │   └── generic/
│   │       ├── pty-provider.ts    # GenericPTYProvider
│   │       ├── pty-session.ts     # PTY 桥接 session
│   │       └── parser-rules.ts   # 可配置的解析规则引擎
│   ├── events/
│   │   └── notifier.ts            # 事件 → OpenClaw 消息路由
│   └── utils/
│       ├── format.ts              # 消息格式化（Telegram/Discord 适配）
│       └── security.ts            # 安全工具（session owner、cwd 校验）
├── tests/
│   ├── providers/
│   │   ├── claude-sdk.test.ts
│   │   └── generic-pty.test.ts
│   ├── session/
│   │   └── manager.test.ts
│   └── integration/
│       └── telegram-flow.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

## 8. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Claude Code SDK API 变更 | 远程模式失效 | 锁定 SDK 版本 + 版本兼容性测试 + 降级到 PTY |
| 模式切换时 --resume 恢复失败 | 会话上下文丢失 | 本地保存 session 元数据，支持从头开始新会话 |
| 模式切换中断正在执行的操作 | 文件修改不完整 | 切换前检查 Claude 是否在执行工具，等待完成后再切换 |
| Codex MCP 桥接方案不成熟 | Codex 支持延迟 | Phase 3 再做，先用 PTY 兜底 |
| node-pty 在 Apple Silicon 编译问题 | PTY 模式安装失败 | prebuild-install + PTY 模式为可选功能 |
| 长时间 session 内存增长 | OOM | 消息缓冲区限制 + 定期清理 |
| OpenClaw Plugin API 变化 | 插件不兼容 | 最小 API 依赖 + 版本跟踪 |

## 9. 与 Happy Coder 的差异

| 维度 | Happy Coder | HappyClaw |
|------|------------|-----------|
| 客户端 | 自建 Expo App + Web App | 复用 Telegram/Discord |
| 服务端 | 自建 Server (Postgres/Redis/S3) | 复用 OpenClaw Gateway |
| 加密 | E2E (AES-256-GCM) | 本地运行，依赖 OpenClaw 安全机制 |
| 用户体系 | 自建（公钥认证） | 复用 OpenClaw 身份系统 |
| 部署 | Docker (Server) + npm (CLI) | pnpm (Plugin only) |
| Claude 远程交互 | Claude Code SDK | Claude Code SDK（相同） |
| Codex 远程交互 | MCP 桥接 | MCP 桥接（参考） |
| 通用 CLI 支持 | 无 | GenericPTYProvider（额外支持） |
| 生态集成 | 独立工具 | OpenClaw 生态（skills, agents, cron）|
| 复杂度 | 高（三个 package） | 中（单 plugin + Provider 抽象） |

**HappyClaw 的优势**：
1. 不需要额外的 Server、App、用户体系——OpenClaw 全都有
2. 通过 GenericPTYProvider 额外支持没有 SDK 的 CLI 工具
3. 作为 OpenClaw Plugin，天然融入现有的 Agent 生态
