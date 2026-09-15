/**
 * transcript_ontology_bridge — 词表 ↔ 个人本体 / 长期记忆的最小接线（P1-a/b/c）
 *
 * 设计依据：`教育插件/教育插件/1/本体×转写纠错-P1最小接线方案-2026-09-15.md`
 *
 * 三条职责，都不新增词汇资产、不新增写入通道：
 *   P1-a 归位：把词条按"概念"聚合，并在本体/记忆里能找到同名概念时挂上
 *             `ontologyRef`（**只改这一个字段**，不动 wrong/correct/风险）。
 *   P1-b 建议：本体/记忆里的规范名与词表现有写法不一致 → 给出"对齐建议"；
 *             词表里没有的规范名 → 给出"待补错形"建议（由用户补 wrong 形）。
 *   P1-c 反哺：同一 `wrong→correct` 被确认 ≥N 次 → 投递到**既有候选池**
 *             （`personal_ontology_candidates.addCandidate`），用 candidate_id
 *             作幂等键；候选未确认前不写任何记忆/别名。
 *
 * 来源范围（说清楚，别让人以为读的是"全部记忆"）：
 *   - 本体：`<uid>/cloud/contexts/.personal_ontology_groups/<groupId>.md` 的**字段值**
 *     （界面上叫「记忆分组」，可在记忆页新建；隐藏目录，不能依赖 KB 索引）；
 *   - 记忆：`<uid>/cloud/memory/{USER,MEMORY}.md`，即用户/共享两档长期记忆；
 *   - **不读** `cloud/memory/agents/<agent>/MEMORY.md`（agent 档）与角色模板画像：
 *     那两处是散文，整条折叠后永远匹配不上概念名，硬接只会造噪；等 P2 用 LLM
 *     抽术语时一并处理。
 *
 * 现实约束（2026-09-15 实测）：本机 dev profile 的 `.personal_ontology_groups/`
 * 台账为 `共 0 个分组`、`cloud/memory/MEMORY.md` 为 0 条（`USER.md` 不存在），
 * app 自己的 `personalOntology.groups.list` 也返回 `[]`。因此：
 *   - 本模块对空来源必须"什么都不做 + 如实返回 0"，不造占位数据；
 *   - 概念聚合**不依赖本体**：以 `correct` 的折叠值为概念键，今天就能把
 *     28 条散词条收成若干概念组（有本体时再补 `ontologyRef`）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { userOntologyGroupsDir, userMemoryFile, userProfileFile } from '../paths';
import { createLogger } from '../logger';
import {
  foldText,
  loadGlossary,
  retargetEntry,
  saveGlossary,
  upsertEntry,
  type GlossaryEntry,
  type GlossaryKind,
} from './transcript_glossary';
import { loadEntries as loadMemoryEntries } from './memory';
import {
  collectTemplateFileFields,
  isTemplateFileText,
  parseGroupContent,
} from './personal_ontology_groups';
import { addCandidate } from './personal_ontology_candidates';

const log = createLogger('transcript_ontology_bridge');

/** 反哺阈值：同一纠错对被确认多少次后投递候选。 */
export const DEFAULT_CONTRIBUTE_MIN_FREQ = 3;
const MAX_CANONICAL_NAMES = 500;
/** 超过此长度的文本不是"名字"，是句子（字段值/记忆条目都可能很长）。 */
const MAX_CANONICAL_NAME_LEN = 40;

export interface CanonicalName {
  name: string;
  source: 'ontology' | 'memory';
  /** 本体来源时的定位（group/字段），记忆来源时为 undefined。 */
  ontologyRef?: { groupId: string; fieldId: string };
  evidence?: string;
}

export interface ConceptGroup {
  /** 概念键 = correct 的折叠值（去空白/大小写）。 */
  conceptKey: string;
  /** 该概念的标准写法（取组内出现最多的 correct 原文）。 */
  display: string;
  entryIds: string[];
  entryCount: number;
  /** 命中本体/记忆时的引用。 */
  ontologyRef?: { groupId: string; fieldId: string };
}

export type SeedSuggestion =
  | { kind: 'canonical_spelling'; entryId: string; wrong: string; currentCorrect: string; suggestedCorrect: string; source: CanonicalName['source'] }
  | { kind: 'missing_entry'; correct: string; source: CanonicalName['source']; reason: string };

