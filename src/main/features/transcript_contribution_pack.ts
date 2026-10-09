/**
 * transcript_contribution_pack — 词表贡献包（方案 v0.2 §五 P3 / §2.1-11）
 *
 * 这是**唯一会把词表带出这台机器**的通道，所以隐私边界写在最前面：
 *   - 包里的词条**只留可共享字段**：wrong/correct/action/kind/riskLevel/boundary/
 *     contextDeny/contextAllow/ownerScope；**剥掉** `replacedIn`（含用户的文档名与
 *     runId）、`scope.docIds`（同上）、`id`（本地身份）、`meta.ownerNote`；
 *   - 人名类（kind=people）**默认不导**（方案 §5.1 红线），要导必须显式打开；
 *   - 导出的是"子集"：可按 kind / scenarioTags 过滤（方案 §五 P3-1）。
 *
 * 治理（P3-2）：合并优先级 **组织 > 团队 > 个人**；冲突（同 wrong 不同 correct）
 * 时高优先级胜出，但**不静默覆盖**——review 先给出"会新增/会冲突/高风险/含人名"，
 * 由人点确认。
 */

import { loadGlossary, saveGlossary, type GlossaryEntry, type GlossaryKind } from './transcript_glossary';

export const CONTRIBUTION_PACK_FORMAT = 'cogseed-transcript-contribution@1';

export type OwnerScope = 'personal' | 'team' | 'org';

export interface PackEntry {
  wrong: string;
  correct: string;
  action: 'replace' | 'delete';
  kind: GlossaryKind;
  riskLevel: 'low' | 'medium' | 'high';
  boundary: 'substring' | 'word';
  contextDeny: string[];
  contextAllow: string[];
  scenarioTags: string[];
  ownerScope: OwnerScope;
}

export interface ContributionPack {
  format: typeof CONTRIBUTION_PACK_FORMAT;
  exportedAt: number;
  /** 这份包的归属层级（导入时按它决定优先级）。 */
  ownerScope: OwnerScope;
  counts: { total: number; peopleExcluded: number; byKind: Record<string, number> };
  entries: PackEntry[];
}

export interface PackFilters {
  kinds?: GlossaryKind[];
  scenarioTags?: string[];
  includePeople?: boolean;
  ownerScope?: OwnerScope;
}

function scopeRank(scope: OwnerScope): number {
  if (scope === 'org') return 3;
  if (scope === 'team') return 2;
  return 1;
}

function toPackEntry(entry: GlossaryEntry, ownerScope: OwnerScope): PackEntry {
  return {
    wrong: entry.wrong,
    correct: entry.correct,
    action: entry.action,
    kind: entry.kind,
    riskLevel: entry.riskLevel,
    boundary: entry.boundary,
    contextDeny: [...entry.contextDeny],
    contextAllow: [...(entry.contextAllow ?? [])],
    scenarioTags: [...(entry.scope?.scenarioTags ?? [])],
    ownerScope,
  };
}

/**
 * 构造贡献包。只导出 active 词条；`includePeople=false`（默认）时人名类整类不掉，
 * 并在 counts 里如实报告被排除多少条（不假装"就这么多"）。
 */
export function buildContributionPack(userId: string, filters: PackFilters = {}): ContributionPack {
  const ownerScope: OwnerScope = filters.ownerScope === 'team' || filters.ownerScope === 'org'
    ? filters.ownerScope
    : 'personal';
  const includePeople = filters.includePeople === true;
  const kinds = new Set(filters.kinds ?? []);
  const tags = new Set(filters.scenarioTags ?? []);
  const entries: PackEntry[] = [];
  const byKind: Record<string, number> = {};
  let peopleExcluded = 0;

  for (const entry of loadGlossary(userId).entries) {
    if (entry.status !== 'active') continue;
    if (entry.kind === 'people' && !includePeople) {
      peopleExcluded += 1;
      continue;
    }
    if (kinds.size > 0 && !kinds.has(entry.kind)) continue;
    if (tags.size > 0) {
      const entryTags = entry.scope?.scenarioTags ?? [];
      if (!entryTags.some((tag) => tags.has(tag))) continue;
    }
    entries.push(toPackEntry(entry, ownerScope));
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
  }
  return {
    format: CONTRIBUTION_PACK_FORMAT,
    exportedAt: Date.now(),
    ownerScope,
    counts: { total: entries.length, peopleExcluded, byKind },
    entries,
  };
}

