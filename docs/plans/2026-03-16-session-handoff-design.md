# Session Handoff: Mac ↔ TG 双向 Session 接续

> 日期: 2026-03-16
> 状态: Approved

## 目标

在 Mac 本机退出 Claude Code 后，通过 TG → OpenClaw → HappyClaw 恢复指定 session 继续开发；
在 TG 停止 session 后，回到 Mac 用 `claude --resume <id>` 继续。Session ID 全程不变。

## 范围

- 只做 Claude Code（Codex 不支持跨进程恢复）
- 不做 session 发现/扫描（用户自己知道 session ID）
- 不改 `session_resume` 工具（它管 HappyClaw 自创建的 session）

## 改动

### 1. `src/openclaw-plugin.ts` — `session_spawn` 新增 `resumeSessionId` 参数

```typescript
resumeSessionId: Type.Optional(
  Type.String({
    description:
      'Resume a specific Claude Code session by ID. ' +
      'Get this ID when exiting Claude Code locally. ' +
      'Mutually exclusive with continueSession.',
  }),
),
```

互斥校验：`resumeSessionId` + `continueSession` 同时传时报错。

### 2. `src/providers/claude-sdk.ts` — 确认 resume 链路

`ClaudeRemoteSession` 构造时已将 `resumeSessionId` 传递给 SDK `query({ options: { resume: id } })`。
需确认：
- session ID 从 SDK 返回后保持一致（不被 waitForReady 覆盖）
- SDK 找不到 session 时的错误被正确捕获和转译

### 3. `session_stop` 返回 resume 命令

`session_stop` 的返回结果包含可复制的本机 resume 命令：

```json
{
  "message": "Session stopped.",
  "resumeLocally": "claude --resume 334bbfe0-5e86-4929-9634-4c892670270f",
  "cwd": "/Users/pope/github_repository/happyclaw"
}
```

### 4. TG 推送 stop 通知含 resume 命令

`TelegramPushAdapter` 在 session stop 事件时推送：

```
Session stopped.
本机继续: claude --resume 334bbfe0-...
路径: cd /Users/pope/github_repository/happyclaw
```

## 数据流

```
Mac → TG:
  Mac 退出 Claude → 显示 session ID: abc-123
  TG: session_spawn(provider: "claude", cwd: "/path", resumeSessionId: "abc-123", task: "继续")
  → SDK query({ resume: "abc-123" }) → Session 恢复，ID 保持 abc-123

TG → Mac:
  TG: session_stop(sessionId: "abc-123")
  → 返回 + TG 推送: "本机继续: claude --resume abc-123"
  → Mac: claude --resume abc-123
```

## 错误处理

- `resumeSessionId` + `continueSession` 同时传:
  `"Cannot use both resumeSessionId and continueSession. Use resumeSessionId to resume a specific session, or continueSession to resume the latest."`

- SDK 找不到 session:
  `"Session not found: abc-123. Use continueSession: true to resume the latest session in this cwd instead."`

## 测试

- `session_spawn` 传 `resumeSessionId` → 正确传递到 SDK options.resume
- `resumeSessionId` + `continueSession` 同时传 → 报错
- `session_stop` 返回结果含 `resumeLocally` 和 `cwd`
- TG push 在 stop 时包含 resume 命令
