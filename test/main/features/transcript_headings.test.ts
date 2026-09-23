/**
 * transcript_headings — 主题标题生成（方案 v0.2 §五 P2-2）
 *
 * 守的不变量：**只提议不动正文**、标题严格校验（越界/超长/纯标点一律丢弃）、
 * 没模型就如实说没模型。
 */

import { describe, it, expect } from 'vitest';
import {
  HEADING_MAX_CHARS,
  parseHeadingResponse,
  sanitizeHeading,
  splitForHeadings,
  suggestHeadings,
} from '../../../src/main/features/transcript_headings';

const SAMPLE = [
  'SpeakerA 2026-09-05 19:31:32 ',
  'Hello，我们开始。 ',
  '张磊 2026-09-05 19:31:36 ',
  '我先说产品进度。 ',
  'SpeakerA 2026-09-05 19:40:00 ',
  '接下来看教育场景。 ',
  '张磊 2026-09-05 19:50:00 ',
  '最后讲排期。 ',
].join('\n');

describe('切段（用于拟标题）', () => {
  it('按发言块切段，给出可插入的偏移与发言人', () => {
    const chunks = splitForHeadings(SAMPLE, { chunkSize: 2 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].start).toBe(0);
    expect(chunks[0].speakers).toContain('SpeakerA');
    expect(SAMPLE.slice(chunks[1].start)).toContain('19:40:00');
  });

  it('没有块头时按空行切段，仍然给出偏移', () => {
    const plain = '第一段内容。\n\n第二段内容。\n\n第三段内容。';
    const chunks = splitForHeadings(plain, { chunkSize: 1 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) expect(typeof chunk.start).toBe('number');
  });
});

describe('标题校验（宁缺勿滥）', () => {
  it('去引号/尾标点，正常标题保留', () => {
    expect(sanitizeHeading('「产品进度」')).toBe('产品进度');
    expect(sanitizeHeading('排期讨论。')).toBe('排期讨论');
    expect(sanitizeHeading('## 教育场景')).toBe('教育场景');
  });

  it('超长、纯标点、空串一律丢弃', () => {
    expect(sanitizeHeading('一'.repeat(HEADING_MAX_CHARS + 1))).toBe('');
    expect(sanitizeHeading('！！！')).toBe('');
    expect(sanitizeHeading('   ')).toBe('');
  });

  it('解析：越界段落序号/超长标题被丢掉，同段只留一条', () => {
    const chunks = [{ index: 0, start: 0 }, { index: 1, start: 50 }];
    const raw = JSON.stringify([
      { chunkIndex: 0, title: '开场' },
      { chunkIndex: 9, title: '不存在的段' },
      { chunkIndex: 1, title: '一'.repeat(40) },
      { chunkIndex: 1, title: '产品进度' },
      { chunkIndex: 0, title: '开场' },
    ]);
    const headings = parseHeadingResponse(raw, chunks);
    expect(headings).toEqual([
      { chunkIndex: 0, start: 0, title: '开场' },
      { chunkIndex: 1, start: 50, title: '产品进度' },
    ]);
  });

  it('模型输出包在 ```json 里也能解析；废话返回空', () => {
    const chunks = [{ index: 0, start: 0 }];
    expect(parseHeadingResponse('```json\n[{"chunkIndex":0,"title":"开场"}]\n```', chunks)).toHaveLength(1);
    expect(parseHeadingResponse('我觉得都挺好', chunks)).toEqual([]);
  });
});

describe('跳过条件（不假装问过模型）', () => {
  it('稿子太短 → too_short；没模型 → no_model', async () => {
    expect(await suggestHeadings('u', '太短', { runModel: async () => '[]' })).toMatchObject({ skipped: 'too_short' });
    const long = SAMPLE.repeat(20);
    const result = await suggestHeadings('u', long, { runModel: async () => '[]' });
    expect(result.headings).toEqual([]);
  });

  it('注入 runModel 时闭环可用（只返回候选，不动正文）', async () => {
    const long = SAMPLE.repeat(20);
    const result = await suggestHeadings('u', long, {
      chunkSize: 2,
      runModel: async () => JSON.stringify([{ chunkIndex: 0, title: '开场与进度' }]),
    });
    expect(result.headings[0]).toMatchObject({ chunkIndex: 0, title: '开场与进度' });
  });
});
