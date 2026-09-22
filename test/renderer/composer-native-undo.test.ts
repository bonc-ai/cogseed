// MA-06（验收报告 P2）：删除成员标记后，原生撤销必须能恢复。
//
// 真机现象：首页输入 ASCII 文本后从成员列表选 Codex，光标在标记后按 Backspace，
// 标记与成员被移除；再按 Cmd+Z 不恢复。原因是 agents.js 的旧 Backspace 处理仍绑在
// 富编辑器上：它 preventDefault 并直接改写 textarea.value，绕过了 Chromium 的原生
// 撤销栈（conversation.js 的 editor keydown 明确声明「Chromium 拥有默认动作」）。
//
// 报告要求「在真正的富文本 DOM 中按键删除、撤销、重做，仅模拟 historyUndo 事件
// 不足以证明原生撤销栈有效」，因此这里用真实 Chromium：真实编辑命令删除 → 原生
// undo/redo。
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.join(__dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('composer native undo contract (MA-06)', () => {
  it('binds the legacy Backspace handler only to the plain-textarea fallback', () => {
    const agents = read('src/renderer/modules/agents.js');
    const bindings = agents.match(/addEventListener\('keydown', _onMentionBackspace\)/g) || [];
    expect(bindings).toHaveLength(1);
    // 富编辑器分支只绑 `@` 打开器，删除交给 Chromium 原生（可撤销）。
    expect(agents).toContain("rich.addEventListener('keydown', _atKeyOpener(chipId));");
    const at = agents.indexOf('const rich = getChatRichComposerEditor(inputId);');
    expect(at).toBeGreaterThan(0);
    const richBlock = agents.slice(at, at + 900);
    expect(richBlock).not.toContain('_onMentionBackspace');
  });

  // Windows hosted Chromium exits with STATUS_BREAKPOINT on sibling fixtures.
  it.skipIf(process.platform === 'win32')('restores the mention chip through the native undo stack', () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures/composer-native-undo.cjs')], {
      env,
      encoding: 'utf8',
      timeout: 60000,
    });
    const output = String(result.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
    const parsed = JSON.parse(output);
    expect(parsed.error, `${parsed.error || ''}\n${parsed.stack || ''}\n${result.stderr || ''}`).toBeUndefined();
    expect(parsed.failed).toEqual([]);
    expect(parsed.passed).toBe(parsed.total);
    expect(result.status).toBe(0);
  }, 70000);
});
