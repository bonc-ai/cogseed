import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';

const window: Record<string, any> = {};
runInNewContext(readFileSync(resolve('src/renderer/modules/cognition-ontology-selection.js'), 'utf8'), { window });
const parse = window.CogOntologySelection.parseRequest;

describe('本地文字修改建议', () => {
  it('只在所选片段内执行明确替换、追加或删除', () => {
    expect(parse('把「旧」改为「新」', '这是旧说明')).toEqual({ replacement: '这是新说明' });
    expect(parse('改为「新的说明」', '旧说明')).toEqual({ replacement: '新的说明' });
    expect(parse('在后面补充「，需要核对」', '说明')).toEqual({ replacement: '说明，需要核对' });
    expect(parse('删除所选文字', '需要删除')).toEqual({ replacement: '' });
    expect(parse('change to "new wording"', 'old wording')).toEqual({ replacement: 'new wording' });
  });
  it('重复原文与超出模拟范围的指令不会生成修改', () => {
    for (const [request, original] of [['把「甲」改为「乙」', '甲与甲'], ['把「甲」改为「乙」', '丙'], ['请优化并发布这些内容', '原文']]) {
      const result = parse(request, original);
      expect(result.error).toBeTruthy();
      expect(result.replacement).toBeUndefined();
    }
  });
  it('日期指令明确标出变更起点，纠正指令标出纠正意图', () => {
    expect(parse('从 2026-10-12 起改为「新值」', '旧值')).toEqual({ replacement: '新值', date: '2026-10-12' });
    expect(parse('纠正为「正确值」', '旧值')).toEqual({ replacement: '正确值', intent: 'correct' });
  });
  it('建议将带 HTML 的输入作为普通文字保留', () => {
    expect(parse('改为「<img src=x onerror=alert(1)>」', '原文')).toEqual({ replacement: '<img src=x onerror=alert(1)>' });
  });
});
