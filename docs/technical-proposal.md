# HappyClaw 技术方案

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

1. **Session 发现** — 自动检测本机活跃的 `claude`/`codex`/`gemini` 进程
2. **PTY 附着** — 附着到运行中进程的 PTY，捕获 I/O
3. **远程控制** — 通过 Telegram/Discord 发送输入、接收格式化输出
4. **控制权切换** — 本地/远程无缝切换，避免双方同时操作冲突
5. **事件推送** — 权限确认请求、错误、任务完成等关键事件主动推送

### 1.3 参考项目

[Happy Coder](https://github.com/slopus/happy)（MIT 协议）—— 一个实现了类似功能的开源项目。HappyClaw 借鉴其以下设计：

- Daemon + Session 管理架构
- Agent Runner 的进程管理模式
- RPC 桥接协议设计
- 控制权切换机制

## 2. Happy Coder 架构分析

### 2.1 整体架构

```
手机 App ←——Socket.IO + E2E 加密——→ Happy Server ←——Socket.IO——→ Happy CLI Daemon
                                    (Postgres/Redis/S3)           (本机后台进程)
                                                                    ├── Session 1 (claude)
                                                                    ├── Session 2 (codex)
                                                                    └── Session N (gemini)
```

### 2.2 CLI 核心组件

| 组件 | 源码位置 | 职责 |
|------|---------|------|
| Entry Point | `src/index.ts` | CLI 路由，子命令分发 |
| Daemon | `src/daemon/run.ts` | 后台进程，管理多 session |
| Control Server | `src/daemon/controlServer.ts` | 本地 IPC HTTP 服务 (127.0.0.1) |
| Control Client | `src/daemon/controlClient.ts` | CLI 与 daemon 通信 |
| Claude Runner | `src/claude/runClaude.ts` | Claude Code 进程管理 |
| Codex Runner | `src/codex/runCodex.ts` | Codex 进程管理 |
| Gemini Runner | `src/gemini/runGemini.ts` | Gemini CLI 进程管理 |
| API Client | `src/api/` | HTTP + Socket.IO + 加密 |
| Persistence | `src/persistence.ts` | 本地状态管理 (~/.happy/) |

### 2.3 关键机制

#### Daemon 生命周期

```
startDaemon() → 校验版本 → 获取锁文件 → 认证 → 注册 machine → 启动控制服务 → 跟踪子 session → 同步状态
```

#### 控制服务 API

Daemon 在 `127.0.0.1:port` 暴露 HTTP 接口：

- `GET /list` — 列出活跃 session
- `POST /spawn-session` — 启动新 session
- `POST /stop-session` — 停止 session
- `POST /stop` — 关闭 daemon
- `POST /session-started` — session 自报告

#### RPC 桥接

```
手机 → Server (Socket.IO) → Daemon → Session 子进程
```

Session 注册 RPC handlers：
- `bash` — 执行 shell 命令
- `file read/write` — 文件操作
- `ripgrep` — 代码搜索
- `difftastic` — diff 查看

#### 加密方案

- Legacy: NaCl secretbox (XSalsa20-Poly1305)
- DataKey: AES-256-GCM（每 session 独立 key）
- Server 只存储 opaque blobs，无法解密用户内容

### 2.4 OpenClaw 已有能力对比

| 能力 | Happy | OpenClaw | 差距 |
|------|-------|----------|------|
| 后台进程管理 | Daemon | Gateway | ✅ 已有 |
| Session 系统 | Session Map | Session 管理 | ✅ 已有 |
| 消息路由 | Socket.IO → App | Telegram/Discord | ✅ 已有 |
| 工具调用 | RPC handlers | exec/read/write tools | ✅ 已有 |
| 加密传输 | E2E AES-256-GCM | 本地运行不需要 | N/A |
| **PTY 进程管理** | Agent Runners | coding-agent skill（spawn 模式） | ⚠️ 缺 attach 模式 |
| **控制权切换** | 键盘接管 | 无 | ❌ 缺失 |
| **CLI 输出解析** | 内置 parser | 无 | ❌ 缺失 |

**结论：OpenClaw 缺的是 PTY attach + 控制权切换 + 输出解析这三块。**

## 3. HappyClaw 架构设计

### 3.1 总体架构

```
┌─────────────────────────────────────────────────┐
│                 OpenClaw Gateway                 │
│                                                  │
│  ┌──────────────┐    ┌───────────────────────┐  │
│  │  Main Agent   │    │  pty-bridge plugin     │  │
│  │  (马斯克等)    │◄──►│                        │  │
│  └──────────────┘    │  ┌──────────────────┐  │  │
│                      │  │  Session Manager  │  │  │
│                      │  │  ├── discover()   │  │  │
│                      │  │  ├── attach()     │  │  │
│                      │  │  ├── send()       │  │  │
│                      │  │  ├── read()       │  │  │
│                      │  │  └── detach()     │  │  │
│                      │  └──────────────────┘  │  │
│                      │  ┌──────────────────┐  │  │
│                      │  │  Output Parser    │  │  │
│                      │  │  ├── claude       │  │  │
│                      │  │  ├── codex        │  │  │
│                      │  │  └── gemini       │  │  │
│                      │  └──────────────────┘  │  │
│                      │  ┌──────────────────┐  │  │
│                      │  │  Event Detector   │  │  │
│                      │  │  ├── permission?  │  │  │
│                      │  │  ├── error?       │  │  │
│                      │  │  ├── waiting?     │  │  │
│                      │  │  └── done?        │  │  │
│                      │  └──────────────────┘  │  │
│                      └───────────────────────┘  │
│                                                  │
│  Telegram ◄──── 消息路由 ────► Discord           │
└─────────────────────────────────────────────────┘
         │
         ▼
  ┌──────────────────┐
  │  本机 CLI 进程     │
  │  ├── claude (PTY) │
  │  ├── codex  (PTY) │
  │  └── gemini (PTY) │
  └──────────────────┘
```

### 3.2 核心模块

#### 3.2.1 Session Manager

负责 CLI 进程的生命周期管理。

```typescript
interface PTYSession {
  id: string;
  pid: number;
  provider: 'claude' | 'codex' | 'gemini';
  cwd: string;              // 项目目录
  startedAt: number;
  controlMode: 'local' | 'remote' | 'shared';
  pty: IPty;                // node-pty 实例
  outputBuffer: RingBuffer; // 最近输出缓冲
}

interface SessionManager {
  // 发现本机活跃的 AI CLI 进程
  discover(): Promise<DiscoveredProcess[]>;

  // 启动新的 CLI session 并管理
  spawn(provider: string, cwd: string, args?: string[]): Promise<PTYSession>;

  // 附着到已有进程（核心难点）
  attach(pid: number): Promise<PTYSession>;

  // 向 session 发送输入
  send(sessionId: string, input: string): Promise<void>;

  // 读取最近输出
  read(sessionId: string, lines?: number): Promise<string>;

  // 脱离但不关闭进程
  detach(sessionId: string): Promise<void>;

  // 列出所有管理中的 session
  list(): PTYSession[];
}
```

#### 3.2.2 Output Parser

解析不同 CLI 的终端输出，提取结构化信息。

```typescript
interface ParsedOutput {
  type: 'text' | 'code' | 'tool_use' | 'permission_request' | 'error' | 'thinking' | 'done';
  content: string;
  metadata?: {
    tool?: string;         // 使用的工具名
    file?: string;         // 涉及的文件
    language?: string;     // 代码语言
    permission?: string;   // 请求的权限
  };
}

interface OutputParser {
  parse(raw: string, provider: string): ParsedOutput[];
  // 流式解析（增量输入）
  createStream(provider: string): Transform;
}
```

#### 3.2.3 Event Detector

监控输出流，检测关键事件并触发通知。

```typescript
interface DetectedEvent {
  type: 'permission_request' | 'error' | 'waiting_for_input' | 'task_complete' | 'tool_execution';
  severity: 'info' | 'warning' | 'urgent';
  summary: string;
  sessionId: string;
  timestamp: number;
}

interface EventDetector {
  // 注册事件监听器
  on(event: string, handler: (event: DetectedEvent) => void): void;
  // 输入新的输出内容进行检测
  feed(sessionId: string, output: string): void;
}
```

#### 3.2.4 控制权管理

```typescript
type ControlMode = 'local' | 'remote' | 'shared';

interface ControlManager {
  // 获取当前控制模式
  getMode(sessionId: string): ControlMode;

  // 请求远程控制权
  requestRemote(sessionId: string): Promise<boolean>;

  // 释放远程控制权（回到本地）
  releaseToLocal(sessionId: string): Promise<void>;

  // 本地键盘活动检测（如果可能）
  onLocalActivity(sessionId: string, callback: () => void): void;
}
```

### 3.3 OpenClaw Plugin 接口

作为 OpenClaw Plugin 暴露的 tools：

```typescript
// Plugin 注册的 tools
const tools = {
  // 列出可用的 CLI sessions
  'pty.list': {
    description: '列出本机活跃的 AI CLI sessions',
    parameters: {},
    handler: async () => sessionManager.list()
  },

  // 发现未管理的 CLI 进程
  'pty.discover': {
    description: '扫描本机运行中的 claude/codex/gemini 进程',
    parameters: {},
    handler: async () => sessionManager.discover()
  },

  // 启动新 session
  'pty.spawn': {
    description: '启动新的 AI CLI session',
    parameters: {
      provider: { type: 'string', enum: ['claude', 'codex', 'gemini'] },
      cwd: { type: 'string', description: '项目目录' },
      args: { type: 'array', items: { type: 'string' }, optional: true }
    },
    handler: async ({ provider, cwd, args }) => sessionManager.spawn(provider, cwd, args)
  },

  // 附着到已有 session
  'pty.attach': {
    description: '附着到运行中的 CLI 进程',
    parameters: {
      target: { type: 'string', description: 'PID 或 session ID' }
    },
    handler: async ({ target }) => sessionManager.attach(target)
  },

  // 发送输入
  'pty.send': {
    description: '向 CLI session 发送输入',
    parameters: {
      sessionId: { type: 'string' },
      input: { type: 'string' }
    },
    handler: async ({ sessionId, input }) => sessionManager.send(sessionId, input)
  },

  // 读取输出
  'pty.read': {
    description: '读取 CLI session 最近输出',
    parameters: {
      sessionId: { type: 'string' },
      lines: { type: 'number', optional: true, default: 50 }
    },
    handler: async ({ sessionId, lines }) => sessionManager.read(sessionId, lines)
  },

  // 脱离 session
  'pty.detach': {
    description: '脱离 CLI session（不关闭进程）',
    parameters: {
      sessionId: { type: 'string' }
    },
    handler: async ({ sessionId }) => sessionManager.detach(sessionId)
  }
};
```

### 3.4 Agent MEMORY.md 配置示例

```markdown
## PTY Bridge

本机已安装 pty-bridge 插件，可以管理 Claude Code / Codex / Gemini CLI sessions。

### 使用方式

1. 发现进程：使用 `pty.discover` 工具扫描本机运行中的 AI CLI 进程
2. 附着：使用 `pty.attach` 附着到目标进程
3. 交互：使用 `pty.send` 发送输入，`pty.read` 读取输出
4. 脱离：使用 `pty.detach` 脱离（进程继续运行）

### 事件通知

插件会自动检测并推送：
- 🔐 权限确认请求（需要用户回复 y/n）
- ❌ 错误和异常
- ⏳ AI 等待输入
- ✅ 任务完成
```

## 4. 技术难点与方案

### 4.1 PTY 附着到已有进程

**问题**：Linux/macOS 不允许直接附着到另一个进程的 PTY。

**方案选择**：

| 方案 | 可行性 | 复杂度 | 推荐 |
|------|--------|--------|------|
| A. `reptyr` / `nattach` 工具 | Linux only，macOS 不支持 | 低 | ❌ |
| B. 从 HappyClaw 启动（spawn 模式） | 完全可行 | 低 | ✅ 推荐 |
| C. tmux/screen 预包装 | 需要用户改习惯 | 中 | ⚠️ 备选 |
| D. `dtach` 包装 | 轻量，跨平台 | 中 | ⚠️ 备选 |
| E. Claude Code `--continue` + spawn | 非真正接管，但上下文延续 | 低 | ✅ 兜底 |

**推荐策略：双轨并行**

1. **主路径（spawn 模式）**：通过 HappyClaw 启动 CLI，从一开始就管理 PTY
2. **兜底路径（continue 模式）**：对已有 session，用 `claude --continue` 在新 PTY 中恢复上下文

```typescript
// 主路径：由 HappyClaw 启动
async spawn(provider: string, cwd: string): Promise<PTYSession> {
  const pty = spawn(getCliPath(provider), [], { cwd, cols: 120, rows: 40 });
  return trackSession(pty, provider, cwd);
}

// 兜底路径：恢复已有 session 的上下文
async resume(provider: string, cwd: string): Promise<PTYSession> {
  const args = provider === 'claude' ? ['--continue'] : [];
  const pty = spawn(getCliPath(provider), args, { cwd, cols: 120, rows: 40 });
  return trackSession(pty, provider, cwd);
}
```

### 4.2 终端输出解析

**问题**：CLI 输出包含 ANSI 转义码、颜色、光标移动、进度条等，直接转发不可读。

**方案**：

```typescript
import stripAnsi from 'strip-ansi';

function parseOutput(raw: string, provider: string): ParsedOutput[] {
  const clean = stripAnsi(raw);

  // Claude Code 特有模式
  if (provider === 'claude') {
    // 检测权限请求
    if (clean.includes('Allow') && clean.includes('(y/n)')) {
      return [{ type: 'permission_request', content: clean }];
    }
    // 检测工具使用
    if (clean.match(/^[⚡🔧📝] /)) {
      return [{ type: 'tool_use', content: clean }];
    }
    // 检测思考中
    if (clean.includes('Thinking...') || clean.includes('⏳')) {
      return [{ type: 'thinking', content: clean }];
    }
  }

  return [{ type: 'text', content: clean }];
}
```

### 4.3 控制权冲突

**问题**：本地终端和远程同时输入会产生冲突。

**方案**：

1. **互斥模式**（默认）：一方控制时，另一方只读
2. **共享模式**（可选）：两方都可输入，但有冲突风险
3. **检测本地活动**：监听本地键盘输入，自动切换控制权

```typescript
// 控制权状态机
enum ControlState {
  LOCAL,           // 本地控制中
  REMOTE,          // 远程控制中
  TRANSITIONING,   // 切换中
}

// 本地活动检测（通过 PTY 的 input 事件）
pty.onData((data) => {
  if (controlState === ControlState.REMOTE) {
    // 本地有键盘输入，自动切回本地控制
    controlState = ControlState.LOCAL;
    notifyRemote('控制权已切回本地终端');
  }
});
```

### 4.4 输出缓冲与截断

**问题**：AI 输出可能很长（大段代码），Telegram 消息有长度限制。

**方案**：

```typescript
const MAX_MESSAGE_LENGTH = 4000; // Telegram 限制

function formatForMessaging(output: string): string[] {
  // 1. 去除 ANSI 码
  const clean = stripAnsi(output);

  // 2. 智能截断：按代码块/段落边界切分
  const chunks = splitAtBoundaries(clean, MAX_MESSAGE_LENGTH);

  // 3. 如果太长，发摘要 + 保存全文
  if (chunks.length > 3) {
    return [
      summarize(clean),
      '(完整输出已保存，发 `pty.read <sessionId> --full` 查看)'
    ];
  }

  return chunks;
}
```

## 5. 实现计划

### Phase 1: MVP — Spawn 模式（2-3 天）

**目标**：通过 OpenClaw 启动和管理 Claude Code session

- [ ] 项目脚手架（TypeScript + node-pty）
- [ ] SessionManager: spawn / send / read / list / detach
- [ ] 基础 Output Parser（strip ANSI + 简单分段）
- [ ] OpenClaw Plugin 注册（暴露 tools）
- [ ] 集成测试：Telegram 发消息 → spawn claude → 交互 → 读输出

### Phase 2: 智能输出 + 事件推送（2-3 天）

**目标**：解析 CLI 输出，检测关键事件并主动推送

- [ ] Claude Code 输出解析器（权限请求、工具使用、错误、完成）
- [ ] Codex 输出解析器
- [ ] EventDetector：关键事件检测 + 通知
- [ ] 输出格式化：智能截断、代码块识别
- [ ] Telegram inline buttons：权限确认快速回复

### Phase 3: 控制权切换 + 多 Session（2-3 天）

**目标**：支持本地/远程切换和多个并行 session

- [ ] ControlManager: 控制权状态机
- [ ] 多 session 管理 + session 选择器
- [ ] Resume 模式（`claude --continue`）
- [ ] Gemini CLI 支持

### Phase 4: 打磨与优化（1-2 天）

- [ ] 错误恢复（进程崩溃检测 + 自动重试）
- [ ] 性能优化（输出缓冲策略）
- [ ] 文档完善
- [ ] 单元测试

## 6. 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| 运行时 | Node.js (ESM) | 与 OpenClaw 保持一致 |
| PTY 管理 | `node-pty` | 跨平台终端模拟 |
| 终端解析 | `strip-ansi` + 自研 parser | ANSI 码清理 + 结构化解析 |
| 类型系统 | TypeScript | 类型安全 |
| 测试 | Vitest | 轻量快速 |
| 包管理 | npm | 与 OpenClaw 一致 |

## 7. 目录结构

```
happyclaw/
├── README.md
├── package.json
├── tsconfig.json
├── docs/
│   └── technical-proposal.md      # 本文档
├── src/
│   ├── index.ts                   # Plugin 入口
│   ├── plugin.ts                  # OpenClaw Plugin 注册
│   ├── session/
│   │   ├── manager.ts             # Session 生命周期管理
│   │   ├── discovery.ts           # 进程发现
│   │   └── types.ts               # 类型定义
│   ├── parser/
│   │   ├── base.ts                # 基础解析器
│   │   ├── claude.ts              # Claude Code 输出解析
│   │   ├── codex.ts               # Codex 输出解析
│   │   └── gemini.ts              # Gemini 输出解析
│   ├── events/
│   │   ├── detector.ts            # 事件检测器
│   │   └── notifier.ts            # 通知发送
│   └── control/
│       └── manager.ts             # 控制权管理
└── tests/
    ├── session.test.ts
    ├── parser.test.ts
    └── events.test.ts
```

## 8. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| macOS 无法 attach 到已有 PTY | 无法接管已运行的 session | 双轨策略：spawn + continue |
| CLI 输出格式变化 | 解析器失效 | 版本检测 + 降级为 raw 文本 |
| node-pty 在 Apple Silicon 编译问题 | 安装失败 | prebuild-install + 备选方案 |
| 长时间运行的 session 内存增长 | OOM | RingBuffer 限制 + 定期清理 |
| OpenClaw Plugin API 变化 | 插件不兼容 | 跟踪 OpenClaw 版本，最小 API 依赖 |

## 9. 与 Happy Coder 的差异

| 维度 | Happy Coder | HappyClaw |
|------|------------|-----------|
| 客户端 | 自建 Expo App | 复用 Telegram/Discord |
| 服务端 | 自建 Server (Postgres/Redis/S3) | 复用 OpenClaw Gateway |
| 加密 | E2E (AES-256-GCM) | 本地运行，无需加密 |
| 用户体系 | 自建（公钥认证） | 复用 OpenClaw 身份系统 |
| 部署 | Docker (Server) + npm (CLI) | npm (Plugin only) |
| 生态集成 | 独立工具 | OpenClaw 生态（skills, agents, cron）|
| 复杂度 | 高（三个 package） | 低（单 plugin） |

**HappyClaw 的优势**：不需要额外的 Server、App、用户体系和加密层——这些 OpenClaw 全都已经有了。只需要专注于 PTY 桥接这一核心能力。
