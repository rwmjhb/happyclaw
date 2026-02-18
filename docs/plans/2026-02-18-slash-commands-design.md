# HappyClaw Slash Commands Design

**Date**: 2026-02-18
**Status**: Approved

## Goal

Add OpenClaw slash commands as a supplement to existing tools, so users can directly control sessions from TG/Discord without consuming agent tokens.

## Commands

All use `sessions-` prefix to avoid conflicts with OpenClaw reserved names.

| Command | Args | Maps to |
|---|---|---|
| `/sessions-list` | (none) | session_list |
| `/sessions-spawn` | `<provider> <cwd> <task...>` | session_spawn |
| `/sessions-resume` | `<id> <task...>` | session_resume |
| `/sessions-send` | `<id> <text...>` | session_send |
| `/sessions-read` | `<id>` | session_read |
| `/sessions-approve` | `<id> <requestId>` | session_respond(true) |
| `/sessions-deny` | `<id> <requestId>` | session_respond(false) |
| `/sessions-switch` | `<id> <mode>` | session_switch |
| `/sessions-stop` | `<id> [--force]` | session_stop |
| `/sessions-summary` | `<id>` | session_summary |

## Architecture

- New file: `src/openclaw-commands.ts`
- Export: `registerSessionCommands(api, manager, audit, pushAdapter)`
- Called from `register()` in `openclaw-plugin.ts`
- Args parsing: simple space-split, rest-of-string for task/text params
- ACL: `ctx.senderId` → `CallerContext.userId`
- All commands: `requireAuth: true`, `acceptsArgs: true` (except `sessions-list`)
- Error response: return `{ text: "Usage: ..." }` on bad args

## Key Decisions

- **Supplement, not replace**: Tools stay for agent use; commands for direct human control
- **Zero token cost**: Commands bypass agent entirely via OpenClaw command pipeline
- **Shared infrastructure**: Commands reuse the same SessionManager, AuditLogger, PushAdapter instances
