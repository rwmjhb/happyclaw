/**
 * Phase 0 PoC #5: Complete message type taxonomy
 *
 * This is the most important script -- it maps the complete SDKMessage type taxonomy.
 *
 * Verifies:
 * - All message types emitted during a tool-using query
 * - Full JSON structure of each message type
 * - Message ordering and relationships
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  console.log('=== PoC #5: Complete Message Type Taxonomy ===\n');

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    console.log('\n[TIMEOUT] Aborting after 30s');
    abortController.abort();
  }, TIMEOUT_MS);

  try {
    console.log('[INFO] Querying Claude with a prompt that will trigger tool use...\n');

    const response = query({
      prompt: 'Read the file /tmp/happyclaw-phase0-test/test-file.txt using the Read tool. If it does not exist, just say so.',
      options: {
        cwd: '/tmp/happyclaw-phase0-test',
        abortController,
        maxTurns: 2,
        permissionMode: 'acceptEdits',
        allowedTools: ['Read', 'Glob', 'Bash'],
      },
    });

    const allMessages: Array<{ index: number; type: string; summary: string; full: unknown }> = [];
    let messageCount = 0;

    for await (const message of response) {
      messageCount++;
      const msg = message as SDKMessage;

      // Determine the type key
      let typeKey: string;
      if (msg.type === 'system' && 'subtype' in msg) {
        typeKey = `system:${msg.subtype}`;
      } else if (msg.type === 'result' && 'subtype' in msg) {
        typeKey = `result:${msg.subtype}`;
      } else {
        typeKey = msg.type;
      }

      // Build a summary based on type
      let summary = '';
      switch (msg.type) {
        case 'system':
          if ('subtype' in msg) {
            if (msg.subtype === 'init') {
              const init = msg as Record<string, unknown>;
              summary = `model=${init.model}, tools=[${(init.tools as string[])?.join(', ')}], cwd=${init.cwd}`;
            } else {
              summary = `subtype=${(msg as Record<string, unknown>).subtype}`;
            }
          }
          break;
        case 'assistant': {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            const parts = content.map((block: Record<string, unknown>) => {
              if (block.type === 'text') return `text:"${String(block.text).substring(0, 80)}"`;
              if (block.type === 'tool_use') return `tool_use:${block.name}`;
              if (block.type === 'thinking') return `thinking:${String(block.thinking).substring(0, 80)}`;
              return `${block.type}`;
            });
            summary = parts.join(', ');
          }
          summary += ` | parent_tool_use_id=${msg.parent_tool_use_id} | uuid=${msg.uuid}`;
          break;
        }
        case 'user':
          summary = `parent_tool_use_id=${msg.parent_tool_use_id}`;
          if (msg.message?.role) summary += ` | role=${msg.message.role}`;
          if ('isReplay' in msg) summary += ' | isReplay=true';
          break;
        case 'result':
          if ('result' in msg) {
            summary = `subtype=${msg.subtype} | result="${String(msg.result).substring(0, 100)}"`;
          } else {
            summary = `subtype=${msg.subtype} | is_error=${msg.is_error}`;
          }
          summary += ` | cost=$${msg.total_cost_usd}`;
          break;
        case 'tool_progress': {
          const tp = msg;
          summary = `tool=${tp.tool_name} | tool_use_id=${tp.tool_use_id} | elapsed=${tp.elapsed_time_seconds}s`;
          break;
        }
        default:
          summary = JSON.stringify(msg).substring(0, 200);
      }

      allMessages.push({
        index: messageCount,
        type: typeKey,
        summary,
        full: msg,
      });

      console.log(`\n[MSG ${messageCount}] type=${typeKey}`);
      console.log(`  summary: ${summary}`);
      console.log(`  keys: ${Object.keys(msg).join(', ')}`);
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[TYPE TAXONOMY SUMMARY]`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Total messages: ${messageCount}\n`);

    // Group by type
    const typeGroups = new Map<string, number>();
    for (const m of allMessages) {
      typeGroups.set(m.type, (typeGroups.get(m.type) || 0) + 1);
    }

    console.log('Message type distribution:');
    for (const [type, count] of typeGroups) {
      console.log(`  ${type}: ${count}`);
    }

    console.log('\nMessage sequence:');
    for (const m of allMessages) {
      console.log(`  [${m.index}] ${m.type}`);
    }

    // Print full JSON of one message of each type
    const seenTypes = new Set<string>();
    console.log('\nFull JSON examples (one per type):');
    for (const m of allMessages) {
      if (!seenTypes.has(m.type)) {
        seenTypes.add(m.type);
        console.log(`\n--- ${m.type} ---`);
        console.log(JSON.stringify(m.full, null, 2).substring(0, 1000));
      }
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
