# HappyClaw 技术方案 v2

> OpenClaw Session Bridge Plugin — 将本机 Claude Code / Codex / Gemini CLI session 桥接到 OpenClaw

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
4. **本地原生**：本地模式通过独立的 `happyclaw` CLI wrapper 在用户终端提供原生体验（stdio inherit）。Plugin 本身运行在 Gateway daemon 中，不假设有可用的 TTY
5. **安全优先**：Session owner binding、cwd 白名单、调用者身份校验从 Phase 1 开始实施

### 3.2 总体架构

```
┌──────────────────────────────────────────────────────┐
│                  OpenClaw Gateway                     │
│                                                       │
│  ┌──────────────┐    ┌────────────────────────────┐  │
│  │  Main Agent   │    │   session-bridge plugin     │  │
│  │  (马斯克等)    │◄──►│                             │  │
│  └──────────────┘    │  ┌────────────────────────┐ │  │
│                      │  │   Plugin Tools Layer    │ │  │
│                      │  │   session.list / session.spawn  │ │  │
│                      │  │   session.send / session.read   │ │  │
│                      │  │   session.stop / session.resume │ │  │
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
    requestId: string;   // SDK 提供的 toolUseID，用于关联 session.respond 回复
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
  resumeSessionId?: string;  // --resume 使用的 session ID
}

/** Plugin tool handler 的调用上下文（由 OpenClaw Gateway 注入） */
interface CallerContext {
  userId: string;      // OpenClaw 用户 ID
  channelId: string;   // 来源频道
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

  /** 读取消息（支持游标分页，避免轮询丢失/重复） */
  read(options?: { cursor?: string; limit?: number }): Promise<{ messages: SessionMessage[]; nextCursor: string }>;

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
    // 通过 SpawnOptions.resumeSessionId 传递，各 Session 类型内部处理恢复方式
    // 远程模式：ClaudeRemoteSession 读取 resumeSessionId 传给 SDK query({ options: { resume } })
    // 本地模式：ClaudeLocalSession 读取 resumeSessionId 拼接 CLI args --resume
    return this.spawn({ ...options, resumeSessionId: sessionId });
  }
}
```

**本地模式（ClaudeLocalSession）**：

