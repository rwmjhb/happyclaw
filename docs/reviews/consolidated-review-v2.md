# HappyClaw 技术方案 v2 评审报告

> 评审日期：2026-02-09
> 评审对象：`docs/technical-proposal.md` v2（SDK 优先 + PTY 通用后备架构）
> 评审方式：3 个 Claude Agent 并行评审 + Codex (GPT-5.3) 跨模型评审
> 评审团队：
> - **arch-reviewer** (Claude) — 架构设计与 Provider 抽象审查
> - **sdk-reviewer** (Claude) — SDK 集成可行性与实现计划审查
> - **security-reviewer** (Claude) — 安全、API 质量与边缘情况审查
> - **Codex** (GPT-5.3) — 跨模型独立审查（`--sandbox read-only`）

---

## 一、总体评价

| 维度 | v1 评分 | v2 评分 | 变化 |
|------|---------|---------|------|
| 架构可行性 | ⚠️ 中等 | ✅ 良好 | SDK 模式消除了 v1 的 PTY Attach 不可行问题 |
| 安全性 | 🔴 高风险 | ⚠️ 中风险 | 仍有关键安全问题需前移到 MVP |
| 接口设计 | N/A | ⚠️ 需修正 | Provider 接口有多处不一致 |
| 工期估算 | ⚠️ 偏乐观 | ⚠️ 偏乐观 | Phase 3 尤其乐观 |

**总评**：v2 方案比 v1 有本质性提升，SDK 优先策略正确，Provider 抽象方向合理。但接口定义存在多处不一致，安全基线需前移，部分 SDK API 名称需核实。

---

## 二、跨模型共识发现（Claude + Codex 均标记 = 高置信度）

以下发现被多个独立审查者标记，置信度最高：

### C-1. SDK API 名称错误：`canCallTool` → `canUseTool` 🔴 Critical

**Codex + sdk-reviewer 共同标记**

方案中多处使用 `canCallTool`（第 323 行、第 669 行），但 Claude Agent SDK 实际 API 为 `canUseTool` / `CanUseTool`。这会导致集成直接失败。

```typescript
// ❌ 方案中写的
canCallTool: (toolName, input, opts) => this.handlePermission(toolName, input, opts),

// ✅ 实际 SDK API
canUseTool: (toolName, input, opts) => this.handlePermission(toolName, input, opts),
```

**行动项**：核实最新 Claude Agent SDK 文档，修正所有 API 调用名。

### C-2. 权限请求缺少 `requestId` 关联 🔴 Critical

**Codex + security-reviewer 共同标记**

`pty.respond` 需要 `requestId`（第 550 行），但 `SessionEvent` 的 `permissionDetail` 中没有 `requestId` 字段（第 203 行）。这意味着远程用户无法可靠地回复特定权限请求。

```typescript
// SessionEvent.permissionDetail 只有 toolName 和 input，没有 requestId
permissionDetail?: {
  toolName: string;
  input: unknown;
  // ❌ 缺少 requestId
};
```

**行动项**：在 `SessionEvent` 和 `permissionDetail` 中添加 `requestId` 字段。

### C-3. 安全控制延迟到 Phase 4 🔴 Critical

**Codex + security-reviewer + arch-reviewer 三方共识**

Session owner binding、cwd 白名单、审计日志等安全措施被放到 Phase 4（第 836 行），但 Plugin tools 从 Phase 1 就暴露了 list/read/send/stop 能力且无鉴权（第 488 行）。在共享 Gateway 环境下，这意味着 **任何能访问 Gateway 的用户都可以操控所有 CLI session**。

**行动项**：将 session owner binding 和基本 ACL 移到 Phase 1 MVP。

### C-4. 本地模式 stdio inherit 在 daemon 环境不可行 🔴 Critical

**Codex + arch-reviewer 共同标记**

方案假设本地模式用 `stdio: ['inherit', 'inherit', 'inherit', 'pipe']`（第 292 行、第 647 行），但 HappyClaw 作为 OpenClaw Plugin 运行在 Gateway 进程中。如果 Gateway 是后台 daemon（headless），stdio inherit 无法提供终端体验。

