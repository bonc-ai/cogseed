import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
const require = createRequire(import.meta.url);
it('T4a real relay-inbox/shared UI/preload previews every selection, cancels, refreshes stale confirmation and restores pending', () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [resolve(__dirname, 'fixtures/reception-workspace.cjs')], { env, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  expect(result.status, `${result.error || ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
  // 只解析带哨兵的结果行：Electron 在 win32 上可能额外往 stdout 写自己的行，
  // 「取最后一行」会把噪音当结论（CI 里是 `Unexpected number in JSON at position 1`）。
  const line = result.stdout.split('\n').find(row => row.startsWith('@@RECEPTION_WORKSPACE@@'));
  expect(line, `no result line in stdout:\n${result.stdout}\n${result.stderr}`).toBeTruthy();
  const output = JSON.parse(line!.slice('@@RECEPTION_WORKSPACE@@'.length));
  expect(output.checks.length).toBeGreaterThanOrEqual(14);
  expect(output.confirms).toHaveLength(2);
  expect(output.confirms[0].expectedPreview).toEqual({ root: '/server/default', snapshot: 'default-v1' });
  expect(output.confirms[1].expectedPreview).toEqual({ root: '/server/changed', snapshot: 'default-v2' });
}, 35000);
