# HappyClaw CLI 实现方案 — Mac ↔ Phone 会话交接

> **状态**: 已搁置 (Parked)
> **日期**: 2026-02-09
> **前置**: 先用 OpenClaw 插件模式运行一段时间，积累使用经验后再实施
>
> **当前临时方案** (2026-02-19):
> - Mac → TG: 本地 `/exit` 退出 → TG `session_spawn(continueSession: true)` 接续
> - TG → Mac: TG `session_stop` → 本地 `claude --continue` 接续
> - Codex 现已支持多轮交互（MCP `codex-reply`），但仍无跨进程 resume

## 目标

让用户可以在 Mac 终端启动 Claude Code 会话，中途通过手机（Telegram/Discord）接管，或反向从手机发起的会话在 Mac 上本地 attach。

## 核心问题

1. **`ClaudeLocalSession` 使用假 session_id** (`local-${Date.now()}`)，无法跨进程 resume
2. **OpenClaw 插件未启用 SessionPersistence**，CLI 进程无法发现 gateway 管理的会话
3. **没有 CLI 入口**，用户无法在终端直接操作 HappyClaw

## 设计方案

### Phase 1: 修复 Session ID 捕获 (session-id-capture.ts)

**新文件: `src/session-id-capture.ts`**

SDK bootstrap 方式获取真实 `session_id`：
- 调用 SDK `query()` 发送一条轻量消息（如 "ping"），设置 `maxTurns: 1`
- 从返回的 stream 中提取 `session_id`（在 `result` 类型消息中）
- 立即 `close()` 结束 SDK session
- 返回捕获到的 `session_id` 供后续 `claude --resume <id>` 使用

**修改: `src/providers/claude-sdk.ts`**

- `ClaudeLocalSession` 构造时接受真实 `session_id`（不再自动生成）
- `ClaudeSDKProvider.spawn()` 先调用 `captureSessionId()` 获取 ID，再用 `--resume <id>` 启动 CLI
- Local session 的 `resume()` 方法直接用存储的 `session_id` 调用 `--resume`

### Phase 2: 启用共享持久化

**修改: `src/openclaw-plugin.ts`**

- 在 `register()` 中创建 `SessionPersistence` 实例（路径: `~/.happyclaw/sessions.json`）
- 传入 `SessionManager` 构造函数
- spawn/stop/switch 时自动持久化

**修改: `src/persistence.ts`**

- 添加文件锁机制防止 CLI 和 gateway 同时写入
- 添加 `watch()` 方法监听文件变化

### Phase 3: CLI 命令实现 (cli.ts)

通过 OpenClaw 的 `api.registerCli()` 注册命令：

```
openclaw happyclaw start [--cwd <path>] [--provider <name>]
openclaw happyclaw list
openclaw happyclaw attach <sessionId>
openclaw happyclaw stop <sessionId>
```

配合 `api.registerGatewayMethod()` 实现 CLI ↔ Gateway IPC。

### Phase 4: 交接协调器 (handoff.ts)

- Mac → Phone: Ctrl+C 退出本地终端 → 手机端 `session_resume` 接管
- Phone → Mac: `/detach` 命令 → Mac `openclaw happyclaw attach <id>`

## 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `src/session-id-capture.ts` | SDK bootstrap 捕获真实 session_id |
| 新增 | `src/cli.ts` | CLI 命令注册 |
| 新增 | `src/handoff.ts` | 交接协调器 |
| 修改 | `src/providers/claude-sdk.ts` | 使用真实 session_id |
| 修改 | `src/openclaw-plugin.ts` | 启用持久化 + registerCli + registerGatewayMethod |
| 修改 | `src/persistence.ts` | 添加文件锁 + watch |

## 限制

- Codex 不支持跨进程 resume — 但已支持同进程多轮交互（`codex-reply`，2026-02-19 验证通过）
- session_id 捕获有 API 成本 — 每次 spawn 多一次 SDK 往返
