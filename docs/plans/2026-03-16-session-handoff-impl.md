# Session Handoff Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable bidirectional Mac ↔ TG session handoff by adding `resumeSessionId` to `session_spawn` and surfacing the resume command on `session_stop`.

**Architecture:** Add one parameter to `session_spawn`, add mutual-exclusion validation, enrich `session_stop` return with resume info, and update TG push adapter to include resume command on stop events.

**Tech Stack:** TypeScript, Vitest, @sinclair/typebox, @anthropic-ai/claude-agent-sdk

---

### Task 1: Add `resumeSessionId` parameter to `session_spawn` schema

**Files:**
- Modify: `src/openclaw-plugin.ts:363-367` (after `continueSession` parameter)

**Step 1: Add the TypeBox parameter**

In `src/openclaw-plugin.ts`, inside the `session_spawn` parameters `Type.Object({...})`, add after the `continueSession` field (line 367):

```typescript
resumeSessionId: Type.Optional(
  Type.String({
    description:
      'Resume a specific Claude Code session by ID (from exiting Claude Code locally). ' +
      'Mutually exclusive with continueSession.',
  }),
),
```

**Step 2: Add mutual-exclusion validation in execute()**

In `src/openclaw-plugin.ts`, at the start of `session_spawn`'s `execute()` function (line 440), add before `manager.spawn()`:

```typescript
if (params.resumeSessionId && params.continueSession) {
  throw new Error(
    'Cannot use both resumeSessionId and continueSession. ' +
    'Use resumeSessionId to resume a specific session, ' +
    'or continueSession to resume the latest.',
  );
}
```

**Step 3: Pass `resumeSessionId` to SpawnOptions**

In the same `execute()`, add to the options object passed to `manager.spawn()` (around line 443-463):

```typescript
resumeSessionId: params.resumeSessionId as string | undefined,
```

**Step 4: Verify no code changes needed in `src/providers/claude-sdk.ts`**

Confirm that `ClaudeRemoteSession` constructor (line 94-149) already handles `resumeSessionId`:
- Line 108: `session_id: options.resumeSessionId ?? ''` in initial prompt
- Line 123: `resume: options.resumeSessionId` in SDK options
- Line 313: `handleSDKMessage` sets `this.sessionId` from first message with `session_id`

No changes needed — the SDK provider already correctly passes and preserves the resume session ID.

**Step 5: Commit**

```bash
git add src/openclaw-plugin.ts
git commit -m "feat: session_spawn 新增 resumeSessionId 参数 — Mac → TG session 接续"
```

---

### Task 2: Tests for `resumeSessionId` in `session_spawn`

**Files:**
- Modify: `tests/unit/openclaw-plugin.test.ts`

**Step 1: Write the failing test — resumeSessionId passes through to provider**

Add to the existing `describe('session_spawn', ...)` block in `tests/unit/openclaw-plugin.test.ts`:

```typescript
it('passes resumeSessionId to provider spawn options', async () => {
  const newSession = createMockSession({ id: 'resumed-abc' });
  mockProvider._setNextSession(newSession);

  const tool = findTool('session_spawn');
  await tool.execute('call-1', {
    provider: 'claude',
    cwd: '/tmp/project',
    task: 'continue working',
    resumeSessionId: 'abc-123',
  });

  expect(mockProvider.spawn).toHaveBeenCalledWith(
    expect.objectContaining({
      resumeSessionId: 'abc-123',
    }),
  );
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/openclaw-plugin.test.ts -t "passes resumeSessionId"`
Expected: FAIL — `resumeSessionId` not yet passed through (wait, Task 1 already adds this — run to verify PASS)

**Step 3: Write the failing test — mutual exclusion**

```typescript
it('rejects resumeSessionId + continueSession together', async () => {
  const tool = findTool('session_spawn');
  await expect(
    tool.execute('call-1', {
      provider: 'claude',
      cwd: '/tmp/project',
      task: 'continue',
      resumeSessionId: 'abc-123',
      continueSession: true,
    }),
  ).rejects.toThrow(/Cannot use both resumeSessionId and continueSession/);
});
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/openclaw-plugin.test.ts -t "rejects resumeSessionId"`
Expected: PASS (validation was added in Task 1)

**Step 5: Write the test — resumeSessionId alone works (no continueSession)**

```typescript
it('allows resumeSessionId without continueSession', async () => {
  const newSession = createMockSession({ id: 'sess-resume' });
  mockProvider._setNextSession(newSession);

  const tool = findTool('session_spawn');
  const result = (await tool.execute('call-1', {
    provider: 'claude',
    cwd: '/tmp/project',
    task: 'continue',
    resumeSessionId: 'abc-123',
  })) as { content: Array<{ text: string }> };

  const parsed = JSON.parse(result.content[0].text);
  expect(parsed.id).toBe('sess-resume');
  expect(parsed.message).toContain('Session started');
});
```

