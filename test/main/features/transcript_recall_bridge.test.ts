/**
 * transcript_recall_bridge — 多路召回接线（此前只被离线脚本用的那一层接进扫描）
 *
 * 覆盖（对齐 AGENTS「测业务不变量与文本陷阱」）：
 *   1. **接线有效性**：词表里没写过的错形（音近/编辑距离）能被补成候选——
 *      这正是接线前恒为 0 的那一档（`recallCandidates` 只被 `scripts/transcript-clean-run.ts` 用）；
 *   2. **重复不叠加**：`normalized` 通道（=折叠后字面命中）整条丢弃；与精确命中 span 重叠的
 *      也丢弃——否则同一次命中会在面板上出现两行；
 *   3. **永不自动应用**：所有模糊候选 `riskLevel:'medium'` + `fromFuzzy` + `confidence < 1`，
 *      且 `applyCorrections` 的"缺省按风险全应用"那条路会跳过它们（实测依据：
 *      模糊通道会把 cookie/id 这类普通英文词召回成产品名）；
 *   4. **护栏复用而非重写**：作用域（docId / scenarioTags）在召回层内部判定，
 *      传进去就是同一套规则；
 *   5. **引例仍被标出**：模糊候选落在引例句里也带 `quotedExample`；
 *   6. **上限与如实回报**：`truncated` 必须能被上屏。
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_FUZZY_CANDIDATES,
  FUZZY_ENTRY_PREFIX,
  buildFuzzyCandidates,
} from '../../../src/main/features/transcript_recall_bridge';
import {
  applyCorrections,
  scanText,
} from '../../../src/main/features/transcript_auto_correct';
import type { GlossaryEntry, GlossaryKind, RiskLevel } from '../../../src/main/features/transcript_glossary';

let seq = 0;
function entry(over: Partial<GlossaryEntry> & { wrong: string; correct: string }): GlossaryEntry {
  seq += 1;
  const kind: GlossaryKind = over.kind ?? 'product';
  const riskLevel: RiskLevel = over.riskLevel ?? 'low';
  return {
    id: over.id ?? `g_b${seq}`,
    wrong: over.wrong,
    correct: over.correct,
    action: over.action ?? 'replace',
    kind,
    riskLevel,
    boundary: over.boundary ?? 'word',
    contextDeny: over.contextDeny ?? [],
    contextAllow: over.contextAllow ?? [],
    scope: over.scope ?? { docIds: [], scenarioTags: [], global: true },
    freq: over.freq ?? 0,
    source: over.source ?? 'manual',
    status: over.status ?? 'active',
    ownerScope: over.ownerScope ?? 'personal',
    replacedIn: over.replacedIn ?? [],
    createdBy: over.createdBy ?? 'manual',
    createdAt: over.createdAt ?? 1,
    updatedAt: over.updatedAt ?? 1,
    lastVerifiedAt: over.lastVerifiedAt ?? 1,
  };
}

/** 项目真实种子里的代表条目：错形 coxy/cox 一类的开放集问题。 */
const cogseed = entry({ id: 'g_coxy', wrong: 'coxy', correct: 'Cogseed' });

describe('接线有效性：词表没写过的错形能被补出来', () => {
  it('音近/编辑距离命中产出模糊候选，且 ref/来源/风险都按约定', () => {
    const text = '我们用的是 cox 这个工具';
    const res = buildFuzzyCandidates(text, [cogseed]);
    expect(res.candidates.length).toBeGreaterThan(0);
    const hit = res.candidates[0];
    expect(hit.entryRef.startsWith(FUZZY_ENTRY_PREFIX)).toBe(true);
    expect(hit.correct).toBe('Cogseed');
    // 文本里实际出现的形态（不是词条里写的错形）
    expect(text.slice(hit.span.start, hit.span.end)).toBe(hit.wrong);
    expect(hit.fromFuzzy).toBe(true);
    expect(hit.riskLevel).toBe('medium');
    expect(hit.confidence).toBeGreaterThan(0);
    expect(hit.confidence).toBeLessThan(1);
    expect(['phonetic', 'edit', 'weak']).toContain(hit.fuzzy?.channel);
    expect(res.stats.produced).toBe(res.candidates.length);
    expect(res.stats.byChannel[hit.fuzzy!.channel]).toBe(1);
  });

  it('完全够不着的错形不给候选（不假装覆盖）', () => {
    const res = buildFuzzyCandidates('这里跟词表毫无关系的一段话', [cogseed]);
    expect(res.candidates).toEqual([]);
  });

  it('空文本/空词表不抛错', () => {
    expect(buildFuzzyCandidates('', [cogseed]).candidates).toEqual([]);
    expect(buildFuzzyCandidates('coxy', []).candidates).toEqual([]);
  });
});

