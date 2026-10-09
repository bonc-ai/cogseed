// MA-07（验收报告 P2）：成员列表选一项后不得关闭，完成入口必须可用。
//
// 真机现象：点底部成员入口，选 CogSeed 后列表立即关闭；重新打开选 Codex、再打开
// 选 WorkBuddy，每次均关闭；重新打开也看不到「完成」。
//
// 根因两条：
//   1. 行 click 会重建候选列表，事件目标因此脱离 DOM，冒泡到 document 的
//      outside-click 判定 `picker.contains(e.target)` 变成 false → 当成外部点击关闭；
//   2. 关闭时 footer 被隐藏，重开渲染成员列表只更新计数、不恢复可见性。
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.join(__dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('composer member picker multiselect (MA-07)', () => {
  it('judges inside clicks by the dispatch path, not by a detached target', () => {
    const agents = read('src/renderer/modules/agents.js');
    expect(agents).toContain("const path = typeof e.composedPath === 'function' ? e.composedPath() : [];");
    expect(agents).toContain('if (path.includes(picker) || picker.contains(e.target)) return;');
  });

  it('restores the finish affordance whenever the member list is rendered again', () => {
    const members = read('src/renderer/modules/composer-members.js');
    expect(members).toMatch(/function updatePickerChrome\(picker, target, mode\) \{[\s\S]*?foot\.hidden = false;/);
  });

  it('still collapses the finish affordance when the picker closes', () => {
    const agents = read('src/renderer/modules/agents.js');
    expect(agents).toMatch(/function _closeAgentPicker\([\s\S]*?foot\.hidden = true;/);
  });

  // Windows hosted Chromium exits with STATUS_BREAKPOINT on sibling fixtures.
  it.skipIf(process.platform === 'win32')('keeps the picker open after a row click rebuilds the list', () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures/composer-multiselect-dom.cjs')], {
      env,
      encoding: 'utf8',
      timeout: 60000,
    });
    const output = String(result.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
    const parsed = JSON.parse(output);
    expect(parsed.error, `${parsed.error || ''}\n${parsed.stack || ''}\n${result.stderr || ''}`).toBeUndefined();
    expect(parsed.failed).toEqual([]);
    expect(result.status).toBe(0);
  }, 70000);
});
