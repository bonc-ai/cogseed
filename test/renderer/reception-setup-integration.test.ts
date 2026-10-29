import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
const require = createRequire(import.meta.url);

function runSetup(scenario: string) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [resolve(__dirname, 'fixtures/reception-setup.cjs'), scenario], {
    env, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL',
  });
  expect(result.status, `${result.error || ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
  // 只解析带哨兵的结果行：Electron 在 win32 上可能额外往 stdout 写自己的行，
  // 「取最后一行」会把噪音当结论（CI 里是 `Unexpected number in JSON at position 1`）。
  const line = result.stdout.split('\n').find(row => row.startsWith('@@RECEPTION_SETUP@@'));
  expect(line, `no result line in stdout:\n${result.stdout}\n${result.stderr}`).toBeTruthy();
  return JSON.parse(line!.slice('@@RECEPTION_SETUP@@'.length));
}

it.each(['empty', 'populated'])('T4a reception catalog real owning APIs leave the %s user tree unchanged on open/cancel', scenario => {
  const result = runSetup(scenario);
  expect(result.noWrites, result.changedPaths.join('\n')).toBe(true);
  expect(result.calls).toEqual(['a2a.reception.setup']);
  expect(result.confirms).toBe(0);
  expect(result.spaces).toEqual(scenario === 'empty' ? ['','custom'] : ['', 'space:sp_owned', 'custom']);
  expect(result.agents).toEqual(scenario === 'empty' ? [''] : ['', 'install-corrupt', 'local-stable', 'shared-stable']);
  // The duplicate identity resolves to the same option value from either source;
  // only the rendered label proves the marketplace definition won.
  if (scenario !== 'empty') expect(result.agentLabels['shared-stable']).toBe('Market receiver');
  expect(result.projectionKeys).toEqual(scenario === 'empty' ? [] : ['agent_id', 'name']);
}, 35000);

it('T4a reception catalog real page translates the default assistant option in four languages while preserving choice and draft', () => {
  const result = runSetup('i18n');
  expect(result.error).toBeUndefined();
  expect(result.languages).toEqual(['zh','ja','pt','en']);
  expect(result.confirms).toBe(0);
}, 35000);