describe('重复不叠加：normalized 与精确命中都要去重', () => {
  it('精确命中的 span 已存在时，模糊候选被丢弃（不是报两行）', () => {
    const text = '我们用的是 coxy 这个工具';
    const scan = scanText(text, [cogseed]);
    expect(scan.candidates).toHaveLength(1);
    const res = buildFuzzyCandidates(text, [cogseed], { existingSpans: scan.candidates.map((c) => c.span) });
    expect(res.candidates).toEqual([]);
    expect(res.stats.skippedNormalized + res.stats.skippedOverlap).toBeGreaterThan(0);
  });

  it('归一化通道整体不算模糊候选（它就是字面命中）', () => {
    const text = '我们用的是 coxy 这个工具';
    const res = buildFuzzyCandidates(text, [cogseed]); // 不给 existingSpans
    // normalized 命中被丢弃 → 没有任何模糊候选进结果
    expect(res.stats.skippedNormalized).toBeGreaterThan(0);
    expect(res.candidates.every((c) => c.fuzzy?.channel !== 'normalized')).toBe(true);
  });
});

describe('永不自动应用（接线不得放大误改面）', () => {
  it('applyCorrections 的"缺省按风险等级全应用"跳过模糊候选', () => {
    const text = '我们用的是 cox 这个工具';
    const res = buildFuzzyCandidates(text, [cogseed]);
    expect(res.candidates.length).toBeGreaterThan(0);
    // 缺省（不传 acceptedIds）：medium 本会被应用，但 fromFuzzy 必须挡住它
    const applied = applyCorrections(text, res.candidates, {});
    expect(applied.text).toBe(text);
    expect(applied.applied).toEqual([]);
    // 显式勾选才应用
    const forced = applyCorrections(text, res.candidates, { acceptedIds: [res.candidates[0].entryRef] });
    expect(forced.text).toContain('Cogseed');
  });
});

describe('护栏复用：作用域在召回层判定，不是在这里重写', () => {
  it('作用域之外的词条不出候选；docId 命中时才出', () => {
    const scoped = entry({
      id: 'g_scoped',
      wrong: 'coxy',
      correct: 'Cogseed',
      scope: { docIds: ['doc-a'], scenarioTags: [], global: false },
    });
    const text = '我们用的是 cox 这个工具';
    expect(buildFuzzyCandidates(text, [scoped], { docId: 'doc-b' }).candidates).toEqual([]);
    expect(buildFuzzyCandidates(text, [scoped], { docId: 'doc-a' }).candidates.length).toBeGreaterThan(0);
  });

  it('场景标签命中时同一词条出候选（标签链条的另一端）', () => {
    const tagged = entry({
      id: 'g_tagged',
      wrong: 'coxy',
      correct: 'Cogseed',
      scope: { docIds: [], scenarioTags: ['教育平台'], global: false },
    });
    const text = '我们用的是 cox 这个工具';
    expect(buildFuzzyCandidates(text, [tagged]).candidates).toEqual([]);
    expect(buildFuzzyCandidates(text, [tagged], { scenarioTags: ['教育平台'] }).candidates.length).toBeGreaterThan(0);
  });
});

describe('引例语境对模糊通道同样生效', () => {
  it('引例句里的模糊候选带 quotedExample（可见但不预勾）', () => {
    const text = '词汇表应该有 cox 这个词';
    const res = buildFuzzyCandidates(text, [cogseed]);
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(res.candidates[0].quotedExample).toBe(true);
    // 两个标记都在窗口内（"词汇表" / "这个词"），报近的那个即可
    expect(['词汇表', '这个词']).toContain(res.candidates[0].quotedBy);
  });
});

describe('上限与如实回报', () => {
  it('maxCandidates 截断时 truncated=true', () => {
    const text = 'cox 与 cox 与 cox 与 cox';
    const res = buildFuzzyCandidates(text, [cogseed], { maxCandidates: 1 });
    expect(res.candidates).toHaveLength(1);
    expect(res.stats.truncated).toBe(true);
  });

  it('默认上限是一个明确常量（防止无界增长）', () => {
    expect(MAX_FUZZY_CANDIDATES).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_FUZZY_CANDIDATES)).toBe(true);
  });

  it('stats 形状完整（面板要按通道上屏）', () => {
    const res = buildFuzzyCandidates('我们用的是 cox 这个工具', [cogseed]);
    for (const key of ['recalled', 'produced', 'skippedNormalized', 'skippedOverlap', 'residualCount']) {
      expect(typeof (res.stats as unknown as Record<string, unknown>)[key]).toBe('number');
    }
    expect(typeof res.stats.truncated).toBe('boolean');
    expect(res.stats.byChannel).toBeTypeOf('object');
  });
});

describe('高危词条不进模糊通道（真实稿实测后的局部过滤）', () => {
  const risky = entry({ id: 'g_redmi', wrong: 'redmi', correct: 'README', riskLevel: 'high' });

  it('riskLevel=high 的词条不出模糊候选（roadmap→README 这类噪声来源）', () => {
    const text = '这个涉及到一个 roadmap 的事情';
    const res = buildFuzzyCandidates(text, [risky]);
    expect(res.candidates).toEqual([]);
    expect(res.stats.skippedHighRisk).toBeGreaterThan(0);
  });

  it('但字面命中不受影响：高危词条写进正文时照常命中并被标 risk_high', () => {
    const text = '这个 redmi 是文档';
    const scan = scanText(text, [risky]);
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].riskLevel).toBe('high');
  });

  it('低风险词条仍然走模糊通道（过滤不能把功能一起关掉）', () => {
    const res = buildFuzzyCandidates('我们用的是 cox 这个工具', [cogseed]);
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(res.stats.skippedHighRisk).toBe(0);
  });
});
