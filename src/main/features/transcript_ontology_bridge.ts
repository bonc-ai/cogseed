/**
 * transcript_ontology_bridge — 词表与个人本体、长期记忆的对齐。
 *
 * 将词条按概念归组；对已存在的本体概念挂 ontologyRef，只给出写法对齐或待补错形建议，
 * 不从纠错记录产生认知候选。空来源返回空结果，不造占位数据。
 *
 * 来源是正式本体、用户维护的本体分组字段值，以及 USER.md / MEMORY.md 中的长期记忆。
 * 本体字段值可以提出待补错形；长期记忆仅用于已有概念对齐。
 * taxonomy 的字段名与分组标题只作结构标签，不作为待补术语。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
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
import { readOntologyDocument } from './cognition/ontology/service';
import { loadOntologyTaxonomy } from './recall/ontology-taxonomy';
import {
  collectTemplateFileFields,
  isTemplateFileText,
  parseGroupContent,
} from './personal_ontology_groups';

const log = createLogger('transcript_ontology_bridge');

const MAX_CANONICAL_NAMES = 500;
/** 超过此长度的文本不是"名字"，是句子（字段值/记忆条目都可能很长）。 */
const MAX_CANONICAL_NAME_LEN = 40;

export interface CanonicalName {
  name: string;
  source: 'ontology' | 'memory';
  /**
   * 来源细分（决定"能不能当待补词条提出去"）：
   *   value = 分组文件里的字段值（用户自己填的名单，可信，可提待补）
   *   field = 本体重字段名（来自 `recall/ontology-taxonomy`，是**结构标签**，
   *           只用于挂引用/对齐，绝不提议"补错形"——那只会制造噪声）
   *   group = 分组标题（同上）
   */
  seedKind?: 'value' | 'field' | 'group';
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

export interface SyncStats {
  /** 分组文件里用户填的字段值个数（唯一能生产"待补"的来源）。 */
  ontologyValues: number;
  /** 本体重字段名个数（结构标签，只参与挂引用/对齐）。 */
  ontologyFields: number;
  /** 长期记忆条目个数。 */
  memoryEntries: number;
}

export interface SyncResult {
  /** 归组统计（可用于面板分组展示）。 */
  groups: ConceptGroup[];
  /** 实际写入 ontologyRef 的词条数（本体为空时为 0）。 */
  linked: number;
  /** 规范写法对齐建议数。 */
  alignments: SeedSuggestion[];
  /** 词表里缺失的规范名数。 */
  missing: SeedSuggestion[];
  /** 扫描到的规范名总数（本体 + 记忆）。 */
  canonicalNames: number;
  /** 来源细分（面板据此区分"有内容"和"只有结构"两种空）。 */
  stats: SyncStats;
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
    // 只有"用户填写过的字段值"才值得提议补词条；分组标题/字段名是结构标签
    if (canonical.seedKind && canonical.seedKind !== 'value') continue;
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

  // 正式本体主档优先；仅收任务可用、已确认的个人域规范实体，未确认身份不作纠错依据。
  const ontology = readOntologyDocument(userId);
  for (const record of Object.values(ontology.records)) {
    if (record.kind !== 'entity' || record.status !== 'active' || record.access !== 'task'
      || record.identityStatus !== 'confirmed' || record.certainty && record.certainty !== 'confirmed') continue;
    const module = ontology.records[record.moduleId];
    if (module?.kind !== 'module' || module.status !== 'active' || module.access !== 'task' || module.scope.kind !== 'personal') continue;
    for (const name of [record.name, ...record.aliases]) push(name, 'ontology', { seedKind: 'value', ontologyRef: { groupId: module.id, fieldId: record.id } });
  }
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
            push(String(fieldValue?.value ?? ''), 'ontology', {
              seedKind: 'value',
              ontologyRef: { groupId, fieldId: field.name },
            });
          }
        }
      } else {
        const content = parseGroupContent(text);
        for (const [fieldName, values] of Object.entries(content.fields ?? {})) {
          for (const fieldValue of values ?? []) {
            push(String(fieldValue?.value ?? ''), 'ontology', {
              seedKind: 'value',
              ontologyRef: { groupId, fieldId: fieldName },
            });
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

/**
 * 在文件来源之外，补上 `recall/ontology-taxonomy`。
 *
 * **只作为"结构标签"补进来**（seedKind=field/group）：字段名 `团队成员`、分组标题
 * `示例分组` 这类是结构，不是待纠正的术语——把它们当词条提议会导致一堆永远匹配
 * 不上的噪声。它们的作用是：分组文件还没填值时，词条仍能通过字段名挂上
 * `ontologyRef`（本体定位照旧可查）。
 * taxonomy 读失败（契约/文件问题）时安静降级为"没读到"，不影响同步其余部分。
 */
export async function collectTaxonomyNames(userId: string): Promise<CanonicalName[]> {
  const names: CanonicalName[] = [];
  try {
    const taxonomy = await loadOntologyTaxonomy(userId);
    for (const group of taxonomy.groups) {
      if (group.title) {
        names.push({
          name: String(group.title).trim(),
          source: 'ontology',
          seedKind: 'group',
          ...(group.groupId ? { ontologyRef: { groupId: group.groupId, fieldId: '' } } : {}),
        });
      }
      for (const field of group.fields ?? []) {
        const fieldName = String(field?.name ?? '').trim();
        if (!fieldName) continue;
        names.push({
          name: fieldName,
          source: 'ontology',
          seedKind: 'field',
          ...(group.groupId ? { ontologyRef: { groupId: group.groupId, fieldId: fieldName } } : {}),
        });
      }
    }
  } catch (error) {
    log.warn('ontology taxonomy read failed; continuing without it', { error: (error as Error).message });
  }
  return names;
}

/** 收集全部规范名（文件来源 + taxonomy 结构标签），并给出来源细分。 */
export async function collectAllCanonicalNames(userId: string): Promise<{
  names: CanonicalName[];
  stats: SyncStats;
}> {
  const fileNames = collectCanonicalNames(userId);
  const taxonomyNames = await collectTaxonomyNames(userId);
  const names = [...fileNames, ...taxonomyNames].slice(0, MAX_CANONICAL_NAMES + 200);
  return {
    names,
    stats: {
      ontologyValues: names.filter((n) => n.source === 'ontology' && n.seedKind !== 'field' && n.seedKind !== 'group').length,
      ontologyFields: names.filter((n) => n.seedKind === 'field' || n.seedKind === 'group').length,
      memoryEntries: names.filter((n) => n.source === 'memory').length,
    },
  };
}

// ── 组合动作 ────────────────────────────────────────────────────────────

/** 把能对上本体概念的词条挂上 ontologyRef（只改这一个字段）。 */
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

/** 同步已有本体引用、概念分组与只读对齐建议，不生产认知候选。 */
export async function syncOntology(
  userId: string,
): Promise<SyncResult> {
  const entries = loadGlossary(userId).entries;
  const { names, stats } = await collectAllCanonicalNames(userId);
  const linked = linkOntologyRefs(userId, entries, names);
  const after = linked > 0 ? loadGlossary(userId).entries : entries;
  return {
    groups: groupByConcept(after),
    linked,
    alignments: suggestAlignments(after, names),
    missing: suggestMissing(after, names),
    canonicalNames: names.length,
    stats,
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
