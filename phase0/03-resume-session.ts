/**
 * Phase 0 PoC #3: Resume session validation
 *
 * Verifies:
 * - session_id is available from response messages
 * - Can resume a session using options.resume
 * - Context is preserved across resume
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  console.log('=== PoC #3: Resume Session ===\n');

  // Step 1: Start a session and capture session_id
  console.log('[STEP 1] Starting initial session...');

  const abortController1 = new AbortController();
  const timeout1 = setTimeout(() => {
    console.log('\n[TIMEOUT] Step 1 aborting after 30s');
    abortController1.abort();
  }, TIMEOUT_MS);

  let sessionId: string | undefined;

  try {
    const response1 = query({
      prompt: 'Remember this secret code: ALPHA-7749. Just confirm you have remembered it, nothing else.',
      options: {
        cwd: '/tmp/happyclaw-phase0-test',
        abortController: abortController1,
        maxTurns: 1,
        permissionMode: 'plan',
      },
    });

    for await (const message of response1) {
      const msg = message as SDKMessage;
      // Capture session_id from first message that has it
      if ('session_id' in msg && msg.session_id && !sessionId) {
        sessionId = msg.session_id;
        console.log(`[INFO] Captured session_id: ${sessionId}`);
      }

      if (msg.type === 'assistant') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              console.log(`[STEP 1] Assistant: "${block.text.substring(0, 200)}"`);
            }
          }
        }
      }

      if (msg.type === 'result') {
        console.log(`[STEP 1] Result: subtype=${msg.subtype}, session_id=${msg.session_id}`);
        if (!sessionId) {
          sessionId = msg.session_id;
        }
      }
    }
  } catch (err) {
    console.error('[STEP 1 ERROR]', err);
  } finally {
    clearTimeout(timeout1);
  }

  if (!sessionId) {
    console.log('[FAIL] Could not capture session_id from step 1. Cannot test resume.');
    return;
  }

  console.log(`\n[STEP 2] Resuming session ${sessionId}...`);

  // Step 2: Resume the session and verify context
  const abortController2 = new AbortController();
  const timeout2 = setTimeout(() => {
    console.log('\n[TIMEOUT] Step 2 aborting after 30s');
    abortController2.abort();
  }, TIMEOUT_MS);

  try {
    const response2 = query({
      prompt: 'What was the secret code I told you to remember? Just say the code, nothing else.',
      options: {
        cwd: '/tmp/happyclaw-phase0-test',
        abortController: abortController2,
        maxTurns: 1,
        resume: sessionId,
        permissionMode: 'plan',
      },
    });

    let resumedSessionId: string | undefined;

    for await (const message of response2) {
      const msg = message as SDKMessage;

      if ('session_id' in msg && msg.session_id && !resumedSessionId) {
        resumedSessionId = msg.session_id;
      }

      if (msg.type === 'assistant') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              console.log(`[STEP 2] Assistant: "${block.text.substring(0, 200)}"`);
            }
          }
        }
      }

      if (msg.type === 'result') {
        console.log(`[STEP 2] Result: subtype=${msg.subtype}`);
        if ('result' in msg) {
          console.log(`[STEP 2] Result text: "${String(msg.result).substring(0, 200)}"`);
        }
      }
    }

    console.log(`\n[SUMMARY]`);
    console.log(`  Original session_id: ${sessionId}`);
    console.log(`  Resumed session_id:  ${resumedSessionId}`);
    console.log(`  IDs match: ${sessionId === resumedSessionId}`);
    console.log(`  Context preserved: (check if ALPHA-7749 appears in step 2 output)`);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.log('[INFO] Query was aborted (timeout)');
    } else {
      console.error('[STEP 2 ERROR]', err);
    }
  } finally {
    clearTimeout(timeout2);
  }
}

main().catch(console.error);
