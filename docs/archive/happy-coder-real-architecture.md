# Happy Coder 真实架构分析

> **ARCHIVED** — 本文发现已纳入 v2 技术方案（SDK-first 架构）。见 `docs/technical-proposal.md`。

> 基于 https://github.com/slopus/happy 源码的深入分析，发现其核心设计与 HappyClaw 技术方案的假设存在根本性差异。

## 核心发现：不是 PTY 桥接，而是 SDK 模式切换

Happy Coder **没有使用 PTY 捕获终端输出**来实现远程交互。它的做法是：

### 本地模式（claudeLocal.ts）

直接 `spawn` Claude Code 进程，标准 I/O 继承给用户终端：

```typescript
const child = spawn('node', [claudeCliPath, ...args], {
  stdio: ['inherit', 'inherit', 'inherit', 'pipe'],  // stdin/stdout/stderr 直接继承
  cwd: opts.path,
});
```

- 用户体验和直接跑 `claude` 完全一样
- 只通过额外的 fd3 管道追踪 thinking 状态（fetch-start/fetch-end 事件）
- Slash 命令、Tab 补全、TUI 界面全部正常工作

### 远程模式（claudeRemote.ts）

使用 **Claude Code SDK**，以结构化 JSON 流方式启动：

```typescript
const response = query({
  prompt: messages,  // AsyncIterable<SDKUserMessage>，结构化 JSON 输入
  options: {
    cwd: opts.path,
    resume: startFrom,             // 恢复已有 session
    permissionMode: 'default',
    model: initial.mode.model,
    // ...
  },
});

// 输出也是结构化 JSON 流
for await (const message of response) {
  // message.type: 'system' | 'assistant' | 'user' | 'result'
  opts.onMessage(message);
}
```

关键参数：
- `--output-format stream-json` — 输出结构化 JSON 而非终端文本
- `--input-format stream-json` — 输入结构化 JSON 而非终端文本
- `--permission-prompt-tool stdio` — 权限请求通过 SDK 控制协议处理

### 权限处理

不是解析 "Allow (y/n)" 文本，而是通过 SDK 控制协议：

```typescript
// Claude Code 发出控制请求
{ type: 'control_request', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {...} } }

// Happy Coder 响应
{ type: 'control_response', response: { subtype: 'success', request_id: '...', response: { behavior: 'allow' } } }
```

### Slash 命令处理

在 `parsers/specialCommands.ts` 中拦截，转换为 SDK 操作：

```typescript
// 支持的特殊命令
'/compact' → 发送到 SDK 触发 context compaction
'/clear'   → 触发 session reset（清除 session ID，开新会话）
```

其他 slash 命令（如 /help）不需要特殊处理，因为远程模式下用户发的是自然语言消息，由 Claude Code SDK 内部处理。

### 模式切换（loop.ts）

```typescript
while (true) {
  switch (mode) {
    case 'local':
      // 启动本地 PTY 进程（stdio inherit）
      const result = await claudeLocalLauncher(session);
      if (result.type === 'switch') mode = 'remote';
      break;
    case 'remote':
      // 启动 SDK 模式进程（stream-json）
      const reason = await claudeRemoteLauncher(session);
      if (reason === 'switch') mode = 'local';
      break;
  }
}
```

切换时：
1. 终止当前模式的 Claude Code 进程
2. 用 `--resume <sessionId>` 在新模式下恢复同一个会话
3. 会话上下文通过 Claude Code 的 session 持久化机制保留

### 消息转发

远程模式下，SDK 消息被转换为日志格式后通过 Socket.IO 发送给手机 App：

```typescript
// SDK消息 → 日志格式 → Socket.IO → 手机 App
const logMessage = sdkToLogConverter.convert(message);
session.client.sendClaudeSessionMessage(logMessage);
```

### Codex 支持

Codex 使用不同的方式 — 通过 MCP (Model Context Protocol) 桥接：

```
packages/happy-cli/src/codex/codexMcpClient.ts    — MCP 客户端
packages/happy-cli/src/codex/happyMcpStdioBridge.ts — STDIO 桥接
```

## 与 HappyClaw 技术方案的关键差异

| 维度 | HappyClaw 方案（PTY 桥接） | Happy Coder 实际实现（SDK 模式切换） |
|------|--------------------------|----------------------------------|
| 核心机制 | 捕获 PTY I/O，解析终端输出 | 使用 Claude Code SDK，结构化 JSON 流 |
| 输出解析 | strip-ansi + 正则匹配 emoji/文本 | 不需要解析，输出已是结构化数据 |
| 权限处理 | 检测 "Allow (y/n)" 文本 | SDK control_request/response 协议 |
| Slash 命令 | 通过 pty.send 发送文本 | 拦截后转换为 SDK 操作 |
| 本地体验 | 通过 HappyClaw 包装的 PTY | 直接 inherit stdio，原生体验 |
| 远程交互 | 读取 RingBuffer + 发送文本 | SDK 消息流 + 结构化输入 |
| 模式切换 | 同一 PTY，切换控制权 | 终止进程，用 --resume 在新模式重启 |
| 进程数 | 1 个 PTY 进程 | 切换时重启（同一时间 1 个进程） |
| 复杂度 | 高（ANSI 解析、PTY 管理、竞态） | 低（SDK 抽象了复杂性） |
| 可靠性 | 依赖脆弱的文本解析 | 结构化协议，版本兼容性好 |

## 对 HappyClaw 的影响

这个发现意味着 HappyClaw 技术方案的以下核心假设需要重新评估：

1. **PTY 桥接不是唯一路径** — Claude Code 提供了 SDK 模式，可以结构化交互
2. **OutputParser 可能不需要** — SDK 模式下输出已是结构化数据
3. **EventDetector 可以更可靠** — 基于 SDK 消息类型检测，而非正则匹配
4. **控制权切换的实现方式不同** — 不是"共享一个 PTY"而是"切换进程模式"
5. **Codex 可能需要不同的方案** — Codex 使用 MCP 而非 PTY/SDK
