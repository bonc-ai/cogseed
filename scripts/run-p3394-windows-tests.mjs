#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

if (process.platform !== 'win32') {
  console.error(`[p3394-windows-tests] requires win32; received ${process.platform}`);
  process.exit(1);
}

const suites = [
  'test/main/features/local_agents/spawn-command.test.ts',
  'test/main/features/local_agents/version.test.ts',
  'test/main/features/local_agents/base.test.ts',
  'test/main/features/p3394_bridge/gateway-models-probe.test.ts',
  'test/main/features/p3394_bridge/p3394-windows-cli.test.ts',
  'test/main/features/p3394_bridge/external-gateways.test.ts',
  'test/main/features/sscli-shim-cancel.test.ts',
  'test/main/features/cogseed_backend/worktree-manager.test.ts',
];

const result = spawnSync(process.execPath, [
  resolve(here, 'run-tests.mjs'),
  'run',
  '--maxWorkers=1',
  ...suites,
], {
  cwd: root,
  env: { ...process.env, COGSEED_P3394_WINDOWS_GATE: '1' },
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
