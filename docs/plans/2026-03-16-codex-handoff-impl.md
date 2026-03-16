# Codex Session Handoff Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable bidirectional Mac ↔ TG session handoff for Codex using `experimental_resume` with local `.jsonl` transcript files.

**Architecture:** Add `findCodexResumeFile()` to scan `~/.codex/sessions/` for transcript files by session ID, pass the file path via `config.experimental_resume` to Codex MCP `startSession()`, and make `session_stop` return provider-aware resume commands with the correct session ID per provider.

**Tech Stack:** TypeScript, Vitest, @modelcontextprotocol/sdk, node:fs, node:path

---

### Task 1: Implement `findCodexResumeFile()` with tests

**Files:**
- Modify: `src/providers/codex-mcp.ts:17-18` (add fs imports)
- Modify: `src/providers/codex-mcp.ts:245-258` (add function after `resolveExecutionPolicy`)
- Test: `tests/unit/codex-mcp.test.ts`

**Step 1: Write the failing tests**

Add a new `describe('findCodexResumeFile', ...)` block in `tests/unit/codex-mcp.test.ts`. The function needs to be exported for testing. Add these tests:

```typescript
import { findCodexResumeFile } from '../../src/providers/codex-mcp.js';

describe('findCodexResumeFile', () => {
  it('finds a session file matching the session ID', () => {
    // Create temp dir structure mimicking ~/.codex/sessions/
    const tmpDir = path.join(os.tmpdir(), `codex-test-${Date.now()}`);
    const subDir = path.join(tmpDir, '2026', '03', '16');
    mkdirSync(subDir, { recursive: true });

    const sessionId = '019cf55a-266c-7332-a7ab-e5ab6d643597';
    const fileName = `rollout-2026-03-16T14-34-11-${sessionId}.jsonl`;
    writeFileSync(path.join(subDir, fileName), '{}');

    const result = findCodexResumeFile(sessionId, tmpDir);
    expect(result).toBe(path.join(subDir, fileName));

    // Cleanup
    rmSync(tmpDir, { recursive: true });
  });

  it('returns null when no matching file exists', () => {
    const tmpDir = path.join(os.tmpdir(), `codex-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const result = findCodexResumeFile('nonexistent-id', tmpDir);
    expect(result).toBeNull();

    rmSync(tmpDir, { recursive: true });
  });

  it('returns the newest file when multiple matches exist', () => {
    const tmpDir = path.join(os.tmpdir(), `codex-test-${Date.now()}`);
    const dir1 = path.join(tmpDir, '2026', '03', '15');
    const dir2 = path.join(tmpDir, '2026', '03', '16');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });

    const sessionId = 'abc-123';
    const oldFile = path.join(dir1, `rollout-2026-03-15T10-00-00-${sessionId}.jsonl`);
    const newFile = path.join(dir2, `rollout-2026-03-16T10-00-00-${sessionId}.jsonl`);
    writeFileSync(oldFile, '{}');
    writeFileSync(newFile, '{}');

    const result = findCodexResumeFile(sessionId, tmpDir);
    expect(result).toBe(newFile);

    rmSync(tmpDir, { recursive: true });
  });

  it('returns null when sessions directory does not exist', () => {
    const result = findCodexResumeFile('any-id', '/nonexistent/path');
    expect(result).toBeNull();
  });
});
```

You'll need to add these imports at the top of the test file:

```typescript
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/codex-mcp.test.ts -t "findCodexResumeFile"`
Expected: FAIL — `findCodexResumeFile` is not exported

**Step 3: Implement `findCodexResumeFile`**

In `src/providers/codex-mcp.ts`, add after the `resolveExecutionPolicy` function (after line ~245). Add `readdirSync` to the existing fs import on line 18 (it's already there). Add `statSync` to the import.

```typescript
/**
 * Find the Codex session transcript file for a given session ID.
 *
 * Scans `~/.codex/sessions/` recursively for files matching
 * `*-{sessionId}.jsonl`. Returns the newest match by mtime, or null.
 *
 * @param sessionsDir - Override for testing (default: ~/.codex/sessions)
 */
