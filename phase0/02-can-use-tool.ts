/**
 * Phase 0 PoC #2: canUseTool callback validation
 *
 * Verifies:
 * - canUseTool callback is invoked when Claude tries to use a tool
 * - Logs the full callback parameters (toolName, input, options)
 * - Tests returning { behavior: 'allow' } and { behavior: 'deny' }
 * - Validates CanUseTool type signature
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

const TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  console.log('=== PoC #2: canUseTool Callback ===\n');

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    console.log('\n[TIMEOUT] Aborting after 30s');
    abortController.abort();
  }, TIMEOUT_MS);

  const toolCalls: Array<{
    toolName: string;
    input: Record<string, unknown>;
    hasSignal: boolean;
    hasSuggestions: boolean;
    toolUseID: string;
    agentID?: string;
    blockedPath?: string;
    decisionReason?: string;
  }> = [];

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    console.log(`\n[canUseTool CALLED]`);
    console.log(`  toolName: ${toolName}`);
    console.log(`  input: ${JSON.stringify(input).substring(0, 300)}`);
    console.log(`  options.signal: ${options.signal ? 'AbortSignal (present)' : 'undefined'}`);
    console.log(`  options.suggestions: ${JSON.stringify(options.suggestions)?.substring(0, 200)}`);
    console.log(`  options.toolUseID: ${options.toolUseID}`);
    console.log(`  options.agentID: ${options.agentID}`);
    console.log(`  options.blockedPath: ${options.blockedPath}`);
    console.log(`  options.decisionReason: ${options.decisionReason}`);

    toolCalls.push({
      toolName,
      input,
      hasSignal: !!options.signal,
      hasSuggestions: !!options.suggestions,
      toolUseID: options.toolUseID,
      agentID: options.agentID,
      blockedPath: options.blockedPath,
      decisionReason: options.decisionReason,
    });

    // Allow the first tool call, deny subsequent ones to test both paths
    const result: PermissionResult = toolCalls.length <= 1
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: 'Denied by phase0 test' };

    console.log(`  -> Returning: ${JSON.stringify(result)}`);
    return result;
  };

  try {
    console.log('[INFO] Calling query() with canUseTool callback...');
    console.log('[INFO] Prompt asks Claude to list files (should trigger Bash or Glob tool)\n');

    // Using permissionMode 'default' to trigger canUseTool for Bash
    // Note: read-only tools (Read, Glob, Grep) may be auto-allowed.
    // Bash requires explicit permission in default mode.
    const response = query({
      prompt: 'Run a bash command: echo "canUseTool test". Just do it, no explanation needed.',
      options: {
        cwd: '/tmp/happyclaw-phase0-test',
        abortController,
        maxTurns: 2,
        canUseTool,
        settingSources: [],
      },
    });

    let messageCount = 0;
    for await (const message of response) {
      messageCount++;
      const msg = message as SDKMessage;

      if (msg.type === 'assistant') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use') {
              console.log(`\n[MSG ${messageCount}] assistant tool_use: ${block.name}`);
            }
          }
        }
      }

      if (msg.type === 'result') {
        console.log(`\n[MSG ${messageCount}] result: subtype=${msg.subtype}`);
      }
    }

    console.log(`\n[SUMMARY]`);
    console.log(`  Total messages: ${messageCount}`);
    console.log(`  canUseTool invocations: ${toolCalls.length}`);
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      console.log(`  [${i + 1}] tool=${tc.toolName}, toolUseID=${tc.toolUseID}, hasSignal=${tc.hasSignal}, hasSuggestions=${tc.hasSuggestions}`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.log('[INFO] Query was aborted (timeout)');
    } else {
      console.error('[ERROR]', err);
    }
  } finally {
    clearTimeout(timeout);
  }
}

main().catch(console.error);