这与 Happy Coder 的架构不同 — Happy Coder 是独立 CLI 工具，直接在用户终端运行，所以 stdio inherit 有效。HappyClaw 作为 Plugin，本地模式的 UX 模型需要重新设计。

**行动项**：明确 HappyClaw 的运行环境假设。如果 Plugin 在 daemon 中运行，本地模式需通过另一种方式提供（如 `happyclaw` CLI wrapper 在用户终端启动，Plugin 在后台桥接）。

---

## 三、重大问题（Major）

### M-1. 模式切换非原子操作

**Codex + arch-reviewer 标记**

`SessionManager.switchMode`（第 472 行）先 `stop()` 再 `resume()`，中间没有 drain/lock 机制。如果 Claude Code 正在执行工具调用（如写文件），强制切换可能导致：
- in-flight 消息丢失
- 文件修改不完整
- 权限请求被丢弃

**建议**：添加状态机 `running → draining → switching → resumed`，切换前等待当前工具执行完成。

### M-2. SpawnOptions 接口不一致

**Codex + sdk-reviewer 标记**

`SpawnOptions`（第 221 行）没有 `resumeSessionId` 字段，但 `ClaudeRemoteSession` 构造函数中使用了 `options.resumeSessionId`（第 321 行）。

`sessionManager.resume()` 和 `sessionManager.get()` 在 tools 中被调用（第 523、533 行），但 `SessionManager` 类定义中没有这些方法。

**建议**：统一接口定义，补全缺失的方法签名。

### M-3. Session ID 恢复后可能变化

**Codex 标记**

`SessionManager` 用 sessionId 作为 Map key（第 478 行），但 `--resume` 后 SDK 可能分配新的 session ID。这会导致旧 ID 指向无效引用。

**建议**：resume 后更新 session 映射，或使用 HappyClaw 自己的稳定 ID 而非 CLI session ID。

### M-4. PushableAsyncIterable 未定义

**Codex + sdk-reviewer 标记**

方案中 `ClaudeRemoteSession` 使用 `PushableAsyncIterable<SDKUserMessage>`（第 313 行），但这不是标准库类型，也不是 Claude SDK 的导出类型。需要自行实现，且需处理背压（backpressure）。

**建议**：明确实现方案（如基于 async generator + queue），或确认 SDK 是否提供类似工具类。

### M-5. cwd 安全控制缺失

**Codex + security-reviewer 标记**

`pty.spawn` 接受用户提供的任意 `cwd`（第 511 行），无白名单或路径校验。恶意用户可指定 `cwd: "/"` 或 `cwd: "/etc"` 操控敏感目录。

**建议**：Phase 1 就添加 cwd 白名单或至少限制在用户 home 目录下。

### M-6. Phase 3 工期乐观，Codex MCP "待调研"

**Codex + sdk-reviewer 标记**

Phase 3 将 Codex MCP 桥接（"待调研"，第 721/829 行）和 Gemini PTY 打包在 3-4 天内。MCP 桥接方案尚无设计细节，3-4 天不够。

**建议**：Phase 3 拆分为两个子阶段：
- Phase 3a：Gemini PTY（已有设计，2-3 天）
- Phase 3b：Codex MCP（需独立设计冲刺，3-5 天）

---

## 四、次要问题（Minor）

### m-1. `pty.*` 命名空间与架构不匹配

核心架构已是 SDK/MCP/PTY 混合模式，但 plugin tools 仍叫 `pty.*`，容易让开发者和用户困惑。

**建议**：考虑改为 `session.*` 或 `cli.*`。

### m-2. cwd 字符串严格匹配

`SessionManager.list` 用 `s.cwd === filter.cwd`（第 459 行）做过滤。`~/projects/my-app` vs `/Users/pope/projects/my-app` vs symlink 路径会匹配失败。

**建议**：使用 `path.resolve()` + `fs.realpathSync()` 标准化路径比较。

### m-3. Telegram 输出摘要无完整获取机制

