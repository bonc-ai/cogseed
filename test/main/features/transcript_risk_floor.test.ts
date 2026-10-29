/**
 * transcript_risk_floor — 显式风险等级不得突破派生下限
 *
 * 事故（2026-10-13 实测复现）：出厂种子 `{健全 → 鉴权, riskLevel: 'medium'}`
 * 把「我们要建立健全的机制」改成了「我们要建立鉴权的机制」。
 *
 * 根因不是引擎判错——`deriveRiskLevel` 对 `foldedWrong.length <= 2` 一律返回 high，
 * 中文没有词间空格，两个字的错形几乎必然落在某个真实词内部。**根因是显式声明
 * 覆盖了派生值**：`upsertEntry` 与贡献包导入都直接采信调用方传入的 riskLevel，
 * 于是 .5 这道护栏被数据关掉了。
 *
 * 本文件守住四件事：
 *   1. 该事故不再复现（端到端：种子 → 落盘 → 扫描 → 应用）；
 *   2. 下限是系统性的，不是针对某一条数据的补丁；
 *   3. 纯 ASCII 短代号的既有设计意图（`K2 → KSTAR` 限本场景、有意为 low）不被误伤；
 *   4. 贡献包这条旁路同样受约束。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  effectiveRiskLevel,
  upsertEntry,
  listEntries,
} from '../../../src/main/features/transcript_glossary';
import {
  INITIAL_GLOSSARY_SEED,
  seedInitialEntries,
} from '../../../src/main/features/transcript_glossary_seed';
import {
  CONTRIBUTION_PACK_FORMAT,
  applyContributionPack,
  parseContributionPack,
} from '../../../src/main/features/transcript_contribution_pack';
import { applyCorrections, scanText } from '../../../src/main/features/transcript_auto_correct';

let uid = '';
beforeEach(() => {
  uid = `u_riskfloor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
});

/** 走生产默认路径：扫描 + 默认 acceptRiskLevels。 */
function autoApply(text: string, docId: string): string {
  const entries = listEntries(uid);
  const result = scanText(text, entries, { docId });
  return applyCorrections(text, result.candidates, {}).text;
}

describe('风险下限：显式声明只能更严', () => {
  it('2 字中文词的声明不得低于派生值 high', () => {
    for (const declared of ['low', 'medium'] as const) {
      expect(effectiveRiskLevel({ wrong: '健全', correct: '鉴权', action: 'replace' }, declared))
        .toBe('high');
      expect(effectiveRiskLevel({ wrong: '图度', correct: '土豆', action: 'replace' }, declared))
        .toBe('high');
    }
  });

  it('声明 high 仍然生效（提高风险是允许的）', () => {
    expect(effectiveRiskLevel({ wrong: '健全', correct: '鉴权', action: 'replace' }, 'high'))
      .toBe('high');
  });

  it('不含 CJK 的短代号尊重调用方声明（K2/K4 是"部分形态、限本场景"的有意设计）', () => {
    expect(effectiveRiskLevel({ wrong: 'K2', correct: 'KSTAR', action: 'replace' }, 'low'))
      .toBe('low');
    expect(effectiveRiskLevel({ wrong: 'PID', correct: 'PRD', action: 'replace' }, 'medium'))
      .toBe('medium');
  });

  it('折叠后超过 2 字符的中文词不受下限影响（派生本就是 low）', () => {
    expect(effectiveRiskLevel({ wrong: '多vbl', correct: '多维表格', action: 'replace' }, 'low'))
      .toBe('low');
    expect(effectiveRiskLevel({ wrong: '多vbl', correct: '多维表格', action: 'replace' }, 'medium'))
      .toBe('medium');
  });

  it('不传声明时等于派生值', () => {
    expect(effectiveRiskLevel({ wrong: '健全', correct: '鉴权', action: 'replace' }, null))
      .toBe('high');
    expect(effectiveRiskLevel({ wrong: 'coxy', correct: 'Cogseed', action: 'replace' }, undefined))
      .toBe('low');
  });
});

describe('端到端：出厂种子不再改坏正常中文', () => {
  it('健全→鉴权 装入后是 high，且不会自动应用', () => {
    seedInitialEntries(uid);
    const entry = listEntries(uid).find((e) => e.wrong === '健全');
    expect(entry?.riskLevel).toBe('high');

    // 关键回归：这句曾被改成「我们要建立鉴权的机制」
    expect(autoApply('我们要建立健全的机制', 'doc_risk_floor')).toBe('我们要建立健全的机制');
    expect(autoApply('生态健全度不足', 'doc_risk_floor')).toBe('生态健全度不足');
    expect(autoApply('这个流程还不够健全', 'doc_risk_floor')).toBe('这个流程还不够健全');
  });

  it('种子里的 K2→KSTAR 保持 low（设计意图未被下限误伤）', () => {
    seedInitialEntries(uid);
    const k2 = listEntries(uid).find((e) => e.wrong === 'K2');
    expect(k2?.riskLevel).toBe('low');
  });

  it('装入种子后整体仍可幂等重装', () => {
    seedInitialEntries(uid);
    const again = seedInitialEntries(uid);
    expect(again.created).toBe(0);
    expect(listEntries(uid)).toHaveLength(INITIAL_GLOSSARY_SEED.length);
  });
});

describe('旁路：贡献包导入同样受下限约束', () => {
  it('包里声明 medium 的 2 字中文词，导入后仍为 high', () => {
    const pack = parseContributionPack({
      format: CONTRIBUTION_PACK_FORMAT,
      exportedAt: Date.now(),
      ownerScope: 'personal',
      counts: { total: 1, peopleExcluded: 0, byKind: {} },
      entries: [{
        wrong: '健全', correct: '鉴权', action: 'replace', kind: 'term',
        riskLevel: 'medium', boundary: 'substring',
        contextDeny: [], contextAllow: [], scenarioTags: [], ownerScope: 'personal',
      }],
    });
    expect(pack).not.toBeNull();
    applyContributionPack(uid, pack!);

    const imported = listEntries(uid).find((e) => e.wrong === '健全');
    expect(imported?.riskLevel).toBe('high');
    // 且不能自动应用（全局作用域下扫一遍普通文本）
    const result = scanText('生态健全度不足', listEntries(uid), { docId: 'doc_pack' });
    expect(applyCorrections('生态健全度不足', result.candidates, {}).text).toBe('生态健全度不足');
  });

  it('包里的 low 声明对纯 ASCII 短代号仍然有效', () => {
    const pack = parseContributionPack({
      format: CONTRIBUTION_PACK_FORMAT,
      exportedAt: Date.now(),
      ownerScope: 'personal',
      counts: { total: 1, peopleExcluded: 0, byKind: {} },
      entries: [{
        wrong: 'PID', correct: 'PRD', action: 'replace', kind: 'term',
        riskLevel: 'low', boundary: 'word',
        contextDeny: [], contextAllow: [], scenarioTags: [], ownerScope: 'personal',
      }],
    });
    applyContributionPack(uid, pack!);
    expect(listEntries(uid).find((e) => e.wrong === 'PID')?.riskLevel).toBe('low');
  });
});

describe('upsertEntry 直接调用同样受约束', () => {
  it('显式 medium 的 2 字中文词落盘为 high', () => {
    const created = upsertEntry(uid, { wrong: '健全', correct: '鉴权', riskLevel: 'medium' });
    expect(created.entry?.riskLevel).toBe('high');
  });
});