export interface SyncResult {
  /** 归组统计（P1-a，始终可用于面板分组展示）。 */
  groups: ConceptGroup[];
  /** 实际写入 ontologyRef 的词条数（本体为空时为 0）。 */
  linked: number;
  /** 规范写法对齐建议数。 */
  alignments: SeedSuggestion[];
  /** 词表里缺失的规范名数。 */
  missing: SeedSuggestion[];
  /** 本次投递到候选池的条数（幂等键去重后）。 */
  contributed: number;
  /** 扫描到的规范名总数（本体 + 记忆）。 */
  canonicalNames: number;
}

// ── 纯函数（可测）──────────────────────────────────────────────────────

export function conceptKeyOf(correct: string): string {
  // 折叠大小写/全角，并抹掉一切分隔符号：`KSTAR` / `K-STAR` / `K star` / `K.STAR`
  // 是同一个概念。若只抹空白，`K-STAR` 会被当成另一个概念，本体里的规范名
  // 就永远对不上词表（"对齐"退化成只能发现空格差异）。
  return foldText(String(correct || '')).replace(/[^\p{L}\p{N}]/gu, '');
}

/** 按概念聚合词条：同一 correct（折叠后）归一组，组内按 wrong 排序。 */
export function groupByConcept(entries: GlossaryEntry[]): ConceptGroup[] {
  const byKey = new Map<string, { display: Map<string, number>; ids: string[]; ref?: { groupId: string; fieldId: string } }>();
  for (const entry of entries) {
    const key = conceptKeyOf(entry.correct);
    if (!key) continue;
    const bucket = byKey.get(key) ?? { display: new Map<string, number>(), ids: [] };
    bucket.display.set(entry.correct, (bucket.display.get(entry.correct) ?? 0) + 1);
    bucket.ids.push(entry.id);
    if (!bucket.ref && entry.ontologyRef) bucket.ref = entry.ontologyRef;
    byKey.set(key, bucket);
  }
  const groups: ConceptGroup[] = [];
  for (const [conceptKey, bucket] of byKey) {
    const display = [...bucket.display.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    groups.push({
      conceptKey,
      display,
      entryIds: [...bucket.ids].sort(),
      entryCount: bucket.ids.length,
      ...(bucket.ref ? { ontologyRef: bucket.ref } : {}),
    });
  }
  return groups.sort((a, b) => b.entryCount - a.entryCount || a.display.localeCompare(b.display));
}

/** 规范名与词表现有写法不一致 → 对齐建议（每个概念只报一条，取第一条词条）。 */
export function suggestAlignments(entries: GlossaryEntry[], names: CanonicalName[]): SeedSuggestion[] {
  const byConcept = new Map<string, GlossaryEntry>();
  for (const entry of entries) {
    const key = conceptKeyOf(entry.correct);
    if (key && !byConcept.has(key)) byConcept.set(key, entry);
  }
  const out: SeedSuggestion[] = [];
  const seen = new Set<string>();
  for (const canonical of names) {
    const key = conceptKeyOf(canonical.name);
    if (!key || seen.has(key)) continue;
    const entry = byConcept.get(key);
    if (!entry) continue;
    // 概念键已抹平大小写/全角/分隔符号，所以能走到这里的只有一种差异：
    // fold 后仍不等（`KSTAR` vs `K-STAR`、`K star`）= 真实的书写选择 → 报建议。
    // fold 后相等（全角 vs 半角）只是编码差异 → 不打扰。
    if (foldText(entry.correct) === foldText(canonical.name)) continue;
    seen.add(key);
    out.push({
      kind: 'canonical_spelling',
      entryId: entry.id,
      wrong: entry.wrong,
      currentCorrect: entry.correct,
      suggestedCorrect: canonical.name,
      source: canonical.source,
    });
  }
  return out;
}

/**
 * 词表里完全没有的规范名 → "待补错形"建议。
 *
 * **只认本体来源**：本体字段值是用户维护的名单，出现即代表"这是个正经术语"；
 * 长期记忆是散文（"用户偏好中文回复"），拿它去补词条会造出一堆永远匹配不到
 * 的假术语。记忆来源留给 suggestAlignments（命中已有概念才用）。
 */
export function suggestMissing(entries: GlossaryEntry[], names: CanonicalName[]): SeedSuggestion[] {
  const known = new Set(entries.map((e) => conceptKeyOf(e.correct)).filter(Boolean));
  const out: SeedSuggestion[] = [];
  const seen = new Set<string>();
  for (const canonical of names) {
    if (canonical.source !== 'ontology') continue;
    const key = conceptKeyOf(canonical.name);
    if (!key || known.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: 'missing_entry',
      correct: canonical.name,
      source: canonical.source,
      reason: '记忆分组里有这个概念',
    });
  }
  return out;
}

