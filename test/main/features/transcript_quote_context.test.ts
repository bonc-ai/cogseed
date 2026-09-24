/**
 * transcript_quote_context — 引例语境判定（扫描通道防误改的单一事实源）
 *
 * 覆盖：
 *   1. 真实引例句式必须命中（三种：标记词在错形前、紧跟、在句末）；
 *   2. 窗口外/无标记必须不命中（否则等于把功能关掉——全段候选都不预勾）；
 *   3. 折叠归一：全角/大小写差异不影响判定（输入法常见）；
 *   4. `hasQuoteMarker` 的文档级语义（重建层复用同一条规则）。
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_QUOTE_WINDOW,
  QUOTE_MARKERS,
  findQuoteContext,
  hasQuoteMarker,
} from '../../../src/main/features/transcript_quote_context';

/** 模拟主进程：折叠全文后按 span 判定（下标与原文一一对应，理由见 foldText 注释）。 */
function at(text: string, needle: string, window?: number): string | null {
  const index = text.indexOf(needle);
  expect(index).toBeGreaterThanOrEqual(0);
  const folded = text.normalize('NFKC').toLowerCase();
  const span = { start: index, end: index + needle.length };
  return window === undefined ? findQuoteContext(folded, span) : findQuoteContext(folded, span, window);
}

describe('引例语境：必须命中的真实句式', () => {
  it('标记词紧贴在错形前（"一会儿叫 coxy"）', () => {
    expect(at('一会儿叫 coxy，一会儿叫别的', 'coxy')).toBe('一会儿叫');
  });

  it('标记词与错形隔几个字（"词汇表应该有 coxy"）', () => {
    expect(at('词汇表应该有 coxy', 'coxy')).toBe('词汇表');
  });

  it('标记词在错形之后（"...老被识别成 智能题"）', () => {
    // 现实语序：错形在前、说明在后
    expect(at('智能体老被写成 智能题', '智能题')).toBe('写成');
  });

  it('标记词覆盖全部条目（列表被改动过要能被测试发现）', () => {
    // 只做"这条规则存在"的锚点：标记表被清空/误删时立刻红
    expect(QUOTE_MARKERS.length).toBeGreaterThanOrEqual(10);
    expect(QUOTE_MARKERS).toContain('识别成');
    expect(QUOTE_MARKERS).toContain('词汇表');
  });
});

describe('引例语境：必须不命中的情形（避免把功能关掉）', () => {
  it('窗口内没有任何标记词 → null', () => {
    expect(at('下周由 coxy 那边负责上线', 'coxy')).toBeNull();
  });

  it('标记词在窗口之外 → null（窗口放大到整段会让全段候选都不预勾）', () => {
    const text = '词汇表应该有别的写法，这事以后再说。' + '占位文字。'.repeat(10) + '下周 coxy 上线';
    expect(at(text, 'coxy')).toBeNull();
  });

  it('空文本 / 非法 span → null（不抛错）', () => {
    expect(findQuoteContext('', { start: 0, end: 1 })).toBeNull();
    expect(findQuoteContext('abc', { start: Number.NaN, end: 1 })).toBeNull();
    expect(findQuoteContext('abc', { start: 0, end: 0 })).toBeNull();
  });

  it('窗口边界：紧贴窗口内命中、超出 1 字不命中', () => {
    const marker = '拼写';
    const filler = '字'.repeat(DEFAULT_QUOTE_WINDOW - marker.length);
    const inside = `${marker}${filler}coxy`;
    const outside = `${marker}${filler}字coxy`;
    expect(at(inside, 'coxy')).toBe(marker);
    expect(at(outside, 'coxy')).toBeNull();
  });
});

describe('折叠归一', () => {
  it('全角/大小写差异不影响判定（输入法常见）', () => {
    // 全角 "ＣＯＸＹ" + 标记词：折叠后仍能判定
    const text = '一会儿叫 ＣＯＸＹ 的那个';
    const index = text.indexOf('ＣＯＸＹ');
    const folded = text.normalize('NFKC').toLowerCase();
    expect(findQuoteContext(folded, { start: index, end: index + 'ＣＯＸＹ'.length })).toBe('一会儿叫');
  });

  it('多个标记同时在窗口内时报最近的那个（面板文案说"附近出现「X」"）', () => {
    // '拼写' 结尾离 cox 更近 → 报「拼写」（'这个词' 也在窗口内，但更远）
    expect(at('这个词的拼写 cox', 'cox')).toBe('拼写');
    // 反过来：'这个词' 更近 → 报「这个词」
    expect(at('拼写的这个词 cox', 'cox')).toBe('这个词');
  });
});

describe('hasQuoteMarker（文档级，重建层复用同一条规则）', () => {
  it('出现任一标记即为真；没有标记为假', () => {
    expect(hasQuoteMarker('刚才那个词老被识别成别的')).toBe(true);
    expect(hasQuoteMarker('我们下周把方案定下来')).toBe(false);
    expect(hasQuoteMarker('')).toBe(false);
  });

  it('大小写/全角不敏感', () => {
    expect(hasQuoteMarker('这个词的 WRITE 形式')).toBe(true);
  });
});

describe('窗口不跨句（2026-09-22 单测抓出的真问题）', () => {
  it('上一句的标记不该把下一句的真实指称降级成引例', () => {
    const text = '一会儿叫 coxy，一会儿叫别的。下周 coxy 那边上线。';
    const first = text.indexOf('coxy');
    const second = text.lastIndexOf('coxy');
    const folded = text.normalize('NFKC').toLowerCase();
    expect(findQuoteContext(folded, { start: first, end: first + 4 })).toBe('一会儿叫');
    // 第二处与第一处相距不足窗口宽度，但跨了句号 → 不命中
    expect(findQuoteContext(folded, { start: second, end: second + 4 })).toBeNull();
  });

  it('句内隔几个字仍然命中（逗号不算边界，真人引例常这么写）', () => {
    const text = '这个词，我们以前写成 coxy 了。';
    const index = text.indexOf('coxy');
    const folded = text.normalize('NFKC').toLowerCase();
    // 「写成」紧贴 coxy（比「这个词」更近）→ 报最近的它；关键是**跨过逗号仍然命中**
    expect(findQuoteContext(folded, { start: index, end: index + 4 })).toBe('写成');
  });

  it('换行也算句子边界', () => {
    const text = '识别成别的了\n下周 coxy 上线';
    const index = text.indexOf('coxy');
    const folded = text.normalize('NFKC').toLowerCase();
    expect(findQuoteContext(folded, { start: index, end: index + 4 })).toBeNull();
  });
});
