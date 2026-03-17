# HappyClaw 🐾⚡

**OpenClaw Session Bridge Plugin** — Bridge Claude Code / Codex CLI sessions to OpenClaw for remote control via Telegram.

**OpenClaw 会话桥接插件** — 将 Claude Code / Codex CLI 会话桥接到 OpenClaw，通过 Telegram 远程控制。

---

## Features / 功能

- **Session Management** — Spawn, resume, stop Claude/Codex sessions remotely
  **会话管理** — 远程启动、恢复、停止 Claude/Codex 会话
- **Mac ↔ Telegram Handoff** — Exit Claude/Codex locally, resume from Telegram; stop on Telegram, continue on Mac
  **本机 ↔ Telegram 交接** — 本机退出后从 Telegram 继续；Telegram 停止后回本机继续
- **Zero-Token Push** — CLI output pushed directly to Telegram via Bot API, bypassing the agent
  **零 Token 推送** — CLI 输出直接通过 Bot API 推送到 Telegram，不经过 agent
- **Per-Chat Routing** — Sessions push output to the Telegram group they were started from
  **按群路由** — 每个会话的输出推送到发起它的 Telegram 群
- **Permission Relay** — Approve/deny tool permission requests from Telegram
  **权限转发** — 从 Telegram 批准/拒绝工具权限请求
- **Security** — ACL owner binding, cwd whitelist, sensitive content redaction
  **安全** — ACL 所有者绑定、工作目录白名单、敏感内容脱敏

## Architecture / 架构

```
Mac Terminal                    Telegram
     │                              │
     │  exit claude/codex           │  session_spawn(resumeSessionId)
     │  ← get session ID            │  → resume session
     │                              │
     │                         ┌────┴────┐
     │                         │ OpenClaw │
     │                         │ Gateway  │
     │                         └────┬────┘
     │                              │
     │                     ┌────────┴────────┐
     │                     │   HappyClaw     │
     │                     │   Plugin        │
     │                     └───┬────────┬───┘
     │                         │        │
     │                    Claude SDK  Codex MCP
     │                    (query)    (mcp-server)
     │                         │        │
     │  claude --resume <id>   │        │  codex resume <id>
     └─────────────────────────┘        └──────────────────
```

### Providers / 提供者

| Provider | Mode | How it works |
|----------|------|-------------|
| **Claude Code** | SDK `query()` | Structured JSON stream via `@anthropic-ai/claude-agent-sdk` |
| **Codex** | MCP Client | Two-tool pattern (`codex` + `codex-reply`) via `@modelcontextprotocol/sdk` |
| **Generic PTY** | node-pty | Terminal emulation for CLIs without SDKs (e.g., Gemini) |

## Install / 安装

```bash
# Clone & install
git clone https://github.com/rwmjhb/happyclaw.git
cd happyclaw
pnpm install

# Register as OpenClaw plugin
openclaw plugins install --link .
```

## Session Handoff / 会话交接

### Mac → Telegram

```bash
# 1. Exit Claude/Codex locally — note the session ID
#    本机退出 Claude/Codex — 记下 session ID
claude   # ... work ... exit → "Session ID: abc-123"
codex    # ... work ... exit → "codex resume def-456"

# 2. From Telegram, resume the session
#    在 Telegram 里恢复会话
session_spawn(provider="claude", cwd="/path/to/project",
              resumeSessionId="abc-123", task="continue working")

session_spawn(provider="codex", cwd="/path/to/project",
              resumeSessionId="def-456", task="continue working",
              permissionMode="bypassPermissions")
```

### Telegram → Mac

```bash
# 1. Stop session from Telegram — get resume command
#    在 Telegram 停止会话 — 获取 resume 命令
session_stop(sessionId="...")
# → "claude --resume abc-123" or "codex resume xyz-789"

# 2. Back on Mac, paste the command
#    回到 Mac，粘贴命令继续
claude --resume abc-123
codex resume xyz-789
```

## Tools / 工具

| Tool | Description |
|------|-------------|
| `session_list` | List active sessions / 列出活跃会话 |
| `session_spawn` | Start or resume a session / 启动或恢复会话 |
| `session_resume` | Resume a HappyClaw-managed session / 恢复 HappyClaw 管理的会话 |
| `session_send` | Send input to a session / 向会话发送输入 |
| `session_read` | Read session output (rarely needed — push handles delivery) / 读取会话输出 |
| `session_respond` | Approve/deny permission requests / 批准或拒绝权限请求 |
| `session_stop` | Stop a session / 停止会话 |
| `session_summary` | Get session summary stats / 获取会话摘要 |

## Plugin Config / 插件配置

In `openclaw.json` under `plugins.entries.happyclaw.config`:

```json
{
  "telegramBotToken": "your-bot-token",
  "telegramDefaultChatId": "-your-chat-id",
  "telegramDebounceMs": 1500,
  "maxSessions": 10,
  "cwdWhitelist": []
}
```

## Development / 开发

```bash
pnpm build          # Build (TypeScript → dist/)
pnpm typecheck      # Type check
pnpm test           # Run all tests
pnpm test:watch     # Watch mode
pnpm test:coverage  # Coverage report
```

## License

MIT
