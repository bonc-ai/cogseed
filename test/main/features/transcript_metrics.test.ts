/**
 * transcript_metrics — 本地埋点（方案 v0.2 §8.2「可选埋点，本地」）
 *
 * 守的不变量：只测能诚实测到的两项；测不到的**如实列出**，不编数字；
 * 埋点文件只追加、坏行不影响读取。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import {
  CONFIRM_LATENCY_TARGET_MS,
  median,
  readEvents,
  recordConfirmLatency,
  recordRetention,
  summarizeMetrics,
} from '../../../src/main/features/transcript_metrics';
import { userTranscriptMetricsFile } from '../../../src/main/paths';

let uid = '';
beforeEach(() => {
  uid = `u_metrics_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
});

describe('中位数（偶数取平均）', () => {
  it('奇偶与空值都安全', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 3])).toBe(2);
    expect(median([9, 1, 5])).toBe(5);
  });
});

describe('只追加的埋点文件', () => {
  it('记录后能读回，且是一行一个事件', () => {
    recordConfirmLatency(uid, { ms: 4200, docId: 'doc-a', rows: 12, accepted: 9 });
    recordRetention(uid, { retention: 0.79, charsIn: 1000, charsOut: 790, overRewrite: false, docId: 'doc-a' });
    const events = readEvents(uid);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'confirm_latency', ms: 4200, rows: 12 });
    expect(events[1]).toMatchObject({ kind: 'retention', retention: 0.79, overRewrite: false });
    const raw = fs.readFileSync(userTranscriptMetricsFile(uid), 'utf8').trim().split('\n');
    expect(raw).toHaveLength(2);
  });

  it('文件不存在 / 坏行 → 不炸（坏行跳过）', () => {
    expect(readEvents(uid)).toEqual([]);
    fs.mkdirSync(require('node:path').dirname(userTranscriptMetricsFile(uid)), { recursive: true });
    fs.writeFileSync(userTranscriptMetricsFile(uid), 'not json\n{"kind":"retention","retention":0.6}\n', 'utf8');
    const events = readEvents(uid);
    expect(events).toHaveLength(1);
  });

  it('ms 为 0 不记录（避免用 0 拉低中位数）', () => {
    recordConfirmLatency(uid, { ms: 0, docId: 'doc', rows: 1, accepted: 1 });
    expect(readEvents(uid)).toEqual([]);
  });
});

describe('汇总口径（方案 §8.2）', () => {
  it('确认耗时达标判定按中位数', () => {
    recordConfirmLatency(uid, { ms: 4000, docId: 'a', rows: 3, accepted: 3 });
    recordConfirmLatency(uid, { ms: 8000, docId: 'b', rows: 4, accepted: 4 });
    recordConfirmLatency(uid, { ms: 60_000, docId: 'c', rows: 30, accepted: 20 });
    const summary = summarizeMetrics(readEvents(uid), 25);
    expect(summary.confirmLatency.median).toBe(8000);
    expect(summary.confirmLatency.withinTarget).toBe(true);
    expect(summary.confirmLatency.targetMs).toBe(CONFIRM_LATENCY_TARGET_MS);
  });

  it('保留率分档：低于 55% / 区间内 / 高于 85%', () => {
    recordRetention(uid, { retention: 0.4, charsIn: 100, charsOut: 40, overRewrite: true, docId: 'a' });
    recordRetention(uid, { retention: 0.79, charsIn: 100, charsOut: 79, overRewrite: false, docId: 'b' });
    recordRetention(uid, { retention: 0.95, charsIn: 100, charsOut: 95, overRewrite: false, docId: 'c' });
    const summary = summarizeMetrics(readEvents(uid), 40);
    expect(summary.retention).toMatchObject({ belowRange: 1, inRange: 1, aboveRange: 1, samples: 3 });
    expect(summary.glossary).toMatchObject({ entries: 40, reached: true });
  });

  it('测不了的指标如实列出（不编"认知损耗"这种假数字）', () => {
    const summary = summarizeMetrics([], 3);
    expect(summary.confirmLatency.median).toBeNull();
    expect(summary.confirmLatency.withinTarget).toBeNull();
    expect(summary.glossary.reached).toBe(false);
    expect(summary.notMeasurable.join('')).toContain('来回改错词次数');
  });
});
