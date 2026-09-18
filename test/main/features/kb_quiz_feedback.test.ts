/**
 * kb_quiz_feedback —— 测验「优质内容 / 劣质内容」的本地台账。
 *
 * 这个模块只有两个职责，两个都必须可验证：
 *   1. **只收合法记录**（坏数据宁可少记也不写脏台账：缺指纹、非法 verdict、题号 < 1 一律拒收）；
 *   2. **文件有界**（超 MAX_LINES 只保留最近 KEEP_LINES 行）。
 * 外加一个"不编数字"的口径：没有记录时 badRate 必须是 null，不是 0。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  normalizeFeedback,
  appendQuizFeedback,
  readQuizFeedback,
  summarizeQuizFeedback,
  trimLedger,
  MAX_LINES,
  KEEP_LINES,
} from '../../../src/main/features/kb_quiz_feedback';

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-quiz-feedback-'));
  return path.join(dir, name);
}

describe('kb_quiz_feedback', () => {
  it('拒收坏记录：缺指纹 / 非法 verdict / 题号非法', () => {
    expect(normalizeFeedback({ fingerprint: '', qid: 1, verdict: 'good' })).toBeNull();
    expect(normalizeFeedback({ fingerprint: 'fp', qid: 1, verdict: 'meh' })).toBeNull();
    expect(normalizeFeedback({ fingerprint: 'fp', qid: 0, verdict: 'good' })).toBeNull();
    expect(normalizeFeedback({ fingerprint: 'fp', qid: -3, verdict: 'bad' })).toBeNull();
    expect(normalizeFeedback(null)).toBeNull();
  });

  it('合法记录补齐默认值（ts/type），并带上可选字段', () => {
    const rec = normalizeFeedback({ fingerprint: 'fp1', qid: 2, verdict: 'bad', type: 'single', source: '报告.md', correct: false })!;
    expect(rec.fingerprint).toBe('fp1');
    expect(rec.qid).toBe(2);
    expect(rec.verdict).toBe('bad');
    expect(rec.type).toBe('single');
    expect(rec.source).toBe('报告.md');
    expect(rec.correct).toBe(false);
    expect(rec.ts).toBeGreaterThan(0);
    // 未给 type 时记 unknown，而不是编一个题型
    expect(normalizeFeedback({ fingerprint: 'fp', qid: 1, verdict: 'good' })!.type).toBe('unknown');
  });

  it('追加成功后可读回；坏输入不落盘', () => {
    const file = tmpFile('quiz-feedback.jsonl');
    const okRes = appendQuizFeedback('u1', { fingerprint: 'fp', qid: 1, verdict: 'good', type: 'single' }, { file });
    expect(okRes.ok).toBe(true);
    expect(okRes.total).toBe(1);
    const badRes = appendQuizFeedback('u1', { fingerprint: '', qid: 1, verdict: 'good' }, { file });
    expect(badRes.ok).toBe(false);
    const rows = readQuizFeedback('u1', { file });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fingerprint: 'fp', qid: 1, verdict: 'good' });
  });

  it('坏行跳过（一行脏数据不让整表失败）', () => {
    const file = tmpFile('quiz-feedback.jsonl');
    fs.writeFileSync(file, [
      '{"fingerprint":"a","qid":1,"verdict":"good","type":"single","ts":1}',
      '{ 这不是 JSON',
      '{"fingerprint":"b","qid":2,"verdict":"bad","type":"short","ts":2}',
    ].join('\n') + '\n', 'utf8');
    const rows = readQuizFeedback('u1', { file });
    expect(rows.map((r) => r.fingerprint)).toEqual(['a', 'b']);
  });

  it('超过 MAX_LINES 只保留最近 KEEP_LINES 行（有界台账）', () => {
    const file = tmpFile('quiz-feedback.jsonl');
    const total = MAX_LINES + 50;
    const lines = Array.from({ length: total }, (_, i) => JSON.stringify({ fingerprint: `fp${i}`, qid: 1, verdict: 'good', type: 'single', ts: i + 1 }));
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    const kept = trimLedger(file);
    expect(kept).toBe(KEEP_LINES);
    const rows = readQuizFeedback('u1', { file, limit: 100000 });
    expect(rows).toHaveLength(KEEP_LINES);
    // 保留的是"最近"的一批
    expect(rows[rows.length - 1].fingerprint).toBe(`fp${total - 1}`);
  });

  it('汇总按题型分组；没有记录时 badRate 是 null（不编 0）', () => {
    expect(summarizeQuizFeedback([])).toEqual({ total: 0, good: 0, bad: 0, badRate: null, byType: {} });
    const summary = summarizeQuizFeedback([
      { ts: 1, fingerprint: 'a', qid: 1, verdict: 'good', type: 'single' },
      { ts: 2, fingerprint: 'a', qid: 2, verdict: 'bad', type: 'single' },
      { ts: 3, fingerprint: 'a', qid: 3, verdict: 'good', type: 'short' },
    ]);
    expect(summary.total).toBe(3);
    expect(summary.good).toBe(2);
    expect(summary.bad).toBe(1);
    expect(summary.badRate).toBeCloseTo(1 / 3, 5);
    expect(summary.byType).toEqual({ single: { good: 1, bad: 1 }, short: { good: 1, bad: 0 } });
  });
});
