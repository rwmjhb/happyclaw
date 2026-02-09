# HappyClaw 🐾⚡

**OpenClaw PTY Bridge Plugin** — 将本机运行的 Claude Code / Codex / Gemini CLI session 桥接到 OpenClaw，实现手机远程控制。

## 愿景

在电脑上用 `claude` 或 `codex` 启动开发 session → 离开工位 → 通过 Telegram/Discord 无缝继续操控同一个 session。

## 核心能力

- 🔍 **Session 发现** — 自动检测本机活跃的 Claude Code / Codex / Gemini CLI 进程
- 🔗 **PTY 桥接** — 附着到运行中的 CLI 进程，桥接 I/O 到 OpenClaw
- 📱 **远程控制** — 通过 Telegram/Discord 发送指令、查看输出
- 🔄 **控制权切换** — 本地终端 ↔ 远程无缝切换
- 🔔 **Push 通知** — AI 需要确认权限或遇到错误时推送提醒

## 技术文档

- [技术方案](docs/technical-proposal.md)

## 状态

🚧 规划阶段

## License

MIT
