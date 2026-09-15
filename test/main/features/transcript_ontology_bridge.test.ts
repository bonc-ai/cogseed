/**
 * transcript_ontology_bridge — 词表 ↔ 个人本体/长期记忆的最小接线（P1）
 *
 * 重点覆盖（对齐 AGENTS「测业务不变量、恢复路径、文本陷阱」）：
 *   - 概念聚合不依赖本体：本体为空时也必须能把散词条收成概念组（今天就能用的价值）；
 *   - 空来源必须"什么都不做"，如实返回 0，**绝不造占位数据**；
 *   - 挂 `ontologyRef` 只改这一个字段，不动 wrong/correct/风险/频次（审计要求）；
 *   - 反哺候选的幂等键：同一纠错对重复同步只投一次；
 *   - "待补错形"采纳走 ontology_seed 来源（未验证语义）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  adoptMissingSuggestion,
  applyAlignment,
  buildCandidateInput,
  candidateIdFor,
  collectCanonicalNames,
  conceptKeyOf,
  contributeCandidates,
  groupByConcept,
  linkOntologyRefs,
  suggestAlignments,
  suggestMissing,
  syncOntology,
} from '../../../src/main/features/transcript_ontology_bridge';
import { loadGlossary, recordReplacement, upsertEntry } from '../../../src/main/features/transcript_glossary';
import { listCandidates } from '../../../src/main/features/personal_ontology_candidates';
import {
  userMemoryFile,
  userOntologyGroupsDir,
  userProfileFile,
  userTranscriptGlossaryFile,
} from '../../../src/main/paths';

let uid = '';
beforeEach(() => {
  uid = `u_bridge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
});

/** 写一个"模板组文件"（分节式）：本体规范名的真实来源。 */
function writeTemplateGroup(groupId: string, fields: Record<string, string[]>): void {
  const dir = userOntologyGroupsDir(uid);
  fs.mkdirSync(dir, { recursive: true });
  const sections = Object.entries(fields)
    .map(([name, values]) => `## 分节\n### ${name}\n${values.map((v) => `- ${v} [user]`).join('\n')}`)
    .join('\n');
  fs.writeFileSync(
    path.join(dir, `${groupId}.md`),
    `> 模板: role_template@1.0.0 | 已安装: 2026-09-15\n\n${sections}\n`,
    'utf8',
  );
}

/** 写长期记忆文件：应用用 `\n§\n` 分隔条目。 */
function writeMemory(file: string, texts: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, texts.join('\n§\n'), 'utf8');
}

const seed = (wrong: string, correct: string, kind: 'term' | 'person' = 'term') =>
  upsertEntry(uid, { wrong, correct, kind });

describe('概念聚合（不依赖本体）', () => {
  it('概念键按 correct 折叠（大小写/全角/空白/连字符都等价）', () => {
    expect(conceptKeyOf('KSTAR')).toBe('kstar');
    expect(conceptKeyOf('K star')).toBe('kstar');
    expect(conceptKeyOf('K-STAR')).toBe('kstar');
    expect(conceptKeyOf('Ｃｏｇｓｅｅｄ')).toBe('cogseed');
    // 不同概念不得合并
    expect(conceptKeyOf('K2')).not.toBe(conceptKeyOf('KSTAR'));
  });

  it('同意概念的多条错形收成一组，展示名取出现最多的写法', () => {
    seed('coxy', 'Cogseed');
    seed('cog seed', 'Cogseed');
    seed('coseed', 'CogSeed');
    const groups = groupByConcept(loadGlossary(uid).entries);
    expect(groups).toHaveLength(1);
    expect(groups[0].conceptKey).toBe('cogseed');
    expect(groups[0].display).toBe('Cogseed');
    expect(groups[0].entryCount).toBe(3);
    expect(groups[0].entryIds).toHaveLength(3);
  });

  it('多概念组按词条数降序（面板靠前的就是最需要看的）', () => {
    seed('a1', 'Alpha');
    seed('a2', 'Alpha');
    seed('b1', 'Beta');
    const groups = groupByConcept(loadGlossary(uid).entries);
    expect(groups.map((g) => g.display)).toEqual(['Alpha', 'Beta']);
  });
});

