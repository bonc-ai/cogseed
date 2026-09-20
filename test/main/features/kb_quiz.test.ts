/**
 * kb_quiz (知识库测验题，本地生成) —— 「生成测验」背后的真实现。
 *
 * 背景：这个入口此前从未实现（渲染层只留了一个 `_renderQuiz` 调用点，点击直接
 * ReferenceError），且被"先生成 AI 解析"挡着。这里用 mocks 覆盖：解析/校验、
 * 答案归一、缓存、single-flight、以及 empty/timeout/model-failed/unparsable 四条降级。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/main/features/kb_summary', () => ({
  collectReadyDocLines: vi.fn(() => []),
}));

import { kbQuiz, parseQuizJson, resolveAnswer, _internals } from '../../../src/main/features/kb_quiz';
import { collectReadyDocLines } from '../../../src/main/features/kb_summary';

const collectMock = vi.mocked(collectReadyDocLines);

const SAMPLE = JSON.stringify({
  questions: [
    {
      type: 'single',
      question: 'AST-Surgery 的核心约束是什么？',
      options: ['语法树结构约束', '逐字符替换', '随机采样', '人工规则库'],
      answer: 'A',
      explain: '它把修复限制在语法树允许的结构内。',
      source: 'AST.pdf',
    },
    {
      type: 'short',
      question: '为什么要把纠错放在检索之前？',
      options: [],
      answer: '因为错词会让检索命中不到正确写法。',
      explain: '错形与正确写法向量距离远。',
      source: '计划.md',
    },
  ],
});

beforeEach(() => {
  collectMock.mockReset();
  _internals.clearCacheForTests();
});

describe('parseQuizJson / resolveAnswer', () => {
  it('容忍代码块包裹，并保持题目顺序', () => {
    const qs = parseQuizJson('```json\n' + SAMPLE + '\n```');
    expect(qs).toHaveLength(2);
    expect(qs[0].id).toBe(1);
    expect(qs[1].id).toBe(2);
    expect(qs[0].type).toBe('single');
    expect(qs[1].type).toBe('short');
  });

  it('字母答案归一到选项原文；"B. 选项"这类前缀也能命中', () => {
    const opts = ['甲', '乙', '丙', '丁'];
    expect(resolveAnswer('B', opts)).toBe('乙');
    expect(resolveAnswer('（c）', opts)).toBe('丙');
    expect(resolveAnswer('B. 乙', opts)).toBe('乙');
    // 已是选项原文 / 简答参考答案：原样返回
    expect(resolveAnswer('丁', opts)).toBe('丁');
    expect(resolveAnswer('参考：先纠错再检索', [])).toBe('参考：先纠错再检索');
  });

  it('丢弃坏题：没题干、简答没答案的都不进来', () => {
    const qs = parseQuizJson(JSON.stringify({
      questions: [
        { question: '', options: ['a', 'b'], answer: 'a' },
        { type: 'short', question: '简答题没有参考答案', options: [], answer: '' },
        { type: 'single', question: '正常题', options: ['x', 'y'], answer: 'x' },
        'not-an-object',
      ],
    }));
    expect(qs).toHaveLength(1);
    expect(qs[0].question).toBe('正常题');
  });

  it('题量按上限截断，且题号重排（模型给的序号不可信）', () => {
    const list = { questions: Array.from({ length: 12 }, (_, i) => ({
      type: 'single', question: `题 ${i}`, options: ['a', 'b'], answer: 'a', id: 999,
    })) };
    const qs = parseQuizJson(JSON.stringify(list), { maxQuestions: 5 });
    expect(qs).toHaveLength(5);
    expect(qs.map((q) => q.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('非 JSON / 空文本返回空数组（调用方据此降级）', () => {
    expect(parseQuizJson('模型今天不想出题')).toEqual([]);
    expect(parseQuizJson('')).toEqual([]);
  });

  it('选项只有 1 个时按简答题处理（没有选择题该有的干扰项）', () => {
    const qs = parseQuizJson(JSON.stringify({
      questions: [{ type: 'single', question: '只有一个选项', options: ['唯一'], answer: '唯一' }],
    }));
    expect(qs).toHaveLength(1);
    expect(qs[0].type).toBe('short');
    expect(qs[0].options).toEqual([]);
    expect(qs[0].answer).toBe('唯一');
  });
});

describe('kbQuiz', () => {
  it('基于库内文档要点生成题目，并回填 source', async () => {
    collectMock.mockReturnValue(['## AST.pdf\n要点……']);
    const complete = vi.fn(async () => ({ ok: true, text: SAMPLE, error: '' }));
    const res = await kbQuiz('u1', { dir: 'lib' }, { complete });
    expect(res.source).toBe('generated');
    expect(res.questions).toHaveLength(2);
    expect(res.questions[0].answer).toBe('语法树结构约束');
    expect(res.questions[0].source).toBe('AST.pdf');
    expect(complete).toHaveBeenCalledOnce();
  });

  it('提供 text 时基于该文本出题（不读库）', async () => {
    const complete = vi.fn(async () => ({ ok: true, text: SAMPLE, error: '' }));
    const res = await kbQuiz('u1', { text: '这是一条问答回答' }, { complete });
    expect(res.source).toBe('generated');
    expect(collectMock).not.toHaveBeenCalled();
  });

  it('同指纹命中缓存：第二次不再调模型（force 可强刷）', async () => {
    collectMock.mockReturnValue(['## AST.pdf\n要点……']);
    const complete = vi.fn(async () => ({ ok: true, text: SAMPLE, error: '' }));
    await kbQuiz('u1', { dir: 'lib' }, { complete });
    const second = await kbQuiz('u1', { dir: 'lib' }, { complete });
    expect(second.source).toBe('cached');
    expect(complete).toHaveBeenCalledOnce();
    await kbQuiz('u1', { dir: 'lib', force: true }, { complete });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('题量进指纹：3 题与 5 题各算一份缓存', async () => {
    collectMock.mockReturnValue(['## AST.pdf\n要点……']);
    const complete = vi.fn(async () => ({ ok: true, text: SAMPLE, error: '' }));
    await kbQuiz('u1', { dir: 'lib', count: 3 }, { complete });
    await kbQuiz('u1', { dir: 'lib', count: 5 }, { complete });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('并发同指纹只发起一次模型调用（single-flight）', async () => {
    collectMock.mockReturnValue(['## AST.pdf\n要点……']);
    let resolveCompletion: (v: any) => void = () => {};
    const complete = vi.fn(() => new Promise((resolve) => { resolveCompletion = resolve; }));
    const a = kbQuiz('u1', { dir: 'lib' }, { complete });
    const b = kbQuiz('u1', { dir: 'lib' }, { complete });
    resolveCompletion({ ok: true, text: SAMPLE, error: '' });
    const [ra, rb] = await Promise.all([a, b]);
    expect(complete).toHaveBeenCalledOnce();
    expect(ra.questions.length).toBe(2);
    expect(rb.questions.length).toBe(2);
  });

  it('库内没有 ready 文档 → degraded/empty，不调模型', async () => {
    collectMock.mockReturnValue([]);
    const complete = vi.fn(async () => ({ ok: true, text: SAMPLE, error: '' }));
    const res = await kbQuiz('u1', { dir: 'lib' }, { complete });
    expect(res.source).toBe('degraded');
    expect(res.reason).toBe('empty');
    expect(res.questions).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('模型失败 → degraded/model-failed', async () => {
    collectMock.mockReturnValue(['## AST.pdf\n要点……']);
    const res = await kbQuiz('u1', { dir: 'lib' }, { complete: async () => ({ ok: false, text: '', error: 'provider down' }) });
    expect(res.source).toBe('degraded');
    expect(res.reason).toBe('model-failed');
  });

  it('模型返回的不是题目 → degraded/unparsable（不缓存坏结果）', async () => {
    collectMock.mockReturnValue(['## AST.pdf\n要点……']);
    const res = await kbQuiz('u1', { dir: 'lib' }, { complete: async () => ({ ok: true, text: '抱歉，我无法出题。', error: '' }) });
    expect(res.source).toBe('degraded');
    expect(res.reason).toBe('unparsable');
    expect(res.questions).toEqual([]);
  });

  it('超时 → degraded/timeout，且迟到结果落缓存（重试秒出）', async () => {
    vi.useFakeTimers();
    try {
      collectMock.mockReturnValue(['## AST.pdf\n要点……']);
      let resolveCompletion: (v: any) => void = () => {};
      const complete = vi.fn(() => new Promise((resolve) => { resolveCompletion = resolve; }));
      const pending = kbQuiz('u1', { dir: 'lib' }, { complete });
      await vi.advanceTimersByTimeAsync(180 * 1000 + 10);
      const res = await pending;
      expect(res.source).toBe('degraded');
      expect(res.reason).toBe('timeout');
      // 底层请求此时才返回：迟到兜底把结果写进缓存
      resolveCompletion({ ok: true, text: SAMPLE, error: '' });
      await vi.advanceTimersByTimeAsync(0);
      const retry = await kbQuiz('u1', { dir: 'lib' }, { complete });
      expect(retry.source).toBe('cached');
      expect(retry.questions).toHaveLength(2);
      expect(complete).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
