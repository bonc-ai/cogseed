import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

describe('shared resource grids in Chromium', () => {
  // Windows hosted runner 上无头 Chromium（BrowserWindow + insertCSS）会以
  // STATUS_BREAKPOINT 崩溃——与打包 STT smoke 同口径的已知平台缺口。此测试
  // 是纯布局契约，macOS/本地 Chromium 已验证，Windows 上跳过并在 runner
  // 修复后恢复。
  it.skipIf(process.platform === 'win32')('switches at content-width breakpoints, fills tracks and stays overflow-free', () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [resolve(__dirname, 'fixtures/resource-grid-layout.cjs')], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('"passed":126');
  }, 35000);
});