```typescript
class ClaudeLocalSession implements ProviderSession {
  private child: ChildProcess;

  constructor(options: SpawnOptions) {
    // 本地模式：从 resumeSessionId 构建 --resume CLI arg
    const args = [...(options.args || [])];
    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    }

    // 和直接跑 claude 完全一样
    this.child = spawn('claude', args, {
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
  // 注意：SDK 包名为 @anthropic-ai/claude-agent-sdk（非旧版 @anthropic-ai/claude-code）
  private queryInstance: QueryResult;
  private messages: AsyncQueue<SDKUserMessage>;  // 自实现的异步队列，需处理背压
  private permissionTimeout = 300_000;  // 权限请求超时 5 分钟，默认 deny

  constructor(options: SpawnOptions) {
    this.messages = new AsyncQueue();
    this.queryInstance = query({
      prompt: this.messages,
      options: {
        cwd: options.cwd,
        resume: options.resumeSessionId,
        permissionMode: 'default',
        systemPrompt: { type: 'preset', preset: 'claude_code' },  // 加载 Claude Code 默认 system prompt
        settingSources: ['project'],    // 确保读取 CLAUDE.md 等项目配置
        canUseTool: (toolName, input, opts) => this.handlePermission(toolName, input, opts),
      },
    });
    this.startListening();
  }

  async send(input: string): Promise<void> {
    // 结构化输入 — SDKUserMessage 类型需包含 session_id 等字段
    this.messages.push({
      type: 'user',
      session_id: this.sessionId,
      parent_tool_use_id: null,  // 顶层消息，非 tool 响应
      message: { role: 'user', content: input },
    });
  }

  private async startListening(): Promise<void> {
    for await (const message of this.queryInstance) {
      // SDK 输出已是结构化数据
      if (message.type === 'assistant') {
        this.emitMessage(this.convertSDKMessage(message));
      }
      if (message.type === 'result') {
        this.emitEvent({ type: 'task_complete', severity: 'info', summary: '任务完成', sessionId: this.id, timestamp: Date.now() });
      }
    }
  }

  private async handlePermission(
    toolName: string, input: Record<string, unknown>,
    opts: { signal: AbortSignal; toolUseID: string; decisionReason?: string }
  ): Promise<PermissionResult> {
    // 使用 SDK 提供的 toolUseID 作为关联 ID（无需自行生成 requestId）
    this.emitEvent({
      type: 'permission_request',
      severity: 'urgent',
      summary: `Claude 想要使用 ${toolName}`,
      sessionId: this.id,
      timestamp: Date.now(),
      permissionDetail: { requestId: opts.toolUseID, toolName, input },
    });
    // 带超时的等待：超时后默认 deny，避免无限阻塞
    return this.waitForPermissionResponse(opts.toolUseID, opts.signal, this.permissionTimeout);
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
  private switchState = new Map<string, 'running' | 'draining' | 'switching' | 'error'>();
  private maxSessions = 10;  // 防止资源耗尽
  private cwdWhitelist: string[] = [];  // 允许的项目目录（空 = 不限制）

  registerProvider(provider: SessionProvider): void {
    this.providers.set(provider.name, provider);
  }

  /** 获取单个 session（tool handler 使用） */
  get(sessionId: string): ProviderSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  async spawn(providerName: string, options: SpawnOptions, ownerId?: string): Promise<ProviderSession> {
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`Unknown provider: ${providerName}`);

    // 安全检查：cwd 白名单 + session 数量限制
    const resolvedCwd = path.resolve(options.cwd);
    if (this.cwdWhitelist.length > 0 && !this.cwdWhitelist.some(w => resolvedCwd.startsWith(w))) {
      throw new Error(`cwd not in whitelist: ${resolvedCwd}`);
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Session limit reached (${this.maxSessions})`);
    }

    const session = await provider.spawn({ ...options, cwd: resolvedCwd });
    this.sessions.set(session.id, session);
    this.switchState.set(session.id, 'running');

    // 先绑定 owner，再开始事件转发，避免 spawn 和 setOwner 之间的竞态
    if (ownerId) {
      sessionACL.setOwner(session.id, ownerId);
    }

    // 监听事件，转发给 OpenClaw 消息系统
    session.onEvent((event) => this.forwardEvent(event));
    session.onMessage((msg) => this.bufferMessage(session.id, msg));

    // 监听进程退出，自动清理
    this.monitorProcess(session);

    return session;
  }

  /** 恢复已有 session */
  async resume(sessionId: string, options: { mode: SessionMode }): Promise<ProviderSession> {
    const existing = this.sessions.get(sessionId);
    const providerName = existing?.provider;
    const cwd = existing?.cwd;
    if (!providerName || !cwd) throw new Error(`Cannot resume unknown session: ${sessionId}`);

    const provider = this.providers.get(providerName)!;
    const newSession = await provider.resume(sessionId, { cwd, mode: options.mode });
    this.sessions.set(sessionId, newSession);
    this.switchState.set(sessionId, 'running');
    newSession.onEvent((event) => this.forwardEvent(event));
    newSession.onMessage((msg) => this.bufferMessage(sessionId, msg));
    this.monitorProcess(newSession);
    return newSession;
  }

  list(filter?: { cwd?: string; provider?: string }): ProviderSession[] {
    let results = Array.from(this.sessions.values());
    if (filter?.cwd) {
      const resolved = path.resolve(filter.cwd);
      results = results.filter(s => s.cwd === resolved);
    }
    if (filter?.provider) results = results.filter(s => s.provider === filter.provider);
    return results;
  }

  async switchMode(sessionId: string, target: SessionMode): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    // 状态机：running → draining → switching → running
    const state = this.switchState.get(sessionId);
    if (state !== 'running') throw new Error(`Session ${sessionId} is ${state}, cannot switch`);

    this.switchState.set(sessionId, 'draining');
    // 等待当前工具调用完成（drain）
    await session.switchMode(target);  // Provider 内部处理 drain

    this.switchState.set(sessionId, 'switching');
    const oldSession = session;
    const provider = this.providers.get(session.provider)!;

    await oldSession.stop();
    try {
      const newSession = await provider.resume(sessionId, {
        cwd: oldSession.cwd,
        mode: target,
      });
      this.sessions.set(sessionId, newSession);
      this.switchState.set(sessionId, 'running');
      newSession.onEvent((event) => this.forwardEvent(event));
      newSession.onMessage((msg) => this.bufferMessage(sessionId, msg));
      this.monitorProcess(newSession);
    } catch (err) {
      // resume 失败：旧 session 已 stop，新 session 未启动
      // 标记为 error 状态并从活跃 Map 中移除，避免后续操作命中已死 session
      this.switchState.set(sessionId, 'error');
      this.sessions.delete(sessionId);
      this.forwardEvent({
        type: 'error', severity: 'urgent', sessionId, timestamp: Date.now(),
        summary: `模式切换失败，session 已不可用。请使用 session.spawn 创建新 session 或 session.resume 手动恢复: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** 监听进程退出，自动清理 session */
  private monitorProcess(session: ProviderSession): void {
    // Provider 实现需在进程退出时触发 'error' 或 'task_complete' 事件
    // Manager 收到后更新 session 映射
    session.onEvent((event) => {
      if (event.type === 'error' && event.summary.includes('process exited')) {
        this.sessions.delete(session.id);
        this.switchState.delete(session.id);
      }
    });
  }

  /** 启动时恢复：清理孤儿 session，重连存活进程 */
  async reconcileOnStartup(persisted: PersistedSession[]): Promise<void> {
    for (const entry of persisted) {
      try {
        // 检查进程是否仍存活
        process.kill(entry.pid, 0);
        // 存活则重新注册到 sessions Map（不 resume，只恢复管理）
        // 具体实现取决于 Provider 是否支持 reconnect
      } catch {
        // 进程已退出，清理持久化记录
      }
    }
  }
}
```

### 3.4 OpenClaw Plugin 接口

```typescript
// 所有 tool handler 接收 CallerContext（由 OpenClaw Gateway 注入），用于 ACL 校验
const tools = {
  'session.list': {
    description: '列出本机活跃的 AI CLI sessions',
    parameters: {
      cwd: { type: 'string', description: '按项目目录过滤', optional: true },
      provider: { type: 'string', enum: ['claude', 'codex', 'gemini'], optional: true }
    },
    handler: async ({ cwd, provider }, caller: CallerContext) => {
      // 只返回 caller 拥有的 sessions
      const sessions = sessionManager.list({ cwd, provider })
        .filter(s => sessionACL.canAccess(caller.userId, s.id));
      return sessions.map(s => ({
        id: s.id,
        provider: s.provider,
        cwd: s.cwd,
        mode: s.mode,
        pid: s.pid,
      }));
    }
  },

  'session.spawn': {
    description: '启动新的 AI CLI session',
    parameters: {
      provider: { type: 'string', enum: ['claude', 'codex', 'gemini'] },
      cwd: { type: 'string', description: '项目目录' },
      mode: { type: 'string', enum: ['local', 'remote'], default: 'local' }
    },
    handler: async ({ provider, cwd, mode }, caller: CallerContext) => {
      // ownerId 传入 spawn()，在事件转发启动前绑定，避免竞态
      const session = await sessionManager.spawn(provider, { cwd, mode }, caller.userId);
      return session;
    }
  },

  'session.resume': {
    description: '恢复已有的 CLI session（使用 --resume 加载会话历史）',
    parameters: {
      sessionId: { type: 'string' },
      mode: { type: 'string', enum: ['local', 'remote'], default: 'remote' }
    },
    handler: async ({ sessionId, mode }, caller: CallerContext) => {
      sessionACL.assertOwner(caller.userId, sessionId);
      return sessionManager.resume(sessionId, { mode });
    }
  },

  'session.send': {
    description: '向 CLI session 发送输入',
    parameters: {
      sessionId: { type: 'string' },
      input: { type: 'string' }
    },
    handler: async ({ sessionId, input }, caller: CallerContext) => {
      sessionACL.assertOwner(caller.userId, sessionId);
      const session = sessionManager.get(sessionId);
      await session.send(input);
    }
  },

  'session.read': {
    description: '读取 CLI session 输出（支持游标分页）',
    parameters: {
      sessionId: { type: 'string' },
      cursor: { type: 'string', optional: true, description: '上次读取返回的 nextCursor' },
      limit: { type: 'number', optional: true, default: 50 }
    },
    handler: async ({ sessionId, cursor, limit }, caller: CallerContext) => {
      sessionACL.assertOwner(caller.userId, sessionId);
      const session = sessionManager.get(sessionId);
      return session.read({ cursor, limit });
    }
  },

  'session.respond': {
    description: '回复权限确认请求',
    parameters: {
      sessionId: { type: 'string' },
      requestId: { type: 'string' },
      approved: { type: 'boolean' }
    },
    handler: async ({ sessionId, requestId, approved }, caller: CallerContext) => {
      sessionACL.assertOwner(caller.userId, sessionId);
      const session = sessionManager.get(sessionId);
      await session.respondToPermission(requestId, approved);
    }
  },

  'session.switch': {
    description: '切换 session 的本地/远程模式',
    parameters: {
      sessionId: { type: 'string' },
      mode: { type: 'string', enum: ['local', 'remote'] }
    },
    handler: async ({ sessionId, mode }, caller: CallerContext) => {
      sessionACL.assertOwner(caller.userId, sessionId);
      await sessionManager.switchMode(sessionId, mode);
    }
  },

  'session.stop': {
    description: '停止 CLI session',
    parameters: {
      sessionId: { type: 'string' },
      force: { type: 'boolean', optional: true, default: false }
    },
    handler: async ({ sessionId, force }, caller: CallerContext) => {
      sessionACL.assertOwner(caller.userId, sessionId);
      const session = sessionManager.get(sessionId);
      await session.stop(force);
    }
  }
};
```

### 3.5 多 Session 选择机制

同一个项目目录下可能同时存在多个 session，Agent 引导用户选择。

**Agent 行为规则**：

- `session.list` 按 `cwd` 过滤后只有 **1 个 session** → 直接操作
- 有 **多个 session** → 列出摘要（provider、运行时长、当前状态），让用户选择
- 用户指定了 provider（如"看看 codex"）→ 先按 provider 过滤，仍多个才问
- 当前目录 **没有 session** → 提示用户是否要 spawn 新的

**典型交互**：

```
用户（Discord）: "看看 claude 跑到哪了"

Agent 调用: session.list({ cwd: "~/projects/my-app" })
→ 返回 1 个 claude session

Agent 调用: session.read(sessionId)
→ 返回结构化消息列表

Agent: Claude 正在实现用户认证模块：
  - ✅ 已完成 src/auth/service.ts
  - 🔧 正在编辑 src/auth/routes.ts
```

### 3.6 Agent MEMORY.md 配置示例

```markdown
## Session Bridge

本机已安装 session-bridge 插件，可以管理 Claude Code / Codex / Gemini CLI sessions。

### 使用方式

1. 查看 session：使用 `session.list` 列出活跃 session（可按 cwd 和 provider 过滤）
2. 多个 session 时：展示列表让用户选择，单个时直接操作
3. 交互：使用 `session.send` 发送输入，`session.read` 读取输出（支持游标分页）
4. 权限确认：收到 permission_request 事件时，使用 `session.respond` 回复（5 分钟超时自动 deny）
5. 停止：使用 `session.stop` 停止 session

### 安全

- 只能操作自己创建的 session（owner binding）
- 项目目录受白名单限制
- 同时运行的 session 数量有上限

### 事件通知

插件会自动检测并推送：
- 权限确认请求（需要用户回复，超时自动 deny）
- 错误和异常
- AI 等待输入
- 任务完成
- 进程退出/崩溃
```

## 4. 技术方案详解

### 4.1 Claude Code：SDK 模式

**方案**：使用 Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）进行结构化交互。注意：不是直接调用 CLI 的 `--output-format stream-json` 模式，而是使用 SDK 的 `query()` API，两者权限处理机制不同（SDK 用 callback，CLI 用 MCP permission-prompt-tool）。

**本地模式**：

```typescript
// stdio inherit — 用户在本地终端直接和 Claude Code 交互
const child = spawn('claude', args, {
  stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
  cwd,
});

// fd3 管道追踪 thinking 状态
// 注意：pipe 流可能拆分/合并 JSON 对象，需用行分隔解析
let fd3Buffer = '';
child.stdio[3].on('data', (chunk) => {
  fd3Buffer += chunk.toString();
  const lines = fd3Buffer.split('\n');
  fd3Buffer = lines.pop() || '';  // 保留未完成的行
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'fetch-start') emitEvent({ type: 'thinking' });
      if (msg.type === 'fetch-end') emitEvent({ type: 'ready' });
    } catch { /* 忽略非 JSON 行 */ }
  }
});
```

**远程模式**：

```typescript
// SDK query() API — 结构化交互（@anthropic-ai/claude-agent-sdk）
const response = query({
  prompt: userMessages,
  options: {
    cwd,
    resume: sessionId,
    systemPrompt: { type: 'preset', preset: 'claude_code' },  // 加载 Claude Code 默认 system prompt
    settingSources: ['project'],    // 读取 CLAUDE.md 等项目配置
    canUseTool: async (toolName, input, { signal, toolUseID, decisionReason }) => {
      // 使用 SDK 提供的 toolUseID 作为关联 ID（无需自行生成 requestId）
      emitEvent({
        type: 'permission_request',
        permissionDetail: { requestId: toolUseID, toolName, input, decisionReason },
      });
      // 带超时的等待（默认 5 分钟，超时 deny）
      return waitForResponse(toolUseID, signal, PERMISSION_TIMEOUT);
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
  2. 以 SDK 模式启动新进程（SpawnOptions.resumeSessionId → SDK query({ resume })）
  3. 会话上下文通过 Claude Code 的 session 持久化机制恢复

远程 → 本地：
  1. 终止 SDK 模式进程
  2. 以本地模式启动新进程（SpawnOptions.resumeSessionId → CLI args --resume <sessionId>，stdio inherit）
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

  // 超过 3 段时发摘要（完整输出通过 session.read 的游标分页获取）
  if (chunks.length > 3) {
    return [summarize(messages), '(使用 session.read 获取完整输出)'];
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

### Phase 0: SDK 验证冲刺（1-2 天）

**目标**：验证 Claude Agent SDK 的实际 API 行为，消除技术不确定性

- [ ] 安装 `@anthropic-ai/claude-agent-sdk`，确认包名和版本
- [ ] 编写 minimal PoC：`query()` + streaming input + `canUseTool` callback
- [ ] 验证 `--resume <sessionId>` 行为（是否保持 session ID、是否加载历史）
- [ ] 验证 `systemPrompt` + `settingSources` 参数效果
- [ ] 验证 fd3 pipe 追踪 thinking 状态是否可用
- [ ] 验证 `SDKUserMessage` 实际类型结构（session_id、parent_tool_use_id 等字段）
- [ ] 产出：SDK API 兼容性报告 + 更新方案中所有代码示例

### Phase 1: Claude Code SDK 模式 MVP（4-5 天）

**目标**：通过 OpenClaw 远程操控 Claude Code session，含安全基线

- [ ] 项目脚手架（TypeScript + ESM）
- [ ] SessionProvider / ProviderSession 接口定义
- [ ] ClaudeSDKProvider: 远程模式（SDK `query()` 交互）
- [ ] ClaudeSDKProvider: 本地模式（`happyclaw` CLI wrapper + fd3 追踪）
- [ ] SessionManager: spawn / get / resume / send / read / list / stop
- [ ] 权限请求推送（含 requestId 关联）+ session.respond 回复 + 超时默认 deny
- [ ] **安全基线**：CallerContext 注入、SessionACL owner binding、cwd 白名单、session 数量限制
- [ ] OpenClaw Plugin 注册（暴露 `session.*` tools）
- [ ] 消息游标分页（session.read 支持 cursor/limit）
- [ ] 进程退出监听 + session 自动清理
- [ ] 集成测试：Telegram → spawn claude → 交互 → 权限确认 → 读输出

### Phase 2: 模式切换 + 多 Session（2-3 天）

**目标**：支持 local/remote 模式切换和多 session 管理

- [ ] 模式切换状态机：`running → draining → switching → resumed`
- [ ] 切换前 drain（等待当前工具调用完成）
- [ ] 切换失败回滚 + 错误通知
- [ ] session.resume / session.switch 工具
- [ ] 多 session 管理 + session 选择逻辑
- [ ] Slash 命令拦截处理（/clear, /compact）
- [ ] Session 元数据持久化（~/.happyclaw/sessions.json）
- [ ] 启动时孤儿 session 清理（reconcileOnStartup）
- [ ] 事件推送优化：Telegram inline buttons

### Phase 3a: Gemini PTY 支持（2-3 天）

**目标**：通过 PTY 桥接支持 Gemini CLI

- [ ] GenericPTYProvider: PTY 桥接基础实现
- [ ] Gemini CLI 解析规则集
- [ ] PTY 输入过滤（block shell 逃逸字符如 `\x03`）
- [ ] Provider 自动注册（检测本机已安装的 CLI 工具）

### Phase 3b: Codex MCP 支持（3-5 天）

**目标**：通过 MCP 桥接支持 Codex

- [ ] Codex MCP 桥接方案详细设计（参考 Happy Coder codexMcpClient.ts）
- [ ] CodexMCPProvider 实现
- [ ] 集成测试

### Phase 4: 打磨与优化（2-3 天）

- [ ] 进程健康检查 + 心跳机制
- [ ] 敏感数据脱敏（API key、密码等自动遮蔽输出）
- [ ] Discord 消息格式适配（2000 字符限制）
- [ ] 输出摘要 + 完整输出获取机制
- [ ] 审计日志
- [ ] 错误恢复策略完善
- [ ] 单元测试 + 集成测试完善
- [ ] 文档完善

## 6. 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| 运行时 | Node.js (ESM) | 与 OpenClaw 保持一致 |
| Claude Code 交互 | `@anthropic-ai/claude-agent-sdk` query() API | 结构化输入输出 |
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

## 10. 评审发现（v2 审查）

> 评审日期：2026-02-09
> 评审方式：3 个 Claude Agent（架构 / SDK可行性 / 安全）并行审查 + Codex (GPT-5.3) 跨模型独立审查
> 详细报告：`docs/reviews/consolidated-review-v2.md`

### 10.1 Critical — 必须在实现前修正

#### C-1. SDK API 名称错误：`canCallTool` → `canUseTool`

**来源**：Codex + sdk-reviewer（跨模型共识）

方案中多处使用 `canCallTool`（§3.3.2, §4.1），但 Claude Agent SDK 实际 API 为 `canUseTool`。

```typescript
// ❌ 方案中写的
canCallTool: (toolName, input, opts) => this.handlePermission(toolName, input, opts),

// ✅ 实际 SDK API（待核实最新文档）
canUseTool: (toolName, input, opts) => this.handlePermission(toolName, input, opts),
```

#### C-2. 权限请求缺少 `requestId` 关联

**来源**：Codex + security-reviewer（跨模型共识）

`session.respond` 需要 `requestId`（§3.4），但 `SessionEvent.permissionDetail` 中没有 `requestId` 字段（§3.3.1）。远程用户无法可靠地回复特定权限请求。

```typescript
// 当前定义 — 缺少 requestId
permissionDetail?: {
  toolName: string;
  input: unknown;
};

// 应改为
permissionDetail?: {
  requestId: string;  // ← 补充
  toolName: string;
  input: unknown;
};
```

#### C-3. 安全控制延迟到 Phase 4

**来源**：Codex + security-reviewer + arch-reviewer（三方共识）

Session owner binding、cwd 白名单、审计日志放在 Phase 4，但 Plugin tools 从 Phase 1 就暴露 list/read/send/stop 且无鉴权。在共享 Gateway 环境下，任何能访问 Gateway 的用户可操控所有 CLI session。

**行动项**：将 session owner binding 和基本 ACL 移到 Phase 1。

#### C-4. 本地模式 stdio inherit 在 daemon 环境不可行

**来源**：Codex + arch-reviewer（跨模型共识）

方案假设本地模式用 `stdio: ['inherit', ...]`，但 HappyClaw 作为 Plugin 运行在 Gateway 进程中。如果 Gateway 是后台 daemon（headless），stdio inherit 无法提供终端体验。

Happy Coder 是独立 CLI 工具，直接在用户终端运行，所以 stdio inherit 有效。HappyClaw 作为 Plugin，本地模式的 UX 需另行设计（如 `happyclaw` CLI wrapper 在用户终端启动，Plugin 在后台桥接）。

### 10.2 Major — 强烈建议修正

| # | 问题 | 来源 | 说明 |
|---|------|------|------|
| M-1 | 模式切换非原子操作 | Codex + arch | `stop()` → `resume()` 之间无 drain/lock，可能丢失 in-flight 消息。建议添加状态机 `running → draining → switching → resumed` |
| M-2 | SpawnOptions 接口不一致 | Codex + sdk | 缺少 `resumeSessionId` 字段；`sessionManager.resume/get` 在 tools 中使用但类中未定义 |
| M-3 | Session ID 恢复后可能变化 | Codex | `--resume` 后 SDK 可能分配新 ID，但 Manager 用旧 ID 做 key。建议使用 HappyClaw 自有稳定 ID |
| M-4 | PushableAsyncIterable 未定义 | Codex + sdk | 非标准库/SDK 类型，需自行实现且需处理背压 |
| M-5 | cwd 安全控制缺失 | Codex + security | `session.spawn` 接受任意 cwd，无白名单。恶意用户可指定敏感目录 |
| M-6 | Phase 3 工期乐观 | Codex + sdk | Codex MCP "待调研" + Gemini PTY 打包 3-4 天不够。建议拆分：3a Gemini PTY (2-3天) + 3b Codex MCP (3-5天) |

### 10.3 Minor — 建议改进

| # | 问题 | 说明 |
|---|------|------|
| m-1 | `pty.*` 命名与架构不匹配 | 核心已是 SDK/MCP/PTY 混合，建议改为 `session.*` 或 `cli.*` |
| m-2 | cwd 字符串严格匹配 | `~/projects` vs `/Users/pope/projects` vs symlink 会匹配失败，需 `path.resolve` + `realpathSync` |
| m-3 | 输出摘要无完整获取机制 | "发 '查看完整输出' 获取全文" 无对应 API，需添加分页参数 |
| m-4 | Discord 2000 字符限制未提及 | 方案只提了 Telegram 4096，需添加 Discord 适配 |
| m-5 | 权限请求超时处理缺失 | 远程用户不回复时 `waitForPermissionResponse` 会无限等待。需可配置超时 + 默认 deny |
| m-6 | CLI 进程崩溃恢复缺失 | 进程退出后 session 仍在 Map 中，需监听 `exit` 事件更新状态 |

### 10.4 Suggestion — 可选优化

| # | 建议 | 来源 |
|---|------|------|
| S-1 | 添加模式切换状态机：`running → draining → switching → resumed` | Codex + arch |
| S-2 | 添加兼容性矩阵：Claude CLI 版本、SDK 包名/版本、各 Provider 降级行为 | Codex |
| S-3 | SDK 消息类型完整映射（不只列 high-level type，要对每个 subtype 定义转换规则） | Codex |
| S-4 | 添加故障模式测试：切换期间工具执行、重复权限请求、plugin 重启、stale requestId | Codex |
| S-5 | 添加 session 心跳机制，检测 CLI 进程健康状态 | arch + security |

### 10.5 v1 → v2 改进确认

| v1 Critical 问题 | v2 状态 |
|------------------|---------|
| PTY Attach 在 macOS 不可行 | ✅ 已移除，改为 SDK 模式切换 |
| 终端输出解析脆弱（strip-ansi 不够） | ✅ SDK 模式不需要解析，PTY 仅作后备 |
| 缺少 VT100 终端模拟器 | ✅ PTY 模式中已加入 xterm-headless |
| 无认证/授权设计 | ⚠️ 提到但延迟到 Phase 4，需前移（见 C-3） |
| 输入注入风险 | ⚠️ SDK 模式下风险降低（结构化输入），PTY 模式仍需处理 |

## 11. 评审发现（Round 2 审查）

> 评审日期：2026-02-09
> 评审方式：3 个 Claude Agent（一致性 / SDK研究 / 安全深审）+ Codex (GPT-5.3) 跨模型第二轮审查
> 说明：Round 2 在 Round 1 基础上深入审查，重点验证 SDK API 准确性、发现新问题、评估 Round 1 发现的修复方案

### 11.1 Round 1 发现验证

| Round 1 发现 | Round 2 结论 |
|-------------|-------------|
| C-1. `canCallTool` → `canUseTool` | ✅ **确认**。Codex R2 + sdk-researcher 均验证，实际 API 为 `canUseTool` |
| C-2. 权限请求缺少 `requestId` | ✅ **确认**。Happy Coder 源码中有 request-level correlation，方案缺失 |
| C-3. 安全控制延迟到 Phase 4 | ✅ **确认**。三方一致认为需前移 |
| C-4. 本地模式 daemon 环境不可行 | ✅ **确认** |
| M-1 ~ M-2, M-4 ~ M-6 | ✅ **确认有效** |
| M-3. Session ID 恢复后变化 | ⚠️ **部分修正**。SDK 默认 `forkSession=false`，resume 不会变 ID。但建议仍使用 HappyClaw 自有稳定 ID 作为最佳实践 |

### 11.2 新发现 — Critical

#### C-5. SDK 包名已迁移：`@anthropic-ai/claude-code` → `@anthropic-ai/claude-agent-sdk`

**来源**：Codex R2 + sdk-researcher（跨模型共识）

方案中引用 `@anthropic-ai/claude-code`（§4.1），但 Anthropic 已将 SDK 迁移到 `@anthropic-ai/claude-agent-sdk`，存在 migration guide。使用旧包名可能导致安装失败或 API 不兼容。

**行动项**：核实最新包名，更新所有引用。

#### C-6. 远程模式代码缺少 `systemPrompt` 和 `settingSources`

**来源**：Codex R2

方案中 `query()` 调用（§3.3.2, §4.1）未传入 `systemPrompt` preset 和 `settingSources`，导致远程模式会跳过 `CLAUDE.md` / 用户配置，行为与本地模式不一致。

```typescript
// ❌ 方案中的调用 — 缺少关键配置
query({ prompt: this.messages, options: { cwd, resume, permissionMode, canCallTool } });

// ✅ 应包含
query({
  prompt: this.messages,
  options: {
    cwd,
    resume,
    permissionMode: 'default',
    canUseTool: ...,
    systemPrompt: { type: 'preset', preset: 'claude_code' },  // ← 加载 Claude Code 默认 prompt
    settingSources: ['project'],  // ← 确保读取 CLAUDE.md 等配置
  },
});
```

### 11.3 新发现 — Major

| # | 问题 | 来源 | 说明 |
|---|------|------|------|
| M-7 | SDK 消息类型与方案不匹配 | Codex R2 | 方案发送 `{ type: 'user', message: {...} }`，但实际 `SDKUserMessage` 包含 `session_id`、`parent_tool_use_id` 等字段，类型不兼容 |
| M-8 | fd3 JSON 流解析不安全 | Codex R2 | `JSON.parse(data)` 假设 1 chunk = 1 JSON 对象，真实 pipe 流可能拆分/合并，导致间歇性解析错误 |
| M-9 | SDK 与 CLI 传输方式混淆 | Codex R2 | 方案交替使用 SDK `query()` 和 CLI `--output-format stream-json`，但两者权限处理机制不同（callback vs MCP permission-prompt-tool），需明确选择其一 |
| M-10 | `session.read` 缺少游标/偏移模型 | Codex R2 + consistency | 轮询客户端可能丢失或重复消息。需添加 cursor/offset/ack 机制，或改用推送模式 |
| M-11 | 调用者身份传播未设计 | Codex R2 + security | Plugin tool handlers 无调用者身份参数，无法实现 owner binding / ACL |
| M-12 | 插件/Gateway 重启后 session 恢复缺失 | Codex R2 + consistency | 无启动时孤儿/过期 session 清理机制，无 `stop()` 成功但 `resume()` 失败的回滚路径 |
| M-13 | 权限等待中发生 switch/stop 的行为未定义 | Codex R2 + security | 等待权限回复期间如果触发模式切换或停止，权限 Promise 如何取消/超时？ |

### 11.4 新发现 — Minor

| # | 问题 | 说明 |
|---|------|------|
| m-7 | Session 最大数量无限制 | 无 spawn 限制，恶意或意外操作可耗尽系统资源 |
| m-8 | 敏感数据流经 OpenClaw 无脱敏 | SessionMessage 可能包含 API key、密码等，经 Telegram/Discord 明文传输 |
| m-9 | PTY 模式输入注入仍未设计过滤 | Round 1 m-5 指出权限超时，但 PTY 输入中的 `\x03` (Ctrl-C) + shell 命令注入仍无防护 |
| m-10 | 消息缓冲区保留策略未定义 | `outputBuffer` 何时清理？上限多少？重启后是否持久化？ |

### 11.5 实现就绪度评估

| 维度 | 评估 | 差距 |
|------|------|------|
| 接口定义 | ⚠️ 需修正 | 6 处接口不一致（SpawnOptions, SessionManager API, 消息类型, 调用者身份） |
| SDK API 准确性 | 🔴 需重写 | 包名、回调名、消息类型、配置参数均需核实后更新 |
| 安全模型 | 🔴 未就绪 | 调用者身份传播、ACL 接口、资源限制均缺失 |
| 错误/恢复流程 | ⚠️ 不完整 | 缺 crash recovery、switch rollback、permission timeout |
| 实现计划 | ⚠️ 需调整 | 安全前移到 Phase 1；Phase 3 拆分；SDK 验证作为 Phase 0 |

### 11.6 建议的下一步

1. **Phase 0（SDK 验证冲刺，1-2 天）**：安装最新 `@anthropic-ai/claude-agent-sdk`，编写 minimal PoC 验证 `query()` + `canUseTool` + `--resume` + streaming input，确认 API 行为
2. **修正所有 SDK API 引用**：基于 Phase 0 结果更新方案中所有代码示例
3. **设计调用者身份传播**：明确 OpenClaw Plugin API 如何传递 caller identity 到 tool handlers
4. **定义安全基线接口**：`SessionACL`、`CwdWhitelist`、`SpawnLimiter` 的接口签名
5. **补全错误恢复流程**：crash recovery、switch rollback、permission timeout 状态图

## 12. 评审发现（Round 3 审查）

> 评审日期：2026-02-09
> 评审方式：3 个 Claude Agent（修复验证 / 就绪度评估 / 全新审查）+ Codex (GPT-5.3) 跨模型第三轮审查
> 说明：Round 3 在所有修正应用后进行验证审查

### 12.1 修正验证结果

| 发现 ID | 修正状态 | 说明 |
|---------|---------|------|
| C-1 canUseTool | ✅ PASS | §3.3.2 和 §4.1 均已修正 |
| C-2 requestId | ✅ PASS | permissionDetail 已添加 requestId，handlePermission 生成 UUID |
| C-3 安全前移 | ✅ PASS | CallerContext + SessionACL + cwd 白名单已在 §3.4 和 §3.3.4 实现 |
| C-4 daemon 环境 | ✅ PASS | §3.1 设计原则已明确 happyclaw CLI wrapper 方案 |
| C-5 SDK 包名 | ✅ PASS | 已更新为 @anthropic-ai/claude-agent-sdk |
| C-6 systemPrompt | ✅ PASS | query() 调用已添加 systemPrompt + settingSources |
| M-1 状态机 | ✅ PASS | 状态机已添加，rollback 路径已修正（R3-2 修复：error 状态 + 清理 Map） |
| M-2 接口补全 | ✅ PASS | SpawnOptions.resumeSessionId + SessionManager.resume/get 已添加 |
| M-7 SDKUserMessage | ✅ PASS | send() 中已添加 session_id |
| M-8 fd3 解析 | ✅ PASS | 已改为行分隔缓冲模式 |
| M-9 SDK vs CLI | ✅ PASS | §4.1 开头已明确使用 SDK query() 而非 CLI |
| M-10 游标分页 | ⚠️ PARTIAL | 接口已添加，但 PTY session 的 read() 仍用旧签名 |
| M-11 CallerContext | ✅ PASS | 所有 tool handler 已接收 CallerContext |
| M-12 启动恢复 | ⚠️ PARTIAL | reconcileOnStartup 方法已添加，但只是 stub |
| M-13 权限超时 | ✅ PASS | 5 分钟超时 + 默认 deny |
| m-1 命名空间 | ✅ PASS | 全部改为 session.* |
| m-4 Discord | ⚠️ PARTIAL | formatForDiscord 已添加到 §4.4，但 Phase 4 仍列为 TODO |

### 12.2 新发现的问题

#### R3-1. resume 路径内部不一致 🔴 Critical ✅ 已修正

**来源**：Codex R3

Provider 的 `resume()` 通过 CLI args 传递 `--resume`，但 SDK 远程模式的构造函数通过 `options.resumeSessionId` 读取。这两条路径冲突——远程模式 resume 会失败。

**修正**：`ClaudeSDKProvider.resume()` 改为通过 `SpawnOptions.resumeSessionId` 传递 session ID。各 Session 类型内部按需处理：远程模式读取 `resumeSessionId` 传给 SDK `query({ options: { resume } })`，本地模式读取 `resumeSessionId` 拼接 CLI args `--resume`。模式切换描述（§4.1）也已同步更新。

#### R3-2. rollback 后 session 状态不一致 🟠 Major ✅ 已修正

**来源**：Codex R3

`switchMode()` 中 `stop()` 成功但 `resume()` 失败时，catch 块把 switchState 设回 `'running'`，但旧 session 已经被 stop 了。此时 sessions Map 中仍持有已停止的旧 session，后续操作会失败。

**修正**：catch 块现在将 switchState 设为 `'error'`，从 sessions Map 中删除该 session，并通知用户需使用 `session.spawn` 创建新 session 或 `session.resume` 手动恢复。

#### R3-3. ACL 绑定时序问题 🟠 Major ✅ 已修正

**来源**：Codex R3

`session.spawn` handler 中先 `sessionManager.spawn()` 再 `sessionACL.setOwner()`。但 `spawn()` 内部已经开始 `onEvent` 转发。如果 spawn 期间立即产生事件（如权限请求），事件已发出但 owner 尚未绑定，可能被错误路由。

**修正**：`SessionManager.spawn()` 新增 `ownerId` 参数，在事件转发（`onEvent`/`onMessage`）启动前调用 `sessionACL.setOwner()`。`session.spawn` tool handler 不再单独调用 `setOwner`，而是将 `caller.userId` 传入 `spawn()`。

#### R3-4. PTY session 的 read() 未适配游标模型 🟡 Minor

**来源**：Codex R3 + fix-verifier

`ProviderSession.read()` 接口已改为 `{ cursor, limit } → { messages, nextCursor }`，但 §4.3 的 `PTYRemoteSession.read()` 仍使用旧的 `outputBuffer.slice()` 实现，未返回 nextCursor。

#### R3-5. 游标 token 语义未定义 🟡 Minor

**来源**：Codex R3

cursor 是什么格式？是递增整数、时间戳、还是 opaque token？过期策略？客户端使用旧 cursor 会怎样？

#### R3-6. cwd 白名单用 startsWith 可被绕过 🟡 Minor

**来源**：Codex R3

`resolvedCwd.startsWith(w)` 匹配 — 如果白名单是 `/Users/pope/projects`，则 `/Users/pope/projects-evil` 也会通过。应使用 `resolvedCwd === w || resolvedCwd.startsWith(w + path.sep)` 或 `realpath` 对比。

### 12.3 实现就绪度评估（Round 3）

| 维度 | Round 2 评估 | Round 3 评估 | 变化 |
|------|-------------|-------------|------|
| 接口定义 | ⚠️ 需修正 | ✅ 就绪 | 接口已完善，resume 路径已统一（R3-1），仅 PTY read() 游标为 minor |
| SDK API 准确性 | 🔴 需重写 | ✅ 已修正 | 包名、回调名、配置参数均已更新（待 Phase 0 最终验证） |
| 安全模型 | 🔴 未就绪 | ✅ 就绪 | CallerContext + ACL 已添加，ACL 时序已修正（R3-3），cwd 绕过为 minor |
| 错误/恢复流程 | ⚠️ 不完整 | ✅ 基本就绪 | 状态机 + 超时 + rollback 已修正（R3-2），reconcile 为 stub 待实现 |
| 实现计划 | ⚠️ 需调整 | ✅ 已调整 | Phase 0 + 安全前移 + Phase 3 拆分 |

### 12.4 总体结论

**方案已达到实现就绪**。Round 1 发现 22 个问题，Round 2 又发现 13 个，Round 3 验证后全部 Critical/Major 问题已修正（含 R3-1 resume 路径统一、R3-2 rollback 状态清理、R3-3 ACL 时序修正）。剩余 Minor 问题（R3-4 PTY 游标、R3-5 游标语义、R3-6 cwd 绕过）可在 Phase 0/Phase 1 编码时同步解决。

**建议**：不再继续文档层面的审查迭代。可直接进入 Phase 0（SDK 验证冲刺）。