/** 校验外来包（格式/字段形状），坏包直接拒绝而不是"尽力解析"。 */
export function parseContributionPack(raw: unknown): ContributionPack | null {
  const pack = raw as Partial<ContributionPack> | null;
  if (!pack || pack.format !== CONTRIBUTION_PACK_FORMAT) return null;
  if (!Array.isArray(pack.entries)) return null;
  const entries: PackEntry[] = [];
  for (const item of pack.entries) {
    const row = item as Partial<PackEntry>;
    const wrong = String(row?.wrong ?? '').trim();
    const action = row?.action === 'delete' ? 'delete' : 'replace';
    const correct = action === 'delete' ? '' : String(row?.correct ?? '').trim();
    if (!wrong) continue;
    if (action === 'replace' && !correct) continue;
    entries.push({
      wrong,
      correct,
      action,
      kind: (row?.kind ?? 'term') as GlossaryKind,
      riskLevel: row?.riskLevel === 'high' || row?.riskLevel === 'medium' ? row.riskLevel : 'low',
      boundary: row?.boundary === 'word' ? 'word' : 'substring',
      contextDeny: Array.isArray(row?.contextDeny) ? row!.contextDeny!.map(String).slice(0, 50) : [],
      contextAllow: Array.isArray(row?.contextAllow) ? row!.contextAllow!.map(String).slice(0, 50) : [],
      scenarioTags: Array.isArray(row?.scenarioTags) ? row!.scenarioTags!.map(String).slice(0, 50) : [],
      ownerScope: row?.ownerScope === 'org' || row?.ownerScope === 'team' ? row.ownerScope : 'personal',
    });
  }
  return {
    format: CONTRIBUTION_PACK_FORMAT,
    exportedAt: Number(pack.exportedAt) || 0,
    ownerScope: pack.ownerScope === 'org' || pack.ownerScope === 'team' ? pack.ownerScope : 'personal',
    counts: {
      total: entries.length,
      peopleExcluded: Number(pack.counts?.peopleExcluded) || 0,
      byKind: pack.counts?.byKind ?? {},
    },
    entries,
  };
}

export interface PackReview {
  total: number;
  /** 本地没有 → 会新增。 */
  added: number;
  /** 本地已有同 key 且写法相同 → 只更新规则字段。 */
  updates: number;
  /** 同 wrong 不同 correct → 冲突（按优先级决定谁留下）。 */
  conflicts: Array<{ wrong: string; localCorrect: string; packCorrect: string; winner: 'local' | 'pack' }>;
  /** 包里的高风险词条数（导入后默认仍需逐条确认）。 */
  highRisk: number;
  /** 包里含人名类条数（默认导出不该有；有就说明对方显式导了）。 */
  people: number;
  /** 包声称的层级与本地同 key 词条的层级比较结果（供人判断）。 */
  ownerScope: OwnerScope;
}

/** 预览导入结果（不落盘）：新增/更新/冲突/高风险/人名一次说清。 */
export function reviewContributionPack(userId: string, pack: ContributionPack): PackReview {
  // 与 apply 用同一套归一化：预览必须等于"导入后会发生什么"
  pack = parseContributionPack(pack) ?? pack;
  const local = loadGlossary(userId).entries;
  const fold = (s: string): string => String(s || '').normalize('NFKC').toLowerCase().trim();
  const localByWrong = new Map<string, GlossaryEntry[]>();
  for (const entry of local) {
    const key = fold(entry.wrong);
    localByWrong.set(key, [...(localByWrong.get(key) ?? []), entry]);
  }
  let added = 0;
  let updates = 0;
  let highRisk = 0;
  let people = 0;
  const conflicts: PackReview['conflicts'] = [];
  for (const entry of pack.entries) {
    if (entry.riskLevel === 'high') highRisk += 1;
    if (entry.kind === 'people') people += 1;
    const matches = localByWrong.get(fold(entry.wrong)) ?? [];
    if (matches.length === 0) {
      added += 1;
      continue;
    }
    const same = matches.some((item) => fold(item.correct) === fold(entry.correct));
    if (same) {
      updates += 1;
      continue;
    }
    const winner: 'local' | 'pack' = scopeRank(pack.ownerScope) > scopeRank(matches[0].ownerScope) ? 'pack' : 'local';
    conflicts.push({
      wrong: entry.wrong,
      localCorrect: matches[0].correct,
      packCorrect: entry.correct,
      winner,
    });
  }
  return { total: pack.entries.length, added, updates, conflicts, highRisk, people, ownerScope: pack.ownerScope };
}

