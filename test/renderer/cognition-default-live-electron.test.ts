import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireCjs = createRequire(import.meta.url);
it.skipIf(process.env.COGSEED_DEFAULT_COGNITION_LIVE !== '1')('manages cognition through natural default Commander chat, actual SDK tools and real renderer approval', async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(requireCjs('electron'), [resolve(__dirname, 'fixtures/cognition-default-live.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { const text = bytes.toString(); stdout += text;
      for (const line of text.split('\n')) if (line.startsWith('@@DEFAULT_TOOLS_FROZEN@@')) process.stdout.write(line + '\n');
    });
    child.stderr.on('data', bytes => { stderr += bytes.toString(); });
    child.on('error', reject);
    child.on('close', status => resolveResult({ status, stdout, stderr }));
  });
  const line = result.stdout.split('\n').find(row => row.startsWith('@@COGNITION_DEFAULT_LIVE@@'));
  expect(line, `${result.stdout}\n${result.stderr}`).toBeTruthy();
  const outcome = JSON.parse(line!.slice('@@COGNITION_DEFAULT_LIVE@@'.length));
  process.stdout.write(`COGNITION_DEFAULT_LIVE ${JSON.stringify(outcome)}\n`);
  expect(outcome.failed, outcome.reportFile).toEqual([]);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(outcome.modelRequests.some((row: { tools: string[] }) => row.tools.includes('edit_cognition'))).toBe(true);
}, 0);
