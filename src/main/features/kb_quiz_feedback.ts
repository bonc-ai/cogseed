/**
 * kb_quiz_feedback —— 测验的「优质内容 / 劣质内容」评分台账（本地、只追加）。
 *
 * 为什么单独一个文件：出题质量评分是**产品侧唯一的真信号**（模型刚出完题、用户
 * 正对着题目看），但当前没有上报通道，也不该偷偷上报。所以这里只做两件诚实的事：
 *   1. 把用户按下的「优质 / 劣质」按**题库指纹 + 题号**记到本机；
 *   2. 文件有界（超过 `MAX_LINES` 只保留最近 `KEEP_LINES` 行），不会无限长。
 *
 * 不写库、不联网、不进模型上下文；读取接口只给"统计"用，便于以后做面板或离线复盘。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger';
import { userKbQuizFeedbackFile } from '../paths';

const log = createLogger('kb-quiz-feedback');

/** 触发裁剪的行数上限（约 4000 条评分 ≈ 数百 KB）。 */
export const MAX_LINES = 4000;
/** 裁剪后保留的最近行数。 */
export const KEEP_LINES = 1000;

export type KbQuizVerdict = 'good' | 'bad';

export interface KbQuizFeedbackRecord {
  ts: number;
  /** 题库指纹（kb_quiz 的 fingerprint）：同一套题 = 同一指纹。 */
  fingerprint: string;
  /** 1-based 题号。 */
  qid: number;
  verdict: KbQuizVerdict;
  /** 题型（single / short），用于分题型看质量。 */
  type: string;
  /** 题目来源文档名（有则记，便于回溯是哪份材料出题质量差）。 */
  source?: string;
  /** 该题是否被答对（可选；只在有作答结果时记，不编造）。 */
  correct?: boolean;
}

export interface KbQuizFeedbackSummary {
  total: number;
  good: number;
  bad: number;
  /** 差评率（0–1）；无记录时为 null（不编数字）。 */
  badRate: number | null;
  /** 按题型聚合。 */
  byType: Record<string, { good: number; bad: number }>;
}

/** 单条记录的合法性校验：坏数据一律拒收（宁可少记也不写脏台账）。 */
export function normalizeFeedback(input: unknown): KbQuizFeedbackRecord | null {
  const raw = (input || {}) as Record<string, unknown>;
  const fingerprint = String(raw.fingerprint ?? '').trim();
  const verdict = String(raw.verdict ?? '').trim();
  const qid = Math.trunc(Number(raw.qid));
  if (!fingerprint || (verdict !== 'good' && verdict !== 'bad')) return null;
  if (!Number.isFinite(qid) || qid < 1) return null;
  const type = String(raw.type ?? '').trim() || 'unknown';
  const source = String(raw.source ?? '').trim();
  return {
    ts: Number.isFinite(Number(raw.ts)) && Number(raw.ts) > 0 ? Math.trunc(Number(raw.ts)) : Date.now(),
    fingerprint: fingerprint.slice(0, 64),
    qid,
    verdict: verdict as KbQuizVerdict,
    type: type.slice(0, 16),
    ...(source ? { source: source.slice(0, 200) } : {}),
    ...(typeof raw.correct === 'boolean' ? { correct: raw.correct } : {}),
  };
}

/** 文件超过 MAX_LINES 时只保留最近 KEEP_LINES 行（只追加语义下的有界化）。 */
export function trimLedger(file: string): number {
  let lines: string[];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return 0;
  }
  if (lines.length <= MAX_LINES) return lines.length;
  const kept = lines.slice(-KEEP_LINES);
  try {
    fs.writeFileSync(file, `${kept.join('\n')}\n`, 'utf8');
  } catch (err) {
    log.warn('kb quiz feedback trim failed', { error: (err as Error).message });
  }
  return kept.length;
}

export function appendQuizFeedback(
  userId: string,
  input: unknown,
  opts: { file?: string } = {},
): { ok: boolean; file: string; total: number } {
  const record = normalizeFeedback(input);
  const file = opts.file || userKbQuizFeedbackFile(userId);
  if (!record) return { ok: false, file, total: 0 };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    log.warn('kb quiz feedback append failed', { error: (err as Error).message });
    return { ok: false, file, total: 0 };
  }
  const total = trimLedger(file);
  return { ok: true, file, total };
}

/** 读取台账（面板/复盘用）：坏行跳过，不因为一行脏数据整表失败。 */
export function readQuizFeedback(userId: string, opts: { file?: string; limit?: number } = {}): KbQuizFeedbackRecord[] {
  const file = opts.file || userKbQuizFeedbackFile(userId);
  const limit = Math.max(1, Math.trunc(Number(opts.limit) || KEEP_LINES));
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: KbQuizFeedbackRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object' && (rec.verdict === 'good' || rec.verdict === 'bad')) out.push(rec as KbQuizFeedbackRecord);
    } catch { /* 坏行跳过 */ }
  }
  return out.slice(-limit);
}

export function summarizeQuizFeedback(records: KbQuizFeedbackRecord[]): KbQuizFeedbackSummary {
  let good = 0;
  let bad = 0;
  const byType: Record<string, { good: number; bad: number }> = {};
  for (const r of records) {
    const bucket = byType[r.type] || (byType[r.type] = { good: 0, bad: 0 });
    if (r.verdict === 'good') { good += 1; bucket.good += 1; } else { bad += 1; bucket.bad += 1; }
  }
  const total = records.length;
  return { total, good, bad, badRate: total ? bad / total : null, byType };
}
