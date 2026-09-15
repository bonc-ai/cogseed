/**
 * transcript_speaker_merge — 同人连续发言合并（方案 v0.2 §五 P1-2，效果④）
 *
 * 守的不变量：
 *   1. 合并只能通过"编辑集"表达（删冗余块头 + 插时间区间），不得引入第二套改写；
 *   2. 正文一个字都不能动（句子级改写是方案明令不做的）；
 *   3. 认不出格式就整份不动——宁可少做，不能猜坏；
 *   4. 时间锚点必须能从原文回查（§4.2）。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { applyCorrections, type CorrectionCandidate } from '../../../src/main/features/transcript_auto_correct';
import {
  mergeSpeakerEdits,
  parseHeaderLine,
  parseTranscriptBlocks,
  previewMergedHeader,
} from '../../../src/main/features/transcript_speaker_merge';

const SAMPLE = [
  'Richard 2026-09-05 19:31:32 ',
  'Hello.  ',
  'Richard 2026-09-05 19:31:34 ',
  '能听到吗？ ',
  '张浩 2026-09-05 19:31:36 ',
  '哈喽。 ',
  '张浩 2026-09-05 19:31:40 ',
  '我这边可以。 ',
  'Richard 2026-09-05 19:31:45 ',
  '那我们开始。 ',
].join('\n');

describe('块头解析（格式尽量宽）', () => {
  it('名字 + 日期 + 时间', () => {
    expect(parseHeaderLine('Richard 2026-09-05 19:31:32 ')).toEqual({
      speaker: 'Richard', at: '2026-09-05 19:31:32', clock: '19:31:32',
    });
  });

  it('名字｜时间 与 名字 时间', () => {
    expect(parseHeaderLine('张浩｜19:31:54')?.speaker).toBe('张浩');
    expect(parseHeaderLine('张浩 19:31:54')?.speaker).toBe('张浩');
  });

  it('正文行不会被误判成块头', () => {
    expect(parseHeaderLine('那我们开始。')).toBeNull();
    expect(parseHeaderLine('Hello.  ')).toBeNull();
    expect(parseHeaderLine('')).toBeNull();
  });
});

describe('块切分', () => {
  it('块头与正文范围首尾相接，正文逐字不丢', () => {
    const blocks = parseTranscriptBlocks(SAMPLE);
    expect(blocks).toHaveLength(5);
    expect(SAMPLE.slice(blocks[0].headerStart, blocks[0].headerEnd)).toBe('Richard 2026-09-05 19:31:32 ');
    expect(SAMPLE.slice(blocks[0].bodyStart, blocks[0].bodyEnd).trim()).toBe('Hello.');
    expect(blocks[1].speaker).toBe('Richard');
    expect(blocks[2].speaker).toBe('张浩');
  });
});

describe('合并编辑集', () => {
  it('同人连续段：保留首个块头 + 插结束时间 + 删后续块头', () => {
    const result = mergeSpeakerEdits(SAMPLE);
    expect(result.blocksBefore).toBe(5);
    expect(result.blocksAfter).toBe(3);
    expect(result.speakers).toEqual(['Richard', '张浩']);
    // Richard 段（第 1-2 块）：插 —19:31:34，删第 2 个块头
    expect(result.edits[0]).toMatchObject({
      action: 'replace', correct: '—19:31:34', reason: 'insert_time_range',
    });
    expect(result.edits[1]).toMatchObject({ action: 'delete', reason: 'merge_header' });
    expect(result.edits[1].wrong).toContain('Richard 2026-09-05 19:31:34');
    // 张浩段同理
    expect(result.edits[2]).toMatchObject({ action: 'replace', correct: '—19:31:40' });
    expect(result.edits[3]).toMatchObject({ action: 'delete' });
  });

  it('重复发言不产生编辑（已经是一个块）', () => {
    const once = 'Richard 2026-09-05 19:31:32 \nHello.\n';
    const result = mergeSpeakerEdits(once);
    expect(result.edits).toEqual([]);
    expect(result.blocksAfter).toBe(1);
  });

  it('不支持/无时间戳的文本整份不动（宁可少做，不能猜坏）', () => {
    const plain = '这是一段没有发言人和时间戳的正文。\n第二行。\n';
    const result = mergeSpeakerEdits(plain);
    expect(result.edits).toEqual([]);
    expect(result.blocksBefore).toBe(0);
    expect(result.blocksAfter).toBe(0);
  });

  it('时间锚点覆盖原文范围，可回查（§4.2）', () => {
    const result = mergeSpeakerEdits(SAMPLE);
    expect(result.anchors).toHaveLength(3);
    expect(result.anchors[0]).toMatchObject({ speaker: 'Richard', at: '2026-09-05 19:31:32', endAt: '2026-09-05 19:31:34' });
    const span = result.anchors[0].sourceSpan;
    expect(SAMPLE.slice(span.start, span.end)).toContain('Hello.');
    expect(SAMPLE.slice(span.start, span.end)).toContain('能听到吗？');
  });

  it('预览块头是 `名字 日期 起—止`', () => {
    const [first] = mergeSpeakerEdits(SAMPLE).anchors;
    expect(previewMergedHeader(first)).toBe('Richard 2026-09-05 19:31:32—19:31:34');
  });
});

describe('真实验收稿上的效果（方案 §8.1-4）', () => {
  const file = '/Users/cx/Desktop/文字转写/文字转写_教育智能体演示汇报_221240800.txt';
  const exists = fs.existsSync(file);

  it.skipIf(!exists)('477 个发言槽合并到 ~122 块（Richard 手工版 126）', () => {
    const text = fs.readFileSync(file, 'utf8');
    const result = mergeSpeakerEdits(text);
    expect(result.blocksBefore).toBe(477);
    expect(result.blocksAfter).toBeLessThan(150);
    expect(result.blocksAfter).toBeGreaterThan(100);
    expect(result.speakers.length).toBeGreaterThanOrEqual(5);
    // 每个被删的都是块头、每个插入的都是时间区间
    for (const edit of result.edits) {
      if (edit.action === 'delete') expect(edit.wrong).toMatch(/\d{2}:\d{2}:\d{2}/);
      else expect(edit.correct).toMatch(/^—\d{2}:\d{2}:\d{2}$/);
    }
  });
});

describe('结构编辑与口癖统计要分得清', () => {
  it('合并块头的删除不进 deletedFillers（否则统计里全是块头文本）', () => {
    const text = 'A 2026-09-05 19:31:32 \n你好。\nA 2026-09-05 19:31:35 \n再见。\n';
    const result = mergeSpeakerEdits(text);
    const candidates: CorrectionCandidate[] = result.edits.map((edit, index) => ({
      entryRef: `merge_${index}`, wrong: edit.wrong, correct: edit.correct, action: edit.action,
      confidence: 1, riskLevel: 'low', context: '', span: edit.span, ignoredCount: 0,
      contextAllow: [], structure: true,
    }));
    const applied = applyCorrections(text, candidates, {
      acceptedIds: candidates.map((c) => c.entryRef),
    });
    expect(Object.keys(applied.deletedFillers)).toEqual([]);
    expect(applied.applied.some((a) => a.action === 'delete')).toBe(true);
    expect(applied.text).toContain('—19:31:35');
  });
});