describe('规范名来源读取（空来源不造数据）', () => {
  it('本体与记忆都不存在 → 返回空数组', () => {
    expect(collectCanonicalNames(uid)).toEqual([]);
  });

  it('模板组文件 → 字段值算规范名并带 ontologyRef；字段名只是结构标签，不入册', () => {
    writeTemplateGroup('g_team', { 团队成员: ['Raymond', '雷蒙德'], 产品名: ['Moodle'] });
    const names = collectCanonicalNames(uid);
    const byName = new Map(names.map((n) => [n.name, n]));
    expect(byName.get('团队成员')).toBeUndefined();
    expect(byName.get('产品名')).toBeUndefined();
    expect(byName.get('Raymond')?.source).toBe('ontology');
    expect(byName.get('Raymond')?.ontologyRef).toEqual({ groupId: 'g_team', fieldId: '团队成员' });
    expect(byName.get('Moodle')?.ontologyRef).toEqual({ groupId: 'g_team', fieldId: '产品名' });
  });

  it('长期记忆 → 条目文本进候选名，来源标记为 memory 且不带 ontologyRef', () => {
    writeMemory(userProfileFile(uid), ['用户偏好中文回复']);
    const names = collectCanonicalNames(uid).filter((n) => n.source === 'memory');
    expect(names.map((n) => n.name)).toContain('用户偏好中文回复');
    expect(names[0].ontologyRef).toBeUndefined();
  });

  it('长文本（>60 字）不当规范名，避免整段记忆被当成术语', () => {
    writeMemory(userMemoryFile(uid), ['这是一段非常长的记忆内容'.repeat(10)]);
    expect(collectCanonicalNames(uid)).toEqual([]);
  });
});

describe('对齐建议与待补建议', () => {
  it('同概念但书写不同 → 报对齐建议；纯全角/半角差异不打扰', () => {
    const entry = seed('kstar', 'KSTAR').entry!;
    // 全角 `ＫＳＴＡＲ` 是编码差异，fold 后与 `KSTAR` 相等 → 不报
    expect(suggestAlignments([entry], [{ name: 'ＫＳＴＡＲ', source: 'ontology' }])).toEqual([]);
    // 精确相同 → 不报
    expect(suggestAlignments([entry], [{ name: 'KSTAR', source: 'ontology' }])).toEqual([]);

    // `K star`（空格）与 `KSTAR` 折叠后仍不同 → 是真实书写选择，报建议
    const align = suggestAlignments([entry], [{ name: 'K star', source: 'ontology' }]);
    expect(align).toHaveLength(1);
    expect(align[0]).toMatchObject({
      kind: 'canonical_spelling',
      entryId: entry.id,
      currentCorrect: 'KSTAR',
      suggestedCorrect: 'K star',
    });
  });

  it('连字符/空格差异算同一概念的写法分歧 → 报对齐建议（本体是规范名来源）', () => {
    const entry = seed('kstar', 'KSTAR').entry!;
    const align = suggestAlignments([entry], [{ name: 'K-STAR', source: 'ontology' }]);
    expect(align).toHaveLength(1);
    expect(align[0]).toMatchObject({ entryId: entry.id, currentCorrect: 'KSTAR', suggestedCorrect: 'K-STAR' });
  });

  it('词表里没有的规范名 → 待补错形建议（每个概念只报一条）', () => {
    const entry = seed('coxy', 'Cogseed').entry!;
    const missing = suggestMissing([entry], [
      { name: 'Cogseed', source: 'ontology' },
      { name: 'Raymond', source: 'ontology' },
      { name: 'raymond', source: 'memory' },
    ]);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ kind: 'missing_entry', correct: 'Raymond', source: 'ontology' });
  });

  it('记忆来源不参与"待补错形"：散文补词条会造出永远匹配不到的假术语', () => {
    const entry = seed('coxy', 'Cogseed').entry!;
    expect(suggestMissing([entry], [{ name: '用户偏好中文回复', source: 'memory' }])).toEqual([]);
  });

  it('采纳待补建议 → ontology_seed 来源 + 带 ontologyRef', () => {
    const entry = adoptMissingSuggestion(uid, {
      wrong: '雷蒙德',
      correct: 'Raymond',
      kind: 'person',
      ontologyRef: { groupId: 'g_team', fieldId: '团队成员' },
    });
    expect(entry).not.toBeNull();
    expect(entry!.source).toBe('ontology_seed');
    expect(entry!.ontologyRef).toEqual({ groupId: 'g_team', fieldId: '团队成员' });
    // 来源未验证：lastVerifiedAt 留 0，等真实替换发生才置位
    expect(entry!.lastVerifiedAt).toBe(0);
  });

  it('采纳对齐建议 → 改写法（不改错形、不伪造新确认）', () => {
    const entry = seed('kstar', 'K star').entry!;
    const after = applyAlignment(uid, entry.id, 'KSTAR')!;
    expect(after.correct).toBe('KSTAR');
    expect(after.wrong).toBe('kstar');
    expect(after.freq).toBe(entry.freq);
    expect(() => applyAlignment(uid, '', 'X')).toThrow();
    expect(() => applyAlignment(uid, entry.id, '   ')).toThrow();
  });

  it('采纳时空值 → 报错而不是写脏数据', () => {
    expect(() => adoptMissingSuggestion(uid, { wrong: '  ', correct: 'X' })).toThrow();
    expect(() => adoptMissingSuggestion(uid, { wrong: 'X', correct: '' })).toThrow();
  });
});

