import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-28 四病整改第零批 B11（审计 D1）：对话侧保存候选走主进程写通道、
// 无 cognition:changed 广播直达面板；面板可能早已开在内存里，跳转函数若不
// 重取，刚保存的候选会按陈旧 store 判成「这条建议已不在待处理列表」假空态
// （views.js candidate_detail_missing）。修法＝两个跳转入口在 router.go 后
// 补 void NS.reload()：跳转立即完成（同步 return true 不等网络），数据由
// reload 的 onChange 监听重画补上。
// ─────────────────────────────────────────────────────────────────────────────

const core = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/cognition-assets/core.js'),
  'utf8',
);

/** 从 `{` 起按深度取一段，跳过字符串与注释里的括号（与 recall-cognition-flow 同款）。 */
function sliceBlock(source: string, start: number): string {
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated block');
}

/** 取 core.js 里某个 window 跳转函数赋值的完整块。 */
function jumpBlock(marker: string): string {
  const start = core.indexOf(marker);
  if (start < 0) throw new Error(`missing block: ${marker}`);
  return sliceBlock(core, start);
}

describe('对话跳转认知面板时重取数据（B11 假空态）', () => {
  it('资产引用卡跳转在路由后补一次 NS.reload，且不阻塞跳转本身', () => {
    const jump = jumpBlock('window.openCognitionAssetById');
    expect(jump).toContain("router.go({ name: 'overview'");
    expect(jump).toContain('void NS.reload()');
    // void＝不 await：跳转同步返回 true（调用方 conversation.js 靠它决定
    // 是否走懒加载 fallback），数据重取在后台补画。
    expect(jump).not.toContain('await NS.reload()');
    expect(jump).toContain('return true');
  });

  it('候选「确认或修改」跳转同样重取，刚保存的候选不再显示成已不在列表', () => {
    const jump = jumpBlock('window.openCognitionCandidateById');
    expect(jump).toContain("router.go({ name: 'review'");
    expect(jump).toContain('void NS.reload()');
    expect(jump).not.toContain('await NS.reload()');
    expect(jump).toContain('return true');
  });
});
