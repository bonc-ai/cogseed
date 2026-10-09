/**
 * transcript_filler_rules — 口癖规则包（方案 v0.2 §五 P1-1）
 *
 * 这组测试守的是"保守"两个字：宁可漏删，也不能把正常表达删掉。
 * 验收口径（§8.1-3）：白名单词句首/独立出现才删；`就是/然后` 降幅 <95%。
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FILLER_RULES,
  FILLER_PACK_VERSION,
  detectFillers,
  fillerRuleEntries,
  fillerRuleFor,
} from '../../../src/main/features/transcript_filler_rules';
import { applyCorrections, scanText } from '../../../src/main/features/transcript_auto_correct';
import type { GlossaryEntry } from '../../../src/main/features/transcript_glossary';

function fillerEntry(term: string): GlossaryEntry {
  return {
    id: `g_f_${term}`,
    wrong: term,
    correct: '',
    action: 'delete',
    kind: 'filler',
    riskLevel: 'low',
    boundary: 'substring',
    contextDeny: [],
    contextAllow: [],
    scope: { docIds: [], scenarioTags: [], global: true },
    freq: 0,
    source: 'import',
    status: 'active',
    ownerScope: 'personal',
    replacedIn: [],
    createdBy: 'import',
    createdAt: 1,
    updatedAt: 1,
    lastVerifiedAt: 1,
  };
}

const deletedOf = (text: string, terms: string[]): string[] =>
  detectFillers(text, DEFAULT_FILLER_RULES.filter((r) => terms.includes(r.term)))
    .map((m) => `${m.term}@${m.span.start}`);

describe('规则包本身', () => {
  it('版本号与规则清单是稳定的（run 里要能回看当时用的哪版）', () => {
    expect(FILLER_PACK_VERSION).toBe('v1');
    expect(DEFAULT_FILLER_RULES.map((r) => r.term)).toEqual(
      ['嗯', '呃', '啊', '哦', '这个', '那个', '的话', '就是', '然后', '对'],
    );
    // 三档策略各自归位：感叹词=出现即删、从句粒子=右侧标点、语义连词=重复或纯应答
    expect(DEFAULT_FILLER_RULES.filter((r) => r.mode === 'interjection').map((r) => r.term))
      .toEqual(['嗯', '呃', '啊', '哦']);
    expect(DEFAULT_FILLER_RULES.filter((r) => r.mode === 'repeated').map((r) => r.term))
      .toEqual(['就是', '然后', '对']);
  });

  it('导出的词条是 action=delete + kind=filler（走既有链路，不新开删除通道）', () => {
    const entries = fillerRuleEntries();
    expect(entries).toHaveLength(DEFAULT_FILLER_RULES.length);
    for (const entry of entries) {
      expect(entry.action).toBe('delete');
      expect(entry.kind).toBe('filler');
      expect(entry.correct).toBe('');
    }
  });

  it('词条查规则：已知词给出策略，未知词返回 null（由调用方兜底为保守策略）', () => {
    expect(fillerRuleFor('就是')?.mode).toBe('repeated');
    // `的话` 不要求左侧是边界（它跟在从句后面），但右侧必须有标点
    expect(fillerRuleFor('的话')?.left).toBe(false);
    expect(fillerRuleFor('的话')?.right).toBeUndefined();
    expect(fillerRuleFor('随便一个词')).toBeNull();
  });
});

describe('白名单类：只在句首或独立出现时删', () => {
  it('感叹词出现即删：句首、句中、句尾都算（方案 §8.1-3 的"→ 0 级别"）', () => {
    expect(deletedOf('嗯，那我们开始。', ['嗯'])).toEqual(['嗯@0']);
    expect(deletedOf('他说，嗯，可以。', ['嗯'])).toEqual(['嗯@3']);
    expect(deletedOf('这个课程的进度啊，很乱。', ['啊'])).toEqual(['啊@7']);
    expect(deletedOf('密码啊，鉴权啊，权限呀', ['啊'])).toEqual(['啊@2', '啊@6']);
  });

  it('受保护的感叹词搭配不删（`啊哈`/`嗯哼`）', () => {
    expect(deletedOf('这个方案很扎实啊哈', ['啊'])).toEqual([]);
    expect(deletedOf('嗯哼，你说得对。', ['嗯'])).toEqual([]);
  });

  it('`这个`/`那个` 只有独立出现才删，`这个方案`/`那个事` 一个字都不动', () => {
    expect(deletedOf('这个，我们先看数据。', ['这个'])).toEqual(['这个@0']);
    expect(deletedOf('这个方案要先看数据。', ['这个'])).toEqual([]);
    expect(deletedOf('那个事儿以后再说。', ['那个'])).toEqual([]);
  });

  it('`的话` 只在右侧有标点时删（转写没断句的 191 处刻意不动）', () => {
    expect(deletedOf('如果下周有空的话，我们约一下。', ['的话'])).toEqual(['的话@6']);
    // 右侧是词内字符（`的话说`/`的话我`）不删：盲删会切坏从句
    expect(deletedOf('他的话说明了立场。', ['的话'])).toEqual([]);
    expect(deletedOf('有空的话我们就开。', ['的话'])).toEqual([]);
  });

  it('空串安全', () => {
    expect(detectFillers('')).toEqual([]);
  });
});

describe('语义连词类：只在重复或纯应答时删', () => {
  it('紧邻重复：`然后然后` 只删后者（删前者会把整句一起删掉）', () => {
    expect(deletedOf('然后然后我们继续。', ['然后'])).toEqual(['然后@2']);
  });

  it('窗口内成簇：保留第一次，删后续（不把整句的那个也删掉）', () => {
    const text = '然后我们看这个，然后再说那个，然后收尾。';
    const hits = deletedOf(text, ['然后']);
    expect(hits).toEqual(['然后@8', '然后@15']);
  });

  it('纯应答：整句只有这个词（含尾随标点）才删', () => {
    expect(deletedOf('然后。', ['然后'])).toEqual(['然后@0']);
    expect(deletedOf('然后我们继续。', ['然后'])).toEqual([]);
  });

  it('单独出现且不是纯应答 → 不动（这就是"降幅 <95%"的来源）', () => {
    expect(deletedOf('然后我给大家看一下这个表。', ['然后'])).toEqual([]);
    expect(deletedOf('对，我同意。', ['对'])).toEqual([]);
  });

  it('整段话里的降幅是保守的（远低于 95%）', () => {
    const text = '然后我们开始。然后看第一页，然后看第二页。然后我讲一下背景，然后收尾。最后对，就是这里。';
    const total = (text.match(/然后/g) || []).length;
    const deleted = deletedOf(text, ['然后']).length;
    expect(total).toBe(5);
    expect(deleted).toBeGreaterThan(0);
    expect(deleted / total).toBeLessThan(0.95);
  });
});

describe('接到扫描/替换链路：删除计数进 run', () => {
  it('口癖候选按 span 产出，apply 后按词计数（可核对、可关闭）', () => {
    const text = '嗯，然后我们看数据。然后看第二页。';
    const entries = [fillerEntry('嗯'), fillerEntry('然后')];
    const scan = scanText(text, entries, { includeDelete: true });
    expect(scan.candidates.length).toBeGreaterThan(0);
    const result = applyCorrections(text, scan.candidates, {
      acceptedIds: entries.map((e) => e.id),
    });
    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.deletedFillers['嗯']).toBe(1);
    expect(result.text.startsWith('，然后')).toBe(true); // 句首的"嗯"被删掉
  });

  it('未显式接受时口癖不生效（默认不包括 delete 词条）', () => {
    const text = '嗯，我们开始。';
    const entries = [fillerEntry('嗯')];
    expect(scanText(text, entries).candidates).toHaveLength(0);
  });
});
