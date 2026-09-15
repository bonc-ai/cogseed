/**
 * transcript_glossary_seed — 方案附 A 的初始词表种子
 *
 * 依据 `本体驱动的转写词汇纠错表-落地计划方案-2026-09-07.md` 附 A「初始词表种子
 * （从 09-14 对照的术语对照表导入）」。这份清单是**方案文档的一部分**，不是我从
 * 语料里猜的；每行的 kind/riskLevel 也照抄方案，避免"我替用户降风险"。
 *
 * 两处刻意不入册（方案 §2.2 红线，写在下面）：
 *   - `for → Forge`：介词/关键字，方案明写"默认不入册，仅会议场景人工确认后启用"；
 *   - 口癖类（action=delete）：不在这里，走 `transcript_filler_rules` 规则包。
 */

import { upsertEntry, type GlossaryEntry, type GlossaryKind, type RiskLevel } from './transcript_glossary';

export interface SeedRow {
  wrong: string;
  correct: string;
  kind: GlossaryKind;
  riskLevel: RiskLevel;
  /** 方案附 A 的"说明"列（只注释用，不落盘到词条）。 */
  note: string;
}

export const INITIAL_GLOSSARY_SEED: SeedRow[] = [
  { wrong: 'coxy', correct: 'Cogseed', kind: 'product', riskLevel: 'low', note: '本项目已确认名称' },
  { wrong: 'cox', correct: 'Cogseed', kind: 'product', riskLevel: 'low', note: '同上' },
  { wrong: 'coxseed', correct: 'Cogseed', kind: 'product', riskLevel: 'low', note: '同上' },
  { wrong: 'cxxy', correct: 'Cogseed', kind: 'product', riskLevel: 'low', note: '同上' },
  { wrong: 'coxxy', correct: 'Cogseed', kind: 'product', riskLevel: 'low', note: '同上' },
  { wrong: 'coxx', correct: 'Cogseed', kind: 'product', riskLevel: 'low', note: '同上' },
  { wrong: 'coxed', correct: 'Cogseed', kind: 'product', riskLevel: 'low', note: '同上' },
  { wrong: 'cogsed', correct: 'Cogseed', kind: 'product', riskLevel: 'low', note: '同上' },
  { wrong: 'code seat', correct: 'Cogseed', kind: 'product', riskLevel: 'low', note: '同上' },
  { wrong: 'K star', correct: 'KSTAR', kind: 'term', riskLevel: 'low', note: 'k42／k32 为部分形态 → 限本场景' },
  { wrong: 'K 星', correct: 'KSTAR', kind: 'term', riskLevel: 'low', note: '' },
  { wrong: 'K2', correct: 'KSTAR', kind: 'term', riskLevel: 'low', note: '部分形态 → 限本场景' },
  { wrong: 'K4', correct: 'KSTAR', kind: 'term', riskLevel: 'low', note: '部分形态 → 限本场景' },
  { wrong: 'Case2', correct: 'KSTAR', kind: 'term', riskLevel: 'low', note: '' },
  { wrong: '雷蒙德', correct: 'Raymond', kind: 'product', riskLevel: 'low', note: '用户补充确认' },
  { wrong: 'IDC', correct: 'EduSeed', kind: 'course', riskLevel: 'medium', note: 'IDC 在其它语境可能是机构缩写' },
  { wrong: 'IU seed', correct: 'EduSeed', kind: 'course', riskLevel: 'medium', note: '' },
  { wrong: 'open cloud', correct: 'OpenClaw', kind: 'product', riskLevel: 'low', note: '普通 cloud 不替换' },
  { wrong: 'cloud code', correct: 'Claude Code', kind: 'product', riskLevel: 'low', note: '' },
  { wrong: 'redmi', correct: 'README', kind: 'term', riskLevel: 'high', note: '合法英文词根 → 默认仅本文档生效' },
  { wrong: 'model', correct: 'Moodle', kind: 'term', riskLevel: 'high', note: 'model 是高频技术词 → 默认待确认' },
  { wrong: 'contact', correct: 'Context', kind: 'term', riskLevel: 'high', note: '同上' },
  { wrong: '健全', correct: '鉴权', kind: 'term', riskLevel: 'medium', note: '中文常用词 → 需语境确认' },
  { wrong: '多 vbl', correct: '多维表格', kind: 'term', riskLevel: 'medium', note: '' },
  { wrong: 'personalontology', correct: 'Personal Ontology', kind: 'term', riskLevel: 'low', note: '' },
  { wrong: 'personaltology', correct: 'Personal Ontology', kind: 'term', riskLevel: 'low', note: '' },
];

/** 方案明写"默认不入册"的词（显式列出，防止以后有人"顺手补上"）。 */
export const SEED_EXCLUDED: Array<{ wrong: string; correct: string; why: string }> = [
  { wrong: 'for', correct: 'Forge', why: '介词/关键字 → 方案 §2.2：默认不入册，仅会议场景人工确认后启用' },
];

export interface SeedInitialResult {
  created: number;
  updated: number;
  skipped: Array<{ wrong: string; reason: string }>;
}

/**
 * 把附 A 种子写进词表（幂等：已有的等价词条只会被更新规则字段）。
 * 只写种子里的词条，不改用户既有词条的写法与作用域。
 */
export function seedInitialEntries(userId: string): SeedInitialResult {
  let created = 0;
  let updated = 0;
  const skipped: SeedInitialResult['skipped'] = [];
  for (const row of INITIAL_GLOSSARY_SEED) {
    const result = upsertEntry(userId, {
      wrong: row.wrong,
      correct: row.correct,
      kind: row.kind,
      riskLevel: row.riskLevel,
      source: 'import',
    });
    const entry: GlossaryEntry | null = result.entry;
    if (!entry) {
      skipped.push({ wrong: row.wrong, reason: result.skippedReason ?? 'rejected' });
      continue;
    }
    if (result.created) created += 1;
    else updated += 1;
  }
  return { created, updated, skipped };
}