/** 候选池幂等键：同一纠错对只投一次（addCandidate 用 candidate_id 去重）。 */
export function candidateIdFor(wrong: string, correct: string): string {
  const digest = createHash('sha1').update(`${foldText(wrong).trim()}|${foldText(correct).trim()}`).digest('hex').slice(0, 12);
  return `tg_${digest}`;
}

/** 组装投递到候选池的载荷（纯函数，便于断言文案与字段）。 */
export function buildCandidateInput(
  entry: Pick<GlossaryEntry, 'wrong' | 'correct' | 'kind' | 'freq'>,
  meta: { runIds?: string[]; docIds?: string[] } = {},
): { candidate_id: string; kind: 'rule'; confidence: 'medium'; summary: string; memory_scope: 'user'; memory_text: string; diff_summary: string } {
  const where = [...new Set([...(meta.docIds ?? []), ...(meta.runIds ?? [])])].slice(0, 5);
  const summary = `转写纠错用词：${entry.wrong} → ${entry.correct}（已确认 ${entry.freq} 次）`;
  return {
    candidate_id: candidateIdFor(entry.wrong, entry.correct),
    kind: 'rule',
    confidence: 'medium',
    summary,
    memory_scope: 'user',
    memory_text: `转写里遇到「${entry.wrong}」应写作「${entry.correct}」（属 ${entry.kind}）。`,
    diff_summary: where.length ? `来源：${where.join('、')}` : '来源：转写纠错词表',
  };
}

// ── 来源读取（本体 + 长期记忆）────────────────────────────────────────────

function readTextIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 收集"规范名"。两个来源都直读文件（本体分组在隐藏目录，不能依赖 KB 索引）：
 *   - 本体：分组文件里**字段值**（用户自己维护的名单，结构化、可信）
 *   - 记忆：USER.md / MEMORY.md 的条目文本（散文，仅用于"对齐"不用于"补词条"）
 * 来源不存在时返回空数组——绝不造占位数据。
 */
export function collectCanonicalNames(userId: string): CanonicalName[] {
  const names: CanonicalName[] = [];
  const push = (name: string, source: CanonicalName['source'], extra: Partial<CanonicalName> = {}) => {
    const trimmed = String(name || '').replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed.length > MAX_CANONICAL_NAME_LEN) return;
    names.push({ name: trimmed, source, ...extra });
  };

  // 本体分组（目录可能不存在）
  const dir = userOntologyGroupsDir(userId);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    files = [];
  }
  for (const file of files) {
    const text = readTextIfExists(path.join(dir, file));
    if (!text) continue;
    const groupId = file.replace(/\.md$/, '');
    try {
      // 只取**字段值**（用户维护的名单），不取字段名/组标题——那些是结构标签
      // （`团队成员`、`产品名`）不是待纠正的术语，收进来只会噪报。
      if (isTemplateFileText(text)) {
        for (const field of collectTemplateFileFields(text)) {
          for (const fieldValue of field.values ?? []) {
            push(String(fieldValue?.value ?? ''), 'ontology', { ontologyRef: { groupId, fieldId: field.name } });
          }
        }
      } else {
        const content = parseGroupContent(text);
        for (const [fieldName, values] of Object.entries(content.fields ?? {})) {
          for (const fieldValue of values ?? []) {
            push(String(fieldValue?.value ?? ''), 'ontology', { ontologyRef: { groupId, fieldId: fieldName } });
          }
        }
        // 流水条目是散文，不做规范名（见 suggestMissing 的来源限定）
      }
    } catch (error) {
      log.warn('ontology group parse failed; skipping file', { groupId, error: (error as Error).message });
    }
  }

  // 长期记忆（文件可能不存在）
  for (const [file, label] of [[userProfileFile(userId), 'USER.md'], [userMemoryFile(userId), 'MEMORY.md']] as const) {
    let entries: Array<{ text: string }> = [];
    try {
      entries = loadMemoryEntries(file);
    } catch {
      entries = [];
    }
    for (const entry of entries) push(entry.text, 'memory', { evidence: label });
  }

  return names.slice(0, MAX_CANONICAL_NAMES);
}

