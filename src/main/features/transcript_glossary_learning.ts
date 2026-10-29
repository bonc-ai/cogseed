/**
 * 转写词表的“越用越多”学习账本。
 *
 * 为什么单独一个文件：词表文件是 v4 的用户资产，学习计数只是**过程数据**
 * （确认过几次、什么时候升级成全局、是否被撤销）。把它塞进 v4 会让导出、
 * 备份和贡献包都带上内部计数；单独账本可以随时重建，也不改变现有词表契约。
 *
 * 规则（与产品方案一致）：
 *   - 同一对 `wrong → correct` 被用户确认达到阈值（默认 3 次）后升级为个人全局词；
 *   - 已经在词表里的词条不重复学习；
 *   - 自动学习可关闭、可通知、可撤销；
 *   - 任何失败都不阻塞纠错主流程（学习是附加能力）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonSync, writeJsonSync } from '../storage';
import { userTranscriptGlossaryDir } from '../paths';
import { fileEditLock } from '../util/locks';
import { deleteEntry, foldText, listEntries, upsertEntry, type GlossaryKind } from './transcript_glossary';

export interface LearningSettings {
  enabled: boolean;
  threshold: number;
  notify: boolean;
}

export interface LearnedPair {
  wrong: string;
  correct: string;
  kind: GlossaryKind;
  count: number;
  learnedEntryId: string;
  learnedAt: number;
}

interface LearningRecord {
  wrong: string;
  correct: string;
  kind: GlossaryKind;
  count: number;
  firstAt: number;
  lastAt: number;
  learnedEntryId?: string;
  learnedAt?: number;
}

interface LearningFile {
  version: 1;
  uid: string;
  settings: LearningSettings;
  records: LearningRecord[];
}

const VERSION = 1 as const;
const MAX_RECORDS = 2000;
const DEFAULT_SETTINGS: LearningSettings = { enabled: true, threshold: 3, notify: true };

const learningFile = (uid: string) => path.join(userTranscriptGlossaryDir(uid), 'transcript-glossary-learning.json');
const keyOf = (wrong: string, correct: string) => `${foldText(wrong).trim()}\u0000${foldText(correct).trim()}`;

function normalizeSettings(raw: unknown): LearningSettings {
  const value = raw && typeof raw === 'object' ? raw as Partial<LearningSettings> : {};
  const threshold = Number(value.threshold);
  return {
    enabled: value.enabled !== false,
    threshold: Number.isInteger(threshold) ? Math.min(5, Math.max(2, threshold)) : DEFAULT_SETTINGS.threshold,
    notify: value.notify !== false,
  };
}

function emptyFile(uid: string): LearningFile {
  return { version: VERSION, uid, settings: { ...DEFAULT_SETTINGS }, records: [] };
}

function load(userId: string): LearningFile {
  const file = learningFile(userId);
  const raw = readJsonSync<Partial<LearningFile>>(file);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.records)) return emptyFile(userId);
  return {
    version: VERSION,
    uid: userId,
    settings: normalizeSettings(raw.settings),
    records: raw.records.filter((r): r is LearningRecord => !!r && typeof r === 'object'
      && typeof (r as LearningRecord).wrong === 'string' && typeof (r as LearningRecord).correct === 'string')
      .slice(-MAX_RECORDS),
  };
}

function save(userId: string, file: LearningFile): void {
  try {
    writeJsonSync(learningFile(userId), file);
  } catch {
    // 学习是附加能力，写失败不能影响纠错主流程；下次确认会重新累计。
  }
}

export function getLearningState(userId: string): {
  settings: LearningSettings;
  recent: Array<LearnedPair & { at: number }>;
} {
  const file = load(userId);
  const recent = file.records
    .filter((r) => r.learnedEntryId && r.learnedAt)
    .sort((a, b) => (b.learnedAt || 0) - (a.learnedAt || 0))
    .slice(0, 20)
    .map((r) => ({
      wrong: r.wrong, correct: r.correct, kind: r.kind, count: r.count,
      learnedEntryId: r.learnedEntryId!, learnedAt: r.learnedAt!, at: r.learnedAt!,
    }));
  return { settings: file.settings, recent };
}

export async function setLearningSettings(userId: string, patch: Partial<LearningSettings>): Promise<LearningSettings> {
  return fileEditLock(`${learningFile(userId)}.lock`).runExclusive(() => {
    const file = load(userId);
    file.settings = normalizeSettings({ ...file.settings, ...patch });
    save(userId, file);
    return file.settings;
  });
}

/**
 * 记录用户确认过的纠错对，达到阈值时升级为个人全局词。
 *
 * 只处理 `replace`、非空、wrong !== correct、且词表里尚不存在同对的条目。
 * 返回值只包含**这一次**新升级的词，供 UI/Agent 如实告知用户。
 */
export async function recordConfirmedCorrections(
  userId: string,
  pairs: ReadonlyArray<{ wrong: string; correct: string; kind?: GlossaryKind }>,
): Promise<{ settings: LearningSettings; learned: LearnedPair[] }> {
  try {
    return await fileEditLock(`${learningFile(userId)}.lock`).runExclusive(async () => {
    const file = load(userId);
    const settings = file.settings;
    if (!settings.enabled || !pairs.length) return { settings, learned: [] };

    const existing = new Set(listEntries(userId, { status: 'active' })
      .map((e) => keyOf(e.wrong, e.correct)));
    const now = Date.now();
    const learned: LearnedPair[] = [];
    let changed = false;

    for (const pair of pairs) {
      const wrong = String(pair?.wrong || '').trim();
      const correct = String(pair?.correct || '').trim();
      if (!wrong || !correct || wrong === correct) continue;
      const key = keyOf(wrong, correct);
      if (existing.has(key)) continue;
      const kind: GlossaryKind = pair.kind || 'term';
      let record = file.records.find((r) => keyOf(r.wrong, r.correct) === key);
      if (!record) {
        record = { wrong, correct, kind, count: 0, firstAt: now, lastAt: now };
        file.records.push(record);
      }
      record.count += 1;
      record.lastAt = now;
      changed = true;
      if (record.learnedEntryId || record.count < settings.threshold) continue;

      let result;
      try {
        result = upsertEntry(userId, {
          wrong, correct, kind, source: 'meeting_accept',
        });
      } catch {
        // 学习是附加能力：单词写入失败不能拖垮本次正文应用。
        continue;
      }
      if (!result.entry) continue;
      record.learnedEntryId = result.entry.id;
      record.learnedAt = now;
      existing.add(key);
      learned.push({
        wrong, correct, kind, count: record.count,
        learnedEntryId: result.entry.id, learnedAt: now,
      });
    }

    if (changed) save(userId, file);
    return { settings, learned };
  });
  } catch {
    return { settings: load(userId).settings, learned: [] };
  }
}

/** 撤销一次自动学习：删除刚升级的词条，并把计数回退到阈值以下。 */
export async function undoLearnedEntry(userId: string, entryId: string): Promise<boolean> {
  return fileEditLock(`${learningFile(userId)}.lock`).runExclusive(() => {
    const file = load(userId);
    const record = file.records.find((r) => r.learnedEntryId === entryId);
    const removed = deleteEntry(userId, entryId);
    if (record) {
      record.learnedEntryId = undefined;
      record.learnedAt = undefined;
      record.count = 0;
      save(userId, file);
    }
    return removed;
  });
}

export function learningFilePath(userId: string): string {
  return learningFile(userId);
}

export function _resetLearningFileForTest(userId: string): void {
  fs.rmSync(learningFile(userId), { force: true });
}
