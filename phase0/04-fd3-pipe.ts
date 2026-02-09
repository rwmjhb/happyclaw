/**
 * Phase 0 PoC #4: fd3 pipe validation
 *
 * Verifies:
 * - Can spawn `claude` CLI process with fd3 pipe
 * - fd3 emits thinking state events
 * - Proper line-delimited JSON parsing
 *
 * Note: This test spawns the `claude` CLI directly (not via SDK query()),
 * simulating the local mode experience from the technical proposal.
 */

import { spawn } from 'child_process';

const TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  console.log('=== PoC #4: fd3 Pipe ===\n');

  // Find claude executable
  const claudePath = 'claude';

  console.log(`[INFO] Spawning ${claudePath} with fd3 pipe...`);

  // fd3 pipe is designed for LOCAL interactive mode (stdio inherit for 0/1/2, pipe for fd3).
  // It does NOT work with --output-format stream-json (that's the remote/SDK mode).
  // Test A: spawn with fd3 pipe in --print mode (non-interactive, plaintext stdout)
  const child = spawn(claudePath, [
    '--print',
    '--max-turns', '1',
    'Say "hello fd3 test" and nothing else. Do not use any tools.',
  ], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    cwd: '/tmp/happyclaw-phase0-test',
  });

  const fd3Events: unknown[] = [];
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let fd3Buffer = '';

  // Close stdin since --print mode gets prompt from args, not stdin
  child.stdin.end();

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      console.log('\n[TIMEOUT] Killing process after 30s');
      child.kill('SIGTERM');
    }, TIMEOUT_MS);

    // Read fd3 (stdio[3]) with line-delimited JSON parsing
    const fd3Stream = child.stdio[3];
    if (fd3Stream && 'on' in fd3Stream) {
      (fd3Stream as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
        fd3Buffer += chunk.toString();
        const lines = fd3Buffer.split('\n');
        fd3Buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            fd3Events.push(parsed);
            console.log(`[FD3] ${JSON.stringify(parsed).substring(0, 300)}`);
          } catch {
            console.log(`[FD3 RAW] ${line.substring(0, 300)}`);
          }
        }
      });

      (fd3Stream as NodeJS.ReadableStream).on('error', (err: Error) => {
        console.log(`[FD3 ERROR] ${err.message}`);
      });
    } else {
      console.log('[WARN] fd3 stream not available');
    }

    // Read stdout
    child.stdout.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      stdoutChunks.push(data);
      // Parse each line as JSON (stream-json format)
      const lines = data.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          console.log(`[STDOUT] type=${parsed.type}${parsed.subtype ? `:${parsed.subtype}` : ''}`);
        } catch {
          // Not all stdout output is JSON
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timeout);

      // Process remaining fd3 buffer
      if (fd3Buffer.trim()) {
        try {
          const parsed = JSON.parse(fd3Buffer);
          fd3Events.push(parsed);
          console.log(`[FD3] ${JSON.stringify(parsed).substring(0, 300)}`);
        } catch {
          console.log(`[FD3 RAW] ${fd3Buffer.substring(0, 300)}`);
        }
      }

      console.log(`\n[SUMMARY]`);
      console.log(`  Exit code: ${code}`);
      console.log(`  Signal: ${signal}`);
      console.log(`  fd3 events captured: ${fd3Events.length}`);
      console.log(`  fd3 event types: ${fd3Events.map(e => {
        const evt = e as Record<string, unknown>;
        return evt.type || 'unknown';
      }).join(', ')}`);

      console.log(`  stdout length: ${stdoutChunks.join('').length}`);
      console.log(`  stdout preview: ${stdoutChunks.join('').substring(0, 500)}`);

      if (stderrChunks.length > 0) {
        console.log(`  stderr: ${stderrChunks.join('').substring(0, 500)}`);
      }

      resolve();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[ERROR] Failed to spawn claude:', err.message);
      resolve();
    });
  });
}

main().catch(console.error);
