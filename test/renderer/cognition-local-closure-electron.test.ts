import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireCjs = createRequire(import.meta.url);
it.skipIf(!process.env.COGSEED_LOCAL_CLOSURE_ELECTRON)(
  'closes cognition approval navigation or a natural inventory conversation through the production Electron entry', async () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(requireCjs('electron'), [resolve(__dirname, 'fixtures/cognition-local-closure.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes.toString(); });
      child.stderr.on('data', bytes => { stderr += bytes.toString(); });
      child.on('error', reject);
      child.on('close', status => done({ status, stdout, stderr }));
    });
    const line = result.stdout.split('\n').find(row => row.startsWith('@@COGNITION_LOCAL_CLOSURE@@'));
    expect(line, `${result.stdout}\n${result.stderr}`).toBeTruthy();
    const outcome = JSON.parse(line!.slice('@@COGNITION_LOCAL_CLOSURE@@'.length));
    process.stdout.write(`COGNITION_LOCAL_CLOSURE ${JSON.stringify(outcome)}\n`);
    expect(outcome.failed, outcome.reportFile).toEqual([]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    if (process.env.COGSEED_LOCAL_CLOSURE_LIVE === '1') expect(outcome.modelRequests.length).toBeGreaterThan(0);
    else expect(outcome.modelRequests).toHaveLength(0);
  }, 0,
);
