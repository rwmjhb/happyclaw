# Codex Session Handoff: Mac ↔ TG 双向 Session 接续

> 日期: 2026-03-16
> 状态: Approved
> 前置: 2026-03-16-session-handoff-design.md (Claude 版已实现)

## 目标

和 Claude 完全对称：Mac 退出 Codex → 拿到 session ID → TG 继续 → TG 停止 → 回 Mac `codex resume <id>` 继续。

## 验证结论

- Codex CLI 0.114.0 在 `~/.codex/sessions/YYYY/MM/DD/` 写 `.jsonl` transcript
- 文件命名: `rollout-{timestamp}-{sessionId}.jsonl`
- `codex resume <id>` 能恢复 session（已验证）
- Codex MCP server 被 SIGTERM 时会 flush transcript 到磁盘（已验证）
- Happy Coder 用 `config.experimental_resume = filePath` 恢复上下文（实验性特性）

## 关键差异（vs Claude）

| | Claude | Codex |
|---|---|---|
| 恢复机制 | SDK `resume: sessionId` | MCP `config.experimental_resume = filePath` |
| 需要额外步骤 | 无 | 根据 session ID 扫描 `~/.codex/sessions/` 找 `.jsonl` |
| 本机继续命令 | `claude --resume <id>` | `codex resume <id>` |
| TG→Mac 返回哪个 ID | 原始 ID（磁盘只有原始文件） | 新 ID（Codex 生成新文件） |

## 改动

### 1. `src/providers/codex-mcp.ts` — 新增 `findCodexResumeFile()` + 修改 `startSession()`

```typescript
function findCodexResumeFile(sessionId: string): string | null {
  const sessionsDir = path.join(process.env.HOME || '', '.codex', 'sessions');
  // 递归扫描，匹配 *-{sessionId}.jsonl，按修改时间降序取最新
}
```

`startSession()` 中，如果 `spawnOptions.resumeSessionId` 存在：
```typescript
const resumeFile = findCodexResumeFile(this.spawnOptions.resumeSessionId);
if (resumeFile) {
  config.config = { ...config.config, experimental_resume: resumeFile };
}
// 否则抛错: "Codex session file not found for ID: xxx"
```

注意: `config.config` 需要合并（可能已有 `mcp_servers`），不能覆盖。

### 2. `src/openclaw-plugin.ts` — `session_stop` provider-aware resume 逻辑

Claude 和 Codex 的 ID 策略相反：
- Claude: 返回**原始** resumeSessionId（磁盘上是原始文件）
- Codex: 返回 Codex MCP 的**真实 session ID**（磁盘上是新文件）

```typescript
// Capture before stop
const codexRealId = 'realSessionId' in session
  ? (session as { realSessionId: string | null }).realSessionId
  : null;

// After stop
const resumeId = sessionProvider === 'claude'
  ? (originalResumeIds.get(sessionId) ?? sessionId)
  : sessionProvider === 'codex'
    ? (codexRealId ?? sessionId)
    : sessionId;

const resumeCmd = sessionProvider === 'claude'
  ? `claude --resume ${resumeId}`
  : sessionProvider === 'codex'
    ? `codex resume ${resumeId}`
    : undefined;
```

### 3. Tests

- `findCodexResumeFile`: 找到文件 / 找不到文件
- `session_spawn` + `provider: "codex"` + `resumeSessionId` → 验证 `experimental_resume` 传入
- `session_stop` 对 Codex session 返回 `codex resume <realSessionId>`

## 数据流

```
Mac → TG:
  Mac: codex → 工作 → 退出 → "codex resume 019cf076-..."
  TG: session_spawn(provider: "codex", cwd: "/path",
       resumeSessionId: "019cf076-...", task: "继续",
       permissionMode: "bypassPermissions")
  → findCodexResumeFile("019cf076-...")
  → ~/.codex/sessions/.../rollout-...-019cf076-....jsonl
  → startSession({ config: { experimental_resume: "..." } })

TG → Mac:
  TG: session_stop → 返回 "codex resume 019cf55a-..." (新 ID)
  Mac: codex resume 019cf55a-...
```

## 错误处理

- `findCodexResumeFile` 找不到:
  `"Codex session file not found for ID: xxx. Check ~/.codex/sessions/ directory."`
- `experimental_resume` 是实验性特性，Codex 版本不支持时静默降级为新 session

## 不做的事

- 不改 `session_resume`
- 不做 session 发现
