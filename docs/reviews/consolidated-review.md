# HappyClaw 技术方案评审报告（合并版）

> 评审日期：2026-02-09
> 评审方式：三位 AI Agent 并行评审（Tech Lead / Security Reviewer / Product Manager）
> 评审对象：`docs/technical-proposal.md`

---

## 一、总体评价

| 维度 | 评分 | 说明 |
|------|------|------|
| 架构可行性 | ⚠️ 中等 | Spawn 模式可行，但 Attach 模式在 macOS 上不可行 |
| 安全性 | 🔴 高风险 | 缺乏加密、认证、授权设计 |
| 产品完整度 | ⚠️ 需改进 | 核心场景覆盖不足，UX 有缺口 |
| 工期估算 | ⚠️ 偏乐观 | 7-11 天 → 建议 14-18 天 |

---

## 二、Tech Lead 评审：架构与技术

### 2.1 核心问题：PTY Attach 不可行

**这是方案最大的技术风险。**

- macOS 没有 `ptrace` attach 或 `/proc/fd` 机制，无法从外部进程接管已有 PTY
- 方案提出的 "Fallback = `claude --continue` resume" 只能恢复对话上下文，**不能接管正在运行的 CLI 会话**
- 这意味着 HappyClaw 的核心卖点（"远程接管本地 CLI"）在 Attach 模式下**无法兑现**

**建议**：
- 砍掉 Attach 模式，全力做好 Spawn 模式
- 如果用户需要"接管"，通过 `claude --continue` 提供"续对话"语义，明确告知不是真正的 PTY 接管

### 2.2 终端输出解析

- 方案使用 `strip-ansi` 清理终端输出
- 但 Claude Code 使用 Ink（React for CLI）渲染 TUI，输出包含大量光标移动、区域重绘、进度条等
- `strip-ansi` 只去掉 ANSI 颜色码，**无法正确解析 Ink TUI 的复杂输出**

**建议**：
- 使用 terminal emulator 库（如 `xterm-headless` 或 `node-terminal`）做完整的 VT100 解析
- 或拦截 Claude CLI 的 `--output-format json` 模式（如果有的话）

### 2.3 技术栈评估

| 选择 | 评价 |
|------|------|
| Node.js ESM | ✅ 与 OpenClaw 一致 |
| `node-pty` | ✅ 成熟，适合 Spawn 模式 |
| `strip-ansi` | ⚠️ 不够，需要 VT100 emulator |
| TypeScript | ✅ 合理 |
| Vitest | ✅ 但测试不应放最后一期 |

### 2.4 架构建议

1. **Plugin 而非 MCP Server** — 正确决策，复用 OpenClaw 基础设施
2. **Session 映射** — CLI session ↔ OpenClaw session 的映射设计合理
3. **缺少重连机制** — CLI 进程崩溃后的恢复策略未涉及

---

## 三、Security Reviewer 评审：安全

### 3.1 整体风险等级：🔴 HIGH

### 3.2 关键安全问题

#### ❌ 1. "本地运行不需要加密" 是危险的

方案声称因为本地运行所以不需要 E2E 加密。这忽略了：

- **传输路径**：用户 → Telegram/Discord 服务器 → OpenClaw Gateway → HappyClaw
- Telegram 消息经过第三方服务器，可能被截获
- 用户发送的命令可能包含敏感信息（API keys、密码、文件路径）
- **Telegram Bot API 不是端到端加密的**

#### ❌ 2. 无认证/授权设计

- 谁可以控制 CLI session？
- 多用户场景下如何隔离？
- 没有操作级别的权限控制

#### ❌ 3. 输入注入风险

- `pty.send(userInput)` 直接将用户输入写入 PTY
- 恶意输入可以注入 shell 命令（如 `\x03` Ctrl-C + `rm -rf /`）
- 未设计输入过滤或沙箱机制

#### ❌ 4. 数据泄露

- CLI 输出可能包含敏感信息（环境变量、密钥、私有代码）
- 这些信息会通过 Telegram/Discord 明文传输
- 无输出过滤机制

### 3.3 安全建议

1. **最低限度**：添加输入验证和过滤（block shell 逃逸字符）
2. **必要措施**：实现操作授权（危险命令需确认）
3. **推荐措施**：敏感信息检测和脱敏（API key、密码等自动遮蔽）
4. **可选措施**：考虑对 CLI session 数据做端到端加密存储

---

## 四、Product Manager 评审：产品

### 4.1 用户场景覆盖

| 场景 | 覆盖 | 说明 |
|------|------|------|
| 手机远程启动 Claude CLI 任务 | ✅ | Spawn 模式 |
| 查看运行中任务的输出 | ⚠️ | 输出解析可能不完整 |
| 远程接管正在运行的 CLI | ❌ | Attach 不可行 |
| 多 CLI 工具切换 | ⚠️ | 设计有但细节不足 |
| 错误恢复 | ❌ | 未涉及 |

### 4.2 竞品分析

- **Happy Coder**：E2E 加密、Web UI、完整的 PTY 管理，但需要独立部署
- **HappyClaw**：利用 OpenClaw 生态，零额外部署，但功能和安全性待完善

### 4.3 UX 问题

1. **输出太长怎么办？** — 缺少分页、截断、摘要机制
2. **并发 session 管理** — 用户如何切换 session？命令前缀？按钮？
3. **状态感知** — CLI 正在编译？等待输入？报错了？用户需要清晰的状态反馈
4. **Telegram 消息限制** — 4096 字符上限，CLI 输出轻松超出

### 4.4 时间线评估

| 方案估算 | PM 建议 |
|----------|---------|
| Phase 1: 3-4 天 | 5-6 天（含输出解析的复杂性） |
| Phase 2: 2-3 天 | 4-5 天（多 CLI 支持比想象中复杂） |
| Phase 3: 2-4 天 | 5-7 天（测试+安全不能压缩） |
| **总计: 7-11 天** | **14-18 天** |

### 4.5 产品建议

1. **MVP 只做 Spawn + Claude CLI** — 不要试图同时支持三种 CLI
2. **先做好输出处理** — 这是用户体验的核心
3. **加入确认机制** — 危险操作弹确认按钮（Telegram inline keyboard）

---

## 五、共识结论与行动项

### 必须修改

1. **砍掉 Attach 模式** — 技术不可行，不要承诺做不到的事
2. **添加安全设计** — 输入过滤、输出脱敏、操作授权至少要有
3. **升级输出解析** — `strip-ansi` → VT100 emulator 或 JSON 输出模式
4. **测试前移** — Phase 1 就开始写测试，不要全堆到最后

### 建议修改

5. **调整工期** — 14-18 天更现实
6. **MVP 聚焦** — 只做 Claude CLI + Spawn 模式
7. **输出分页** — 适配 Telegram 4096 字符限制
8. **添加状态系统** — CLI session 状态可视化

### 可选改进

9. 敏感信息自动检测和脱敏
10. Session 快照和恢复
11. 输出摘要（用 LLM 总结长输出）

---

*评审结论：方案方向正确，但存在重大技术和安全缺陷需要在实施前修正。建议先更新技术方案，再开始编码。*