**Step 6: Run all tests**

Run: `npx vitest run tests/unit/openclaw-plugin.test.ts`
Expected: All PASS

**Step 7: Commit**

```bash
git add tests/unit/openclaw-plugin.test.ts
git commit -m "test: session_spawn resumeSessionId 参数 + 互斥校验"
```

---

### Task 3: Enrich `session_stop` return with resume command

**Files:**
- Modify: `src/openclaw-plugin.ts:738-749` (`session_stop` execute function)

**Step 1: Write the failing test**

Add to the existing `describe('session_stop', ...)` block in `tests/unit/openclaw-plugin.test.ts`:

```typescript
it('returns resumeLocally command and cwd on stop', async () => {
  const tool = findTool('session_stop');
  const result = (await tool.execute('call-1', {
    sessionId: 'sess-1',
  })) as { content: Array<{ text: string }> };

  const parsed = JSON.parse(result.content[0].text);
  expect(parsed.message).toContain('stopped');
  expect(parsed.resumeLocally).toBe('claude --resume sess-1');
  expect(parsed.cwd).toBe('/tmp/test-project');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/openclaw-plugin.test.ts -t "returns resumeLocally"`
Expected: FAIL — `resumeLocally` is undefined

**Step 3: Implement — modify session_stop execute()**

In `src/openclaw-plugin.ts`, change the `session_stop` execute function. Capture session info BEFORE stopping (since stop removes it from the manager):

```typescript
async execute(_id: string, params: Record<string, unknown>) {
  const sessionId = params.sessionId as string;
  manager.acl.assertOwner(caller.userId, sessionId);

  // Capture session info before stop (stop removes it from manager)
  const session = manager.get(sessionId);
  const sessionCwd = session.cwd;
  const sessionProvider = session.provider;

  await manager.stop(sessionId, params.force as boolean | undefined);

  // Unbind push adapter (flushes remaining messages)
  pushAdapter?.unbindSession(sessionId);

  log('stop', sessionId, { force: params.force });
  return textResult({
    message: 'Session stopped.',
    resumeLocally: sessionProvider === 'claude'
      ? `claude --resume ${sessionId}`
      : undefined,
    cwd: sessionCwd,
  });
},
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/openclaw-plugin.test.ts -t "returns resumeLocally"`
Expected: PASS

**Step 5: Run all tests to check for regressions**

Run: `npx vitest run tests/unit/openclaw-plugin.test.ts`
Expected: All PASS (the existing "stops a session" test checks `parsed.message` contains 'stopped' which still works)

**Step 6: Commit**

```bash
git add src/openclaw-plugin.ts tests/unit/openclaw-plugin.test.ts
git commit -m "feat: session_stop 返回 resumeLocally 命令 — TG → Mac session 接续"
```

---

### Task 4: TG push adapter includes resume command on stop

**Files:**
- Modify: `src/push/telegram-push-adapter.ts`
- Modify: `tests/unit/telegram-push-adapter.test.ts`

**Step 1: Read TG push adapter to find handleEvents**

Check `src/push/telegram-push-adapter.ts` for how events are formatted and pushed. The adapter receives `SessionEvent[]` via `handleEvents()`. We need to detect `task_complete` events that indicate a session stop and include the resume command.

Note: The `session_stop` tool result (with `resumeLocally`) goes to the OpenClaw agent, NOT directly to TG. The TG push adapter gets raw `SessionEvent` objects. So we need to handle this differently — the adapter doesn't know the session ID or cwd from the event alone.

**Alternative approach:** Instead of modifying the push adapter's event handling, the `session_stop` tool already returns `resumeLocally` to the agent. The agent will relay this to the user in TG. The push adapter already pushes messages during the session. On stop, the agent's response (containing `resumeLocally`) is what the user sees.

**This means no push adapter changes are needed.** The agent relays the `session_stop` tool result (which now contains `resumeLocally` and `cwd`) to the user in the TG conversation.

**Step 2: Verify with existing test**

Run: `npx vitest run tests/unit/telegram-push-adapter.test.ts`
Expected: All PASS (no changes needed)

**Step 3: Commit (skip — no changes needed)**

---

### Task 5: Run full test suite and verify

**Files:** None (verification only)

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

**Step 2: Type check**

Run: `pnpm typecheck`
Expected: No errors

**Step 3: Final commit with all changes**

If any files were missed:

```bash
git add -A
git commit -m "chore: session handoff — final verification"
```