export function findCodexResumeFile(
  sessionId: string,
  sessionsDir?: string,
): string | null {
  const baseDir = sessionsDir
    ?? path.join(process.env.HOME || '', '.codex', 'sessions');

  const suffix = `-${sessionId}.jsonl`;
  const matches: { path: string; mtime: number }[] = [];

  function scanDir(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // directory doesn't exist or not readable
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.endsWith(suffix)) {
          matches.push({ path: fullPath, mtime: stat.mtimeMs });
        }
      } catch {
        // skip unreadable entries
      }
    }
  }

  scanDir(baseDir);

  if (matches.length === 0) return null;

  // Return newest by mtime
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0].path;
}
```

Update the fs import at line 18 to include `statSync`:

```typescript
import { execSync, spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { existsSync, readlinkSync, readdirSync, statSync } from 'node:fs';
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/codex-mcp.test.ts -t "findCodexResumeFile"`
Expected: All 4 PASS

**Step 5: Commit**

```bash
git add src/providers/codex-mcp.ts tests/unit/codex-mcp.test.ts
git commit -m "feat: findCodexResumeFile — 扫描 ~/.codex/sessions/ 查找 transcript"
```

---

### Task 2: Wire `experimental_resume` into `startSession()`

**Files:**
- Modify: `src/providers/codex-mcp.ts:576-608` (`startSession` method)
- Test: `tests/unit/codex-mcp.test.ts`

**Step 1: Write the failing test**

Add a test to the existing `CodexMCPSession` or `CodexMCPProvider` describe block. Since `startSession` is private, test via the public `spawn()` path — verify that when `resumeSessionId` is set and a resume file exists, the `codex` MCP tool is called with `config.experimental_resume`.

This is hard to unit test without mocking the MCP client. Instead, add an integration-style test that verifies `findCodexResumeFile` is called and the config is built correctly. Create a focused test:

```typescript
describe('Codex experimental_resume config', () => {
  it('builds config with experimental_resume when resumeSessionId has a matching file', () => {
    // Create temp session file
    const tmpDir = path.join(os.tmpdir(), `codex-resume-test-${Date.now()}`);
    const subDir = path.join(tmpDir, '2026', '03', '16');
    mkdirSync(subDir, { recursive: true });

    const sessionId = 'test-resume-id';
    const fileName = `rollout-2026-03-16T10-00-00-${sessionId}.jsonl`;
    const filePath = path.join(subDir, fileName);
    writeFileSync(filePath, '{}');

    const result = findCodexResumeFile(sessionId, tmpDir);
    expect(result).toBe(filePath);

    // Verify the config shape that would be built
    const config: Record<string, unknown> = {
      prompt: 'continue',
      'approval-policy': 'untrusted',
      sandbox: 'workspace-write',
    };
    if (result) {
      config.config = { experimental_resume: result };
    }

    expect((config.config as Record<string, unknown>).experimental_resume).toBe(filePath);

    rmSync(tmpDir, { recursive: true });
  });

  it('throws when resumeSessionId has no matching file', () => {
    const result = findCodexResumeFile('no-such-session', '/nonexistent');
    expect(result).toBeNull();
  });
});
```

**Step 2: Implement — modify `startSession()` in `CodexMCPSession`**

In `src/providers/codex-mcp.ts`, modify the `startSession` method (around line 576). After building the base `config` object (line ~592), add before the `client.callTool` call:

```typescript
    // experimental_resume: load transcript from disk for session handoff
    if (this.spawnOptions.resumeSessionId) {
      const resumeFile = findCodexResumeFile(this.spawnOptions.resumeSessionId);
      if (!resumeFile) {
        throw new Error(
          `Codex session file not found for ID: ${this.spawnOptions.resumeSessionId}. ` +
          'Check ~/.codex/sessions/ directory.',
        );
      }
      config.config = {
        ...(config.config ?? {}),
        experimental_resume: resumeFile,
      };
    }
```

**Step 3: Run tests**

Run: `npx vitest run tests/unit/codex-mcp.test.ts`
Expected: All PASS

**Step 4: Commit**

```bash
git add src/providers/codex-mcp.ts tests/unit/codex-mcp.test.ts
git commit -m "feat: Codex startSession 支持 experimental_resume — Mac → TG 接续"
```

---

### Task 3: Provider-aware `session_stop` resume command

**Files:**
- Modify: `src/openclaw-plugin.ts:772-797` (`session_stop` execute)
- Test: `tests/unit/openclaw-plugin.test.ts`

**Step 1: Write the failing test**

Add to `describe('session_stop', ...)` in `tests/unit/openclaw-plugin.test.ts`:

```typescript
it('returns codex resume command with realSessionId for codex sessions', async () => {
  // Register a codex mock provider
  const codexProvider = createMockProvider('codex');
  manager.registerProvider(codexProvider);

  // Create a mock session that has realSessionId (like CodexMCPSession)
  const codexSession = createMockSession({ id: 'codex-pending-123', provider: 'codex' });
  // Simulate CodexMCPSession.realSessionId
  (codexSession as Record<string, unknown>).realSessionId = 'real-codex-id-456';
  codexProvider._setNextSession(codexSession);

  await manager.spawn(
    'codex',
    { cwd: '/tmp/project', mode: 'remote' },
    caller.userId,
  );

  const tool = findTool('session_stop');
  const result = (await tool.execute('call-1', {
    sessionId: 'codex-pending-123',
  })) as { content: Array<{ text: string }> };

  const parsed = JSON.parse(result.content[0].text);
  expect(parsed.resumeLocally).toBe('codex resume real-codex-id-456');
  expect(parsed.cwd).toBe('/tmp/test-project');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/openclaw-plugin.test.ts -t "returns codex resume"`
Expected: FAIL — `resumeLocally` is undefined (Codex not handled yet)

**Step 3: Implement — modify `session_stop` execute**

In `src/openclaw-plugin.ts`, update the `session_stop` execute function. Replace the current resume logic:

```typescript
async execute(_id: string, params: Record<string, unknown>) {
  const sessionId = params.sessionId as string;
  manager.acl.assertOwner(caller.userId, sessionId);

  // Capture session info before stop (stop removes it from manager)
  const session = manager.get(sessionId);
  const sessionCwd = session.cwd;
  const sessionProvider = session.provider;

  // Codex: capture real MCP session ID (for TG → Mac handoff)
  const codexRealId = 'realSessionId' in session
    ? (session as { realSessionId: string | null }).realSessionId
    : null;

  await manager.stop(sessionId, params.force as boolean | undefined);

  // Unbind push adapter (flushes remaining messages)
  pushAdapter?.unbindSession(sessionId);

  // Determine the correct resume ID per provider:
  // - Claude: use original resumeSessionId (disk has original file)
  // - Codex: use real MCP session ID (disk has new file)
  let resumeId: string;
  let resumeCmd: string | undefined;

  if (sessionProvider === 'claude') {
    resumeId = originalResumeIds.get(sessionId) ?? sessionId;
    resumeCmd = `claude --resume ${resumeId}`;
  } else if (sessionProvider === 'codex') {
    resumeId = codexRealId ?? sessionId;
    resumeCmd = `codex resume ${resumeId}`;
  } else {
    resumeId = sessionId;
  }

  originalResumeIds.delete(sessionId);

  log("stop", sessionId, { force: params.force });
  return textResult({
    message: "Session stopped.",
    resumeLocally: resumeCmd,
    cwd: sessionCwd,
  });
},
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/openclaw-plugin.test.ts -t "returns codex resume"`
Expected: PASS

**Step 5: Verify existing tests still pass**

Run: `npx vitest run tests/unit/openclaw-plugin.test.ts`
Expected: All PASS (including the Claude handoff tests from earlier)

**Step 6: Commit**

```bash
git add src/openclaw-plugin.ts tests/unit/openclaw-plugin.test.ts
git commit -m "feat: session_stop provider-aware resume — Codex 返回 codex resume <realId>"
```

---

### Task 4: Full test suite + typecheck verification

**Files:** None (verification only)

**Step 1: Run all tests**

Run: `mkdir -p /tmp/test /tmp/test-project /tmp/project /tmp/new /tmp/a /tmp/b && npx vitest run`
Expected: All tests pass (542+ tests)

**Step 2: Type check**

Run: `pnpm typecheck`
Expected: No errors

**Step 3: Commit if any missed files**

```bash
git status
# If clean, no commit needed
```