describe('挂 ontologyRef（只改一个字段）', () => {
  it('命中本体的词条挂上引用，其它字段一字不改', () => {
    const before = seed('coxy', 'Cogseed').entry!;
    const changed = linkOntologyRefs(uid, loadGlossary(uid).entries, [
      { name: 'Cogseed', source: 'ontology', ontologyRef: { groupId: 'g_team', fieldId: '产品名' } },
    ]);
    expect(changed).toBe(1);
    const after = loadGlossary(uid).entries.find((e) => e.id === before.id)!;
    expect(after.ontologyRef).toEqual({ groupId: 'g_team', fieldId: '产品名' });
    expect({ ...after, ontologyRef: undefined, updatedAt: undefined })
      .toEqual({ ...before, ontologyRef: undefined, updatedAt: undefined });
  });

  it('来源为空 → 0 次改动且不产生写入（词表内容不变）', () => {
    seed('coxy', 'Cogseed');
    const file = userTranscriptGlossaryFile(uid);
    const snapshot = fs.readFileSync(file, 'utf8');
    expect(linkOntologyRefs(uid, loadGlossary(uid).entries, [])).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(snapshot);
  });

  it('记忆来源不挂引用（记忆不是本体结构，不给假定位）', () => {
    seed('coxy', 'Cogseed');
    const changed = linkOntologyRefs(uid, loadGlossary(uid).entries, [{ name: 'Cogseed', source: 'memory' }]);
    expect(changed).toBe(0);
    expect(loadGlossary(uid).entries[0].ontologyRef).toBeUndefined();
  });
});

describe('反哺候选池（幂等）', () => {
  it('幂等键只依赖折叠后的纠错对', () => {
    expect(candidateIdFor('coxy', 'Cogseed')).toBe(candidateIdFor('COXY', 'Ｃｏｇｓｅｅｄ'));
    expect(candidateIdFor('coxy', 'Cogseed')).not.toBe(candidateIdFor('coxy', 'CogSeed2'));
  });

  it('载荷如实带频次与来源，不吹置信度', () => {
    const input = buildCandidateInput(
      { wrong: 'coxy', correct: 'Cogseed', kind: 'term', freq: 6 },
      { docIds: ['d1'], runIds: ['r1', 'd1'] },
    );
    expect(input.candidate_id).toBe(candidateIdFor('coxy', 'Cogseed'));
    expect(input.kind).toBe('rule');
    expect(input.confidence).toBe('medium');
    expect(input.memory_scope).toBe('user');
    expect(input.summary).toContain('coxy → Cogseed');
    expect(input.summary).toContain('6');
    expect(input.diff_summary).toContain('d1');
  });

  it('低于阈值的词条不投递；重复投递只留一条（candidate_id 去重）', async () => {
    const frequent = seed('coxy', 'Cogseed').entry!;
    seed('rare', 'RareWord');
    // 频次只由"真实替换"累积（upsert 不刷频次；同一 run 内去重），故三次不同 run
    for (const runId of ['r1', 'r2', 'r3']) recordReplacement(uid, [frequent.id], { docId: 'd1', runId });
    const entries = loadGlossary(uid).entries;
    expect(entries.find((e) => e.id === frequent.id)!.freq).toBeGreaterThanOrEqual(3);
    const first = await contributeCandidates(uid, entries);
    expect(first).toBe(1);
    const second = await contributeCandidates(uid, entries);
    expect(second).toBe(1); // 再次调用仍"投了"，但池内不重复
    const { candidate_updates } = await listCandidates(uid);
    expect(candidate_updates.filter((c) => c.candidate_id === candidateIdFor('coxy', 'Cogseed'))).toHaveLength(1);
  });
});

describe('syncOntology 组合动作', () => {
  it('本体/记忆为空：仍出概念组，linked/canonicalNames 如实为 0', async () => {
    seed('coxy', 'Cogseed');
    seed('coseed', 'Cogseed');
    const result = await syncOntology(uid, { contribute: false });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].entryCount).toBe(2);
    expect(result.linked).toBe(0);
    expect(result.canonicalNames).toBe(0);
    expect(result.alignments).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.contributed).toBe(0);
  });

  it('有本体时：挂引用 + 出对齐/待补建议，一次调用全给面板', async () => {
    const entry = seed('kstar', 'K star').entry!;
    for (const runId of ['r1', 'r2', 'r3']) recordReplacement(uid, [entry.id], { docId: 'd1', runId });
    writeTemplateGroup('g_team', { 产品名: ['KSTAR', 'Raymond'] });
    const result = await syncOntology(uid, { minFreq: 3 });
    // 字段名本身也是一种规范名（`产品名`）+ 两个字段值
    // 只有两个字段值入册（`产品名` 字段名不入册）
    expect(result.canonicalNames).toBe(2);
    expect(result.linked).toBe(1);
    expect(result.alignments.map((a) => (a as { suggestedCorrect: string }).suggestedCorrect)).toEqual(['KSTAR']);
    expect(result.missing.map((m) => (m as { correct: string }).correct)).toEqual(['Raymond']);
    expect(result.contributed).toBe(1);
    expect(loadGlossary(uid).entries[0].ontologyRef).toEqual({ groupId: 'g_team', fieldId: '产品名' });
  });
});