// ── 组合动作 ────────────────────────────────────────────────────────────

/** P1-a：把能对上本体概念的词条挂上 ontologyRef（只改这一个字段）。 */
export function linkOntologyRefs(userId: string, entries: GlossaryEntry[], names: CanonicalName[]): number {
  const refByConcept = new Map<string, { groupId: string; fieldId: string }>();
  for (const canonical of names) {
    if (canonical.source !== 'ontology' || !canonical.ontologyRef) continue;
    const key = conceptKeyOf(canonical.name);
    if (key && !refByConcept.has(key)) refByConcept.set(key, canonical.ontologyRef);
  }
  if (refByConcept.size === 0) return 0;
  const file = loadGlossary(userId);
  let changed = 0;
  for (const entry of file.entries) {
    const ref = refByConcept.get(conceptKeyOf(entry.correct));
    if (!ref) continue;
    const current = entry.ontologyRef;
    if (current && current.groupId === ref.groupId && current.fieldId === ref.fieldId) continue;
    entry.ontologyRef = { groupId: ref.groupId, fieldId: ref.fieldId };
    changed += 1;
  }
  if (changed > 0) saveGlossary(userId, file);
  return changed;
}

/** P1-c：把达到阈值的纠错对投递到既有候选池（幂等）。 */
export async function contributeCandidates(
  userId: string,
  entries: GlossaryEntry[],
  opts: { minFreq?: number; runIds?: string[]; docIds?: string[] } = {},
): Promise<number> {
  const minFreq = Number.isFinite(Number(opts.minFreq)) ? Number(opts.minFreq) : DEFAULT_CONTRIBUTE_MIN_FREQ;
  const eligible = entries.filter((e) => e.status === 'active' && e.freq >= minFreq);
  let contributed = 0;
  for (const entry of eligible) {
    try {
      await addCandidate(userId, buildCandidateInput(entry, { runIds: opts.runIds, docIds: opts.docIds }));
      contributed += 1;
    } catch (error) {
      log.warn('candidate contribution failed', { wrong: entry.wrong, error: (error as Error).message });
    }
  }
  return contributed;
}

/** 一次同步：归组 → 挂引用 → 出建议 → 反哺候选。 */
export async function syncOntology(
  userId: string,
  opts: { contribute?: boolean; minFreq?: number; runIds?: string[]; docIds?: string[] } = {},
): Promise<SyncResult> {
  const entries = loadGlossary(userId).entries;
  const names = collectCanonicalNames(userId);
  const linked = linkOntologyRefs(userId, entries, names);
  const after = linked > 0 ? loadGlossary(userId).entries : entries;
  const contributed = opts.contribute === false
    ? 0
    : await contributeCandidates(userId, after, { minFreq: opts.minFreq, runIds: opts.runIds, docIds: opts.docIds });
  return {
    groups: groupByConcept(after),
    linked,
    alignments: suggestAlignments(after, names),
    missing: suggestMissing(after, names),
    contributed,
    canonicalNames: names.length,
  };
}

/**
 * 采纳一条"对齐建议"：把词表里的写法改成本体/记忆里的规范名。
 * 只改写法（见 retargetEntry），所以不会伪造一次"确认"。
 */
export function applyAlignment(userId: string, entryId: string, suggestedCorrect: string): GlossaryEntry | null {
  const correct = String(suggestedCorrect || '').trim();
  if (!entryId || !correct) throw new Error('transcript ontology: entryId and suggestedCorrect are required');
  return retargetEntry(userId, entryId, correct);
}

/** 采纳一条"待补错形"建议：以本体/记忆的规范名为 correct 建一条 ontology_seed 词条。 */
export function adoptMissingSuggestion(
  userId: string,
  input: { wrong: string; correct: string; kind?: GlossaryKind; ontologyRef?: { groupId: string; fieldId: string } },
): GlossaryEntry | null {
  const wrong = String(input.wrong || '').trim();
  const correct = String(input.correct || '').trim();
  if (!wrong || !correct) throw new Error('transcript ontology: wrong and correct are required');
  const result = upsertEntry(userId, {
    wrong,
    correct,
    kind: input.kind ?? 'term',
    source: 'ontology_seed',
    ...(input.ontologyRef ? { ontologyRef: input.ontologyRef } : {}),
  });
  return result.entry;
}
