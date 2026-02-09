/**
 * Phase 0 PoC #1: Basic query() validation
 *
 * Verifies:
 * - query() returns an AsyncGenerator (Query interface)
 * - Can iterate over SDKMessage stream
 * - Message types in the stream
 * - Clean exit behavior
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  console.log('=== PoC #1: Basic query() ===\n');

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    console.log('\n[TIMEOUT] Aborting after 30s');
    abortController.abort();
  }, TIMEOUT_MS);

  try {
    console.log('[INFO] Calling query() with simple string prompt...');
    const response = query({
      prompt: 'Say "hello phase0" and nothing else. Do not use any tools.',
      options: {
        cwd: '/tmp/happyclaw-phase0-test',
        abortController,
        maxTurns: 1,
        permissionMode: 'plan',
      },
    });

    console.log(`[INFO] query() returned type: ${typeof response}`);
    console.log(`[INFO] Is AsyncGenerator: ${typeof response[Symbol.asyncIterator] === 'function'}`);
    console.log(`[INFO] Has interrupt(): ${typeof response.interrupt === 'function'}`);
    console.log(`[INFO] Has close(): ${typeof response.close === 'function'}`);
    console.log(`[INFO] Has streamInput(): ${typeof response.streamInput === 'function'}`);
    console.log(`[INFO] Has initializationResult(): ${typeof response.initializationResult === 'function'}`);

    const messageTypes: string[] = [];
    let messageCount = 0;

    console.log('\n[INFO] Iterating over response messages...\n');

    for await (const message of response) {
      messageCount++;
      const msg = message as SDKMessage;
      const typeKey = msg.type === 'system' && 'subtype' in msg ? `${msg.type}:${msg.subtype}` : msg.type;
      messageTypes.push(typeKey);

      console.log(`[MSG ${messageCount}] type=${typeKey}`);

      if (msg.type === 'assistant') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              console.log(`  text: "${block.text.substring(0, 200)}"`);
            }
          }
        }
      }

      if (msg.type === 'result') {
        console.log(`  subtype: ${msg.subtype}`);
        console.log(`  is_error: ${msg.is_error}`);
        console.log(`  num_turns: ${msg.num_turns}`);
        if ('result' in msg) {
          console.log(`  result: "${String(msg.result).substring(0, 200)}"`);
        }
        console.log(`  duration_ms: ${msg.duration_ms}`);
        console.log(`  total_cost_usd: ${msg.total_cost_usd}`);
        console.log(`  session_id: ${msg.session_id}`);
      }
    }

    console.log(`\n[SUMMARY]`);
    console.log(`  Total messages: ${messageCount}`);
    console.log(`  Message types seen: ${[...new Set(messageTypes)].join(', ')}`);
    console.log(`  Type sequence: ${messageTypes.join(' -> ')}`);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.log('[INFO] Query was aborted (timeout or manual)');
    } else {
      console.error('[ERROR]', err);
    }
  } finally {
    clearTimeout(timeout);
  }
}

main().catch(console.error);
