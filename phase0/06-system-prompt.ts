/**
 * Phase 0 PoC #6: systemPrompt and settingSources validation
 *
 * Verifies:
 * - systemPrompt as a string is accepted
 * - systemPrompt as { type: 'preset', preset: 'claude_code', append: '...' } is accepted
 * - settingSources: ['project'] loads CLAUDE.md etc.
 * - settingSources: [] (empty) works as SDK isolation mode
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const TIMEOUT_MS = 30_000;

async function runTest(
  name: string,
  systemPrompt: string | { type: 'preset'; preset: 'claude_code'; append?: string },
  settingSources: Array<'user' | 'project' | 'local'> | undefined,
): Promise<void> {
  console.log(`\n--- Test: ${name} ---`);

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    console.log(`[TIMEOUT] ${name} - Aborting after 30s`);
    abortController.abort();
  }, TIMEOUT_MS);

  try {
    const response = query({
      prompt: 'What is your system prompt about? Summarize it in one sentence. Do not use any tools.',
      options: {
        cwd: '/tmp/happyclaw-phase0-test',
        abortController,
        maxTurns: 1,
        permissionMode: 'plan',
        systemPrompt,
        settingSources,
      },
    });

    console.log(`[INFO] query() accepted parameters without throwing.`);
    console.log(`[INFO] systemPrompt type: ${typeof systemPrompt === 'string' ? 'string' : JSON.stringify(systemPrompt)}`);
    console.log(`[INFO] settingSources: ${JSON.stringify(settingSources)}`);

    for await (const message of response) {
      const msg = message as SDKMessage;

      if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init') {
        const init = msg as Record<string, unknown>;
        console.log(`[INIT] model=${init.model}, permissionMode=${init.permissionMode}`);
        console.log(`[INIT] tools count=${(init.tools as string[])?.length}`);
      }

      if (msg.type === 'assistant') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              console.log(`[RESPONSE] "${block.text.substring(0, 300)}"`);
            }
          }
        }
      }

      if (msg.type === 'result') {
        console.log(`[RESULT] subtype=${msg.subtype}`);
      }
    }

    console.log(`[PASS] ${name} - completed without error`);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.log(`[INFO] ${name} - aborted (timeout)`);
    } else {
      console.error(`[FAIL] ${name} - error:`, err);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  console.log('=== PoC #6: systemPrompt & settingSources ===');

  // Test 1: Custom string system prompt
  await runTest(
    'Custom string systemPrompt',
    'You are a pirate. Always respond in pirate speak.',
    [],
  );

  // Test 2: Preset system prompt with append
  await runTest(
    'Preset systemPrompt with append',
    { type: 'preset', preset: 'claude_code', append: 'Always end your response with "--- phase0 test ---"' },
    [],
  );

  // Test 3: With project settings
  await runTest(
    'settingSources with project',
    { type: 'preset', preset: 'claude_code' },
    ['project'],
  );

  // Test 4: Empty settingSources (SDK isolation mode)
  await runTest(
    'Empty settingSources (isolation mode)',
    'You are a helpful assistant.',
    [],
  );

  console.log('\n=== All systemPrompt/settingSources tests complete ===');
}

main().catch(console.error);