export interface ImportPackResult {
  added: number;
  updated: number;
  overwritten: number;
  keptLocal: number;
  refused: Array<{ wrong: string; why: string }>;
}

/**
 * 应用贡献包：**组织 > 团队 > 个人**。
 *   - 本地没有 → 新增（**带包声明的层级**：包的层级是治理语义，条内字段不覆盖它）；
 *   - 同 wrong 同 correct → 只更新规则字段（含层级升格）；
 *   - 同 wrong 不同 correct → 高优先级胜出；本地更高时**保留本地**并如实计数。
 */
export function applyContributionPack(
  userId: string,
  pack: ContributionPack,
  opts: { dryRun?: boolean } = {},
): ImportPackResult {
  // 贡献包来自别的机器（可能被手工编辑过）：先用同一套校验归一化，
  // 缺字段一律补默认值——绝不把 undefined 写进用户的词表。
  const normalized = parseContributionPack(pack) ?? pack;
  pack = normalized;
  const file = loadGlossary(userId);
  const fold = (s: string): string => String(s || '').normalize('NFKC').toLowerCase().trim();
  const result: ImportPackResult = { added: 0, updated: 0, overwritten: 0, keptLocal: 0, refused: [] };
  const now = Date.now();

  for (const incoming of pack.entries) {
    const matches = file.entries.filter((entry) => fold(entry.wrong) === fold(incoming.wrong));
    if (matches.length === 0) {
      file.entries.push({
        id: `g_pack_${fold(incoming.wrong)}_${fold(incoming.correct)}`.slice(0, 60),
        wrong: incoming.wrong,
        correct: incoming.correct,
        action: incoming.action,
        kind: incoming.kind,
        riskLevel: incoming.riskLevel,
        boundary: incoming.boundary,
        contextDeny: incoming.contextDeny,
        contextAllow: incoming.contextAllow,
        scope: {
          docIds: [],
          scenarioTags: incoming.scenarioTags,
          // 来自贡献包 ≠ 全局：先按本场景/本层级生效，避免"一次导入改所有文档"
          global: incoming.scenarioTags.length === 0 && pack.ownerScope !== 'personal',
        },
        freq: 0,
        source: 'import',
        status: 'active',
        ownerScope: pack.ownerScope,
        replacedIn: [],
        createdBy: 'import',
        createdAt: now,
        updatedAt: now,
        lastVerifiedAt: 0,
      });
      result.added += 1;
      continue;
    }
    const same = matches.find((entry) => fold(entry.correct) === fold(incoming.correct));
    if (same) {
      same.contextDeny = incoming.contextDeny;
      same.contextAllow = incoming.contextAllow;
      if (scopeRank(pack.ownerScope) >= scopeRank(same.ownerScope)) same.ownerScope = pack.ownerScope;
      same.updatedAt = now;
      result.updated += 1;
      continue;
    }
    const localHighest = matches.reduce(
      (best, entry) => (scopeRank(entry.ownerScope) > scopeRank(best) ? entry.ownerScope : best),
      'personal' as OwnerScope,
    );
    if (scopeRank(pack.ownerScope) > scopeRank(localHighest)) {
      for (const entry of matches) {
        entry.correct = incoming.correct;
        entry.riskLevel = incoming.riskLevel;
        entry.contextDeny = incoming.contextDeny;
        entry.contextAllow = incoming.contextAllow;
        entry.ownerScope = pack.ownerScope;
        entry.updatedAt = now;
      }
      result.overwritten += 1;
    } else {
      result.keptLocal += 1;
      result.refused.push({ wrong: incoming.wrong, why: `local_scope_wins(${localHighest})` });
    }
  }
  if (!opts.dryRun && (result.added > 0 || result.updated > 0 || result.overwritten > 0)) {
    saveGlossary(userId, file);
  }
  return result;
}
