# HappyClaw 技术方案 v1 (PTY-based, superseded)

> **ARCHIVED** — 本方案已被 v2（SDK-first 架构）取代。见 `docs/technical-proposal.md`。

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

  // 列出管理中的 session（支持过滤）
  list(filter?: { cwd?: string; provider?: string }): PTYSession[];
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
  // 列出可用的 CLI sessions（支持按目录和 provider 过滤）
  'pty.list': {
    description: '列出本机活跃的 AI CLI sessions，支持按项目目录和 provider 类型过滤',
    parameters: {
      cwd: { type: 'string', description: '按项目目录过滤', optional: true },
      provider: { type: 'string', enum: ['claude', 'codex', 'gemini'], description: '按 CLI 类型过滤', optional: true }
    },
    handler: async ({ cwd, provider }) => sessionManager.list({ cwd, provider })
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

### 3.4 多 Session 选择机制

同一个项目目录下可能同时存在多个 session（比如一个 claude 和一个 codex，或者多次 spawn），Agent 需要引导用户选择目标 session。

**典型交互流程**：

```
用户: "看看 claude 跑到哪了"

Agent 调用: pty.list({ cwd: "~/projects/my-app" })

返回多个结果时，Agent 展示选择列表:

  当前目录有 3 个活跃 session：

  1. [claude] 运行 47 分钟 — 正在重构 auth 模块
  2. [claude] 运行 12 分钟 — 正在写测试
  3. [codex]  运行 5 分钟  — 代码审查中

  你要查看哪个？

用户: "第一个"

Agent 调用: pty.read(session1.id)
```

**Agent 行为规则（写入 MEMORY.md）**：

- 当 `pty.list` 按当前 `cwd` 过滤后只有 **1 个 session** → 直接操作，不用问
- 当有 **多个 session** → 列出摘要（provider、运行时长、最近动作），让用户选择
- 用户指定了 provider（如"看看 codex"）→ 再按 `provider` 过滤，仍然多个才问
- 当前目录 **没有 session** → 提示用户是否要 spawn 一个新的

### 3.5 Agent MEMORY.md 配置示例

```markdown
## PTY Bridge

本机已安装 pty-bridge 插件，可以管理 Claude Code / Codex / Gemini CLI sessions。

### 使用方式

1. 查看 session：使用 `pty.list` 列出活跃 session（可按 cwd 和 provider 过滤）
2. 多个 session 时：展示列表让用户选择，单个时直接操作
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

## 10. 方案审核发现

> 由架构审核、可行性审核、安全审核三个维度并行审查，共发现 **36 个问题**（5 Critical / 13 Major / 11 Minor / 7 Suggestion）。

### 10.1 审核概要

| 维度 | 审核重点 | Critical | Major | Minor | Suggestion |
|------|---------|----------|-------|-------|------------|
| 架构设计 | 模块边界、组件交互、可扩展性 | 1 | 5 | 6 | 5 |
| 安全质量 | 安全漏洞、API 设计、边界情况 | 3 | 8 | 5 | 2 |
| 可行性风险 | 技术可行性、风险评估、实现计划 | 1 | 0 | 0 | 0 |

**总体评估**：方案战略方向正确，复用 OpenClaw 已有能力、聚焦 PTY 桥接的思路合理。但在**安全设计、接口语义、模块编排、错误处理**方面存在明显缺失，需在实现前补充设计。

### 10.2 Critical 级别发现（5 个）

#### C1: `pty.send` 输入注入等同远程代码执行（RCE）

**位置**：Section 3.3 `pty.send` tool

**问题**：`pty.send` 接受任意字符串并直接转发给 PTY。由于 Claude Code/Codex/Gemini 本身具备执行 shell 命令、读写文件等能力，这构成了一个远程代码执行通道。方案中没有描述任何对 `pty.send` 输入的认证、授权或过滤机制。

**建议**：
- 对输入进行分级：普通文本 vs. 控制字符（Ctrl+C/D/Z 等），控制字符需额外确认
- 实现基于用户身份的授权——只有 session owner 才能发送输入
- 考虑添加危险命令检测（如 `rm -rf`、`sudo` 等出现时进行告警）

#### C2: Plugin Tools 无认证授权机制

**位置**：Section 3.3 所有 Plugin tools

**问题**：所有工具没有描述任何访问控制。任何能访问 OpenClaw Gateway 的 agent 或用户都可以发现进程、附着 session、发送输入、读取输出（可能包含密钥、凭证）。

**建议**：
- 明确定义哪些 OpenClaw 用户/角色有权使用 pty-bridge 工具
- 每个 session 绑定 owner，只有 owner 可以 send/read/detach
- `pty.discover` 和 `pty.list` 应根据用户权限过滤结果
- 文档中应说明如何与 OpenClaw 已有的权限控制集成

#### C3: `pty.spawn` 的 args 参数存在命令注入风险

**位置**：Section 3.3 `pty.spawn` tool

**问题**：`pty.spawn` 接受 `args: string[]` 参数直接传递给 `spawn()` 调用。如果 `getCliPath(provider)` 验证不严格，或 args 无白名单限制，可能 spawn 任意进程或执行意外行为。

**建议**：
- `provider` 参数必须严格白名单校验（仅允许 `claude`、`codex`、`gemini`）
- `getCliPath()` 应返回硬编码的路径映射，不应基于用户输入拼接
- `args` 参数应有白名单（如只允许 `--continue`、`--model` 等已知安全参数）
- 禁止在 args 中传递包含 shell 元字符的值

#### C4: `attach(pid)` 接口承诺了技术上无法兑现的能力

**位置**：Section 3.2.1 SessionManager 接口

**问题**：接口定义了 `attach(pid: number): Promise<PTYSession>`，但 Section 4.1 明确承认 macOS 不支持 PTY attach。接口承诺的能力与技术现实矛盾。Plugin tools 也暴露了 `pty.attach` 工具，用户调用后会失败。

**建议**：
- 从 SessionManager 接口中移除 `attach(pid)`，改为 `resume(provider, cwd)` 语义
- Plugin tools 中 `pty.attach` 改名为 `pty.resume`，明确表达"恢复上下文"而非"接管进程"
- 或保留 attach 接口但内部实现为 discover + continue 的组合，并在注释中明确说明

#### C5: 权限请求检测过于脆弱

**位置**：Section 4.2 终端输出解析

**问题**：权限请求检测依赖 `clean.includes('Allow') && clean.includes('(y/n)')`。Claude Code 更新后提示格式可能变化；代码输出中出现"Allow"和"(y/n)"会产生误报；安全关键的权限提示不应依赖如此脆弱的检测。

**建议**：
- 结合多个信号检测：文本模式 + 光标位置 + 输出上下文
- 实现版本感知的检测规则（根据 CLI 版本选择对应逻辑）
- 默认保守——宁可多提示一次权限确认
- 考虑使用 Claude Code 的 `--output-format` 或类似结构化输出选项（如果存在）

### 10.3 Major 级别发现（13 个）

#### M1: 输出缓冲区可能泄露敏感信息

**位置**：Section 3.2.1 `outputBuffer: RingBuffer`

**问题**：RingBuffer 存储最近终端输出，通过 `pty.read` 暴露。AI CLI 运行中经常显示 API 密钥、环境变量等敏感信息，方案没有脱敏处理。

**建议**：实现基本的敏感信息脱敏过滤器（正则匹配常见 API key/token 格式）；`pty.read` 仅对 session owner 可用；添加缓冲区自动过期机制。

#### M2: 进程发现暴露系统信息

**位置**：Section 3.2.1 `discover()`

**问题**：`pty.discover` 扫描本机进程，返回 PID、工作目录等信息，泄露系统运行状态和敏感项目路径。

**建议**：限制发现范围为当前用户的进程；返回结果中隐藏完整路径，改用项目名；结合授权机制限制调用权限。

#### M3: cwd 参数存在路径穿越风险

**位置**：Section 3.3 `pty.spawn` tool

**问题**：`cwd` 参数没有任何路径验证。攻击者可指定 `/`、`~/.ssh`、`~/.aws` 等敏感目录作为工作目录。

**建议**：实现 `cwd` 白名单或允许目录列表；禁止 home 目录下的敏感子目录；考虑限制为用户显式配置的项目目录。

#### M4: 缺乏审计日志

**位置**：整体方案

**问题**：没有任何安全审计日志机制。谁在什么时间 attach/send/read 了哪个 session 完全无法追溯。

**建议**：为所有 tool 调用添加结构化审计日志，包含时间戳、调用者身份、操作类型、session ID、关键参数。日志应持久化存储。

#### M5: 控制权切换存在竞态条件

**位置**：Section 4.3 控制权状态机

**问题**：`pty.onData` 检测本地输入后切换状态可能与正在处理的远程命令冲突；TRANSITIONING 状态无超时机制；`shared` 模式承认有冲突风险但无缓解措施。

**建议**：使用互斥锁保护状态切换；TRANSITIONING 设置超时自动回退；`shared` 模式实现操作级别锁定；使用 compare-and-swap 语义防止丢失更新。

#### M6: Session ID 可预测性/伪造

**位置**：Section 3.2.1 `PTYSession.id`

**问题**：`id` 是所有操作的唯一凭证，但方案没有描述 ID 生成方式。如果可预测，攻击者可枚举有效 ID。

**建议**：使用 `crypto.randomUUID()` 或类似密码学安全随机数生成 session ID，至少 128 bit 熵。

#### M7: 缺少进程隔离策略

**位置**：Section 3.1 总体架构

**问题**：pty-bridge plugin 运行在 OpenClaw Gateway 进程内部。node-pty 管理的子进程生命周期与宿主进程绑定，Gateway 崩溃或重启时所有 PTY session 丢失。对于长时间运行的 AI 任务不可接受。

**建议**：考虑将 PTY 管理移到独立 daemon 进程（类似 Happy Coder），Gateway 通过 IPC 通信；或使用 dtach/tmux 作为 PTY 持久化层；至少需要在文档中讨论这个取舍。

#### M8: 缺少模块编排/管道设计

**位置**：Section 3.2 核心模块

**问题**：四个核心模块各自定义了接口，但缺少编排层描述数据流转。PTY output → Parser → Detector → Notifier 的完整管道无组件负责编排；Plugin tool handlers 只引用 sessionManager，Parser 和 Detector 的实例由谁管理不清晰。

**建议**：新增 `SessionPipeline` 组件负责连接管道；补充数据流图（Data Flow Diagram）；使用 Node.js Stream pipeline 或 RxJS Observable 组织管道。

#### M9: ControlManager 本地活动检测在 resume 模式下失效

**位置**：Section 3.2.4 + Section 4.3

**问题**：通过 `pty.onData()` 检测"本地键盘活动"只在 spawn 模式有效。resume 模式下原始终端仍存在，用户键盘输入走原始 PTY，无法检测。

**建议**：明确标注本地活动检测仅支持 spawn 模式；resume 模式使用手动切换；或在 resume 模式下禁用 `shared` 控制模式。

#### M10: 缺少状态持久化和恢复机制

**位置**：整体架构

**问题**：PTYSession 包含运行时状态（IPty、RingBuffer）但无序列化或持久化设计。Gateway/Plugin 重启后所有 session 元数据丢失。

**建议**：设计 session 元数据持久化方案（如 `~/.happyclaw/sessions.json`）；保存 PID、provider、cwd、startedAt 等可恢复信息；启动时执行恢复逻辑。

#### M11: 错误处理被推迟到 Phase 4

**位置**：Section 5 实现计划

**问题**：错误恢复（进程崩溃检测 + 自动重试）被放在最后一个 Phase。但 PTY 进程管理的核心场景包含进程异常退出、信号处理、僵尸进程清理。不在 Phase 1 考虑会导致后期大量重构。

**建议**：将基础错误处理（进程退出检测、资源清理、错误事件上报）移到 Phase 1；Phase 4 做高级恢复（自动重试、断路器等）；SessionManager 接口增加 `onSessionExit` / `onSessionError` 回调。

#### M12: 进程崩溃时远程控制状态未定义

**位置**：Section 4.3 + Section 5

**问题**：AI CLI 进程在远程控制期间崩溃时的行为未定义。用户在远程操控时遇到崩溃却无法得知，体验极差。

**建议**：Phase 1 就应实现基本的进程健康检查（定期轮询 PID 存活状态）；进程异常退出时立即推送通知；定义崩溃后的状态清理流程。

#### M13: 重复 attach 同一进程

**位置**：Section 3.2.1

**问题**：没有防止多次 `pty.attach` 同一 PID 的机制，可能创建重复 session 对象，产生不可预测的行为。

**建议**：Session Manager 维护 PID → session 的映射，对已 attach 的 PID 返回现有 session 而非创建新的。

### 10.4 Minor 级别发现（11 个）

| # | 发现 | 位置 | 建议 |
|---|------|------|------|
| m1 | "本地运行无需加密"假设可能不成立 | Section 9 | 明确威胁模型和信任边界；如果 Gateway 与 Plugin 存在网络通信，至少使用 TLS |
| m2 | `pty.attach` target 参数类型歧义 | Section 3.3 | "PID 或 session ID"无法区分，改用 `pid?: number` + `sessionId?: string` 两个独立参数 |
| m3 | 缺少统一错误响应规范 | Section 3.3 | 定义 `{ success: boolean; error?: { code: string; message: string } }` 格式 |
| m4 | OutputParser 依赖脆弱的 emoji/字符串匹配 | Section 4.2 | 匹配规则外置为可配置规则集；增加 `raw` 降级模式；考虑结构化输出 API |
| m5 | EventDetector 缺少背压/流控 | Section 3.2.3 | 使用 Node.js Stream 接口替代 feed() + on()；非紧急事件支持批量上报 |
| m6 | Gateway 重启后孤儿 PTY 进程 | 整体 | 活跃 session 信息持久化到磁盘；重启后尝试重新 attach；无法重连的进程执行清理 |
| m7 | 终端尺寸硬编码 (120x40) | Section 4.1 | 设为可配置参数；使用较宽默认值（如 200 cols）减少不必要换行 |
| m8 | Unicode/多字节字符截断风险 | Section 4.4 | 消息切分按字符而非字节进行，使用 `Buffer.byteLength()` 或 `TextEncoder` 确保正确处理 |
| m9 | 多处硬编码值缺少配置管理 | 整体 | 定义 `HappyClawConfig` 接口统一管理所有可配置项，支持环境变量覆盖 |
| m10 | `discover()` 缺少实现设计 | Section 3.2.1 | 补充实现方案（如 `pgrep`/进程扫描）；讨论误识别风险和精确匹配策略 |
| m11 | 缺少可观测性策略 | 整体 | 定义结构化日志方案（如 pino）；关键指标：活跃 session 数、输出吞吐量、解析错误率 |

### 10.5 Suggestion 级别建议（7 个）

| # | 建议 | 说明 |
|---|------|------|
| s1 | 新增 `pty.stop` / `pty.kill` 工具 | 支持远程 graceful shutdown 和 force kill |
| s2 | `pty.read` 增加 `full` 参数 | 分离数据获取与消息格式化逻辑 |
| s3 | 新增 `SessionPipeline` 编排组件 | 负责连接 PTY output → Parser → Detector → Notifier 管道 |
| s4 | 评估 Worker Threads | 多 session 大量输出时，避免主线程被解析逻辑阻塞 |
| s5 | 定义 Plugin 生命周期钩子 | `onInit()` / `onShutdown()` / `onHealthCheck()` |
| s6 | 区分 `read()` / `readRaw()` / `readParsed()` | 分别返回清理文本、原始输出、结构化输出 |
| s7 | PTY 依赖代码的测试策略 | 接口抽象 + Mock 实现用于单元测试；专用 CI runner 用于集成测试 |

### 10.6 优先行动项

基于以上发现，建议在开始编码前完成以下工作：

**1. 新增 Phase 0: 安全基础设施**

在实现任何功能之前，先建立：
- 认证授权机制（Session owner 绑定 + 工具级权限控制）
- 输入验证框架（provider 白名单、args 白名单、cwd 路径限制）
- 结构化审计日志
- Session ID 使用 `crypto.randomUUID()`

**2. 修正 `attach` → `resume` 语义**

将 `SessionManager.attach(pid)` 改为 `resume(provider, cwd)`，Plugin tool `pty.attach` 改为 `pty.resume`，避免接口承诺与技术现实矛盾。

**3. 新增编排组件**

添加 `SessionPipeline` 类，负责连接 PTY output → Parser → Detector → Notifier 完整数据管道。

**4. 将基础错误处理移到 Phase 1**

进程退出检测、资源清理、崩溃通知应是 MVP 的一部分，不是 Phase 4 的优化项。

**5. 评估进程隔离**

考虑将 PTY 管理移到独立 daemon 进程，或使用 dtach/tmux 作为持久化层，使 session 在 Gateway 重启后可恢复。