`formatForTelegram` 超过 3 段时发摘要 + "发 '查看完整输出' 获取全文"（第 775 行），但 Plugin API 中没有对应的"获取完整输出"工具。

**建议**：添加 `pty.readFull` 或在 `pty.read` 中支持分页参数（offset + limit）。

### m-4. Discord 字符限制未提及

方案只提了 Telegram 4096 字符限制，Discord 消息限制为 2000 字符，代码块更短。

**建议**：在 `formatForTelegram` 旁添加 `formatForDiscord` 适配。

### m-5. 权限请求超时处理缺失

如果远程用户不回复权限请求，`waitForPermissionResponse` 会无限等待。Claude Code 侧可能超时或 hang。

**建议**：添加可配置的超时 + 默认 deny 策略。

### m-6. CLI 进程崩溃恢复策略缺失

`SessionManager` 没有处理 CLI 进程意外退出的机制。进程退出后 session 仍在 Map 中，后续操作会失败。

**建议**：监听进程 `exit` 事件，更新 session 状态，通知远程用户。

---

## 五、建议改进（Suggestion）

| # | 建议 | 来源 |
|---|------|------|
| S-1 | 安全基线（owner binding, ACL, cwd 白名单, 权限默认 deny）移到 Phase 1 | Codex + security |
| S-2 | 添加模式切换状态机：`running → draining → switching → resumed` | Codex + arch |
| S-3 | 添加兼容性矩阵：Claude CLI 版本、SDK 包名/版本、各 Provider 降级行为 | Codex |
| S-4 | Phase 3 拆分为 Gemini PTY (3a) 和 Codex MCP (3b) 两个子阶段 | Codex + sdk |
| S-5 | 添加故障模式测试：切换期间工具执行、重复权限请求、plugin 重启、stale requestId | Codex |
| S-6 | SDK 消息类型完整映射（不只列 high-level type，要对每个 subtype 定义转换规则） | Codex |
| S-7 | 添加 session 心跳机制，检测 CLI 进程健康状态 | arch + security |

---

## 六、v1 → v2 改进确认

v1 评审中的以下 Critical 问题在 v2 中已得到解决：

| v1 问题 | v2 状态 |
|---------|---------|
| PTY Attach 在 macOS 不可行 | ✅ 已移除，改为 SDK 模式切换 |
| 终端输出解析脆弱（strip-ansi 不够） | ✅ SDK 模式下不需要解析，PTY 仅作为后备 |
| 缺少 VT100 终端模拟器 | ✅ PTY 模式中加入了 xterm-headless |
| 无认证/授权设计 | ⚠️ 提到但延迟到 Phase 4，需前移 |
| 输入注入风险 | ⚠️ SDK 模式下风险降低（结构化输入），PTY 模式仍需处理 |

---

## 七、行动优先级

### 必须修改（实现前）

1. **修正 SDK API 名称** — `canCallTool` → `canUseTool`（核实最新文档）
2. **补全 `requestId` 关联** — `SessionEvent.permissionDetail` + `pty.respond` 的关联机制
3. **安全基线前移** — session owner binding + cwd 校验移到 Phase 1
4. **明确本地模式运行环境** — Plugin in daemon vs CLI wrapper，决定 stdio inherit 的可行性
5. **修复接口不一致** — `SpawnOptions.resumeSessionId`、`SessionManager.resume/get` 方法

### 建议修改

6. 模式切换添加 drain/lock 机制
7. `pty.*` 命名空间改为 `session.*`
8. Phase 3 拆分（Gemini PTY + Codex MCP 分阶段）
9. cwd 路径标准化
10. 权限请求超时 + 默认 deny

### 可选改进

11. 完整的 SDK 消息类型映射表
12. Discord 消息格式适配
13. Session 心跳机制
14. 故障模式测试用例设计

---

*评审结论：v2 方案在架构层面有本质性提升（SDK 优先消除了 v1 的 PTY 文本解析脆弱性），Provider 抽象方向正确。但存在 4 个 Critical 级别问题（SDK API 名称、requestId 关联、安全基线、本地模式环境假设）需要在实现前修正。修正这些问题后，方案可以进入开发阶段。*
