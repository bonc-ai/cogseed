/** @ 注入的矛盾提示行（specs/014 US-903 / T021）。纯函数缝：
 *  无冲突零差异 / 有冲突加行且字段去重 ≤3 / 回执不 ok 或读失败（undefined）
 *  → 空串（正文注入不受影响）。 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/chat-use.js'), 'utf8');

function loadHelper() {
  // chat-use.js 是顶层 await 的模块——vm 按脚本装载会炸。这里只抽取
  // buildConflictNotices 纯函数的源码段执行（它不依赖任何模块级状态）。
  const start = source.indexOf('function buildConflictNotices(');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('window.__buildChatUseConflictNotices', start);
  expect(end).toBeGreaterThan(start);
  const fnSource = source.slice(start, end);
  const context: any = { window: {} };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${fnSource}\nwindow.__fn = buildConflictNotices;`, context, { filename: 'chat-use-helper.js' });
  return context.window.__fn as
    (response: unknown, translate: (key: string, vars?: Record<string, unknown>) => string) => string;
}

describe('chat-use 矛盾提示行（specs/014 T021）', () => {
  it('无冲突 → 空串（注入正文逐字不变，零差异 I-9）', () => {
    const build = loadHelper();
    const t = (key: string) => key;
    expect(build({ ok: true, conflicts: [] }, t)).toBe('');
    expect(build({ ok: false }, t)).toBe('');
    expect(build(undefined, t)).toBe('');
  });

  it('有冲突 → 追加提示行；字段去重且最多 3 行', () => {
    const build = loadHelper();
    const t = (key: string, vars?: Record<string, unknown>) => `${key}:${String((vars as any)?.field ?? '')}`;
    const one = build({ ok: true, conflicts: [{ field: '居住地' }] }, t);
    expect(one).toBe('\npersonalOntology.use_conflict_notice:居住地');
    // 同字段两条只提示一次；不同字段各一行；第 4 个字段被截。
    const many = build({ ok: true, conflicts: [
      { field: '居住地' }, { field: '居住地' }, { field: '工作地' }, { field: '常驻地' }, { field: '第四字段' },
    ] }, t);
    expect(many.split('\n')).toHaveLength(4); // 首行空 + 3 行提示
    expect(many).not.toContain('第四字段');
  });
});
