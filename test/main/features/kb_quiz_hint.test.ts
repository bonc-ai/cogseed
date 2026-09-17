/**
 * kb_quiz 的「提示」与来源收集（Studio 测验面板用的两个能力）。
 *
 * 覆盖四件容易做错的事：
 *   1. 提示**只说线索、不说答案**——prompt 与解析两层都要守住（解析层丢弃没有
 *      hint 字段的输出，prompt 层明写禁止点选项/写答案）；
 *   2. 有来源文档时线索只用那一份（否则线索会串到别的材料上）；
 *   3. 材料没覆盖时如实报 covered=false，不编内容；
 *   4. 四条降级（empty / timeout / model-failed / unparsable）都要给原因。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/main/features/kb_summary', () => ({
  collectReadyDocLines: vi.fn(() => []),
}));

import { kbQuizHint, parseHintJson, collectQuizSources, HINT_SYSTEM_PROMPT, HINT_LLM_TIMEOUT_MS, _internals } from '../../../src/main/features/kb_quiz';
import { collectReadyDocLines } from '../../../src/main/features/kb_summary';

const collectMock = vi.mocked(collectReadyDocLines);

const ok = (text: string) => vi.fn(async () => ({ ok: true, text, error: '' }));
const fail = (error: string) => vi.fn(async () => ({ ok: false, text: '', error }));

beforeEach(() => {
  collectMock.mockReset();
  collectMock.mockReturnValue(['## 报告.md\n权限模型分两类角色：管理员与访客。']);
  _internals.clearCacheForTests();
});

describe('kb_quiz 提示（hint）', () => {
  it('prompt 明确禁止给答案，且要求覆盖不足时如实说明', () => {
    expect(HINT_SYSTEM_PROMPT).toContain('绝不能给出答案');
    expect(HINT_SYSTEM_PROMPT).toContain('不要点出哪个选项对');
    expect(HINT_SYSTEM_PROMPT).toContain('covered 写 false');
    expect(HINT_SYSTEM_PROMPT).toContain('不要编造');
  });

  it('解析容忍代码块与前后杂文，缺 hint 字段视为无效', () => {
    expect(parseHintJson('```json\n{"hint":"回到『权限模型』一节","covered":true}\n```')).toEqual({ hint: '回到『权限模型』一节', covered: true });
    expect(parseHintJson('说明文字 {"hint":"看第二节","covered":false} 结尾')).toEqual({ hint: '看第二节', covered: false });
    expect(parseHintJson('{"covered":true}')).toBeNull();
    expect(parseHintJson('完全不是 JSON')).toBeNull();
  });

  it('生成成功：返回线索与覆盖标记，并把题目/选项/材料要点一起交给模型', async () => {
    const complete = ok('{"hint":"回到『权限模型』一节","covered":true}');
    const res = await kbQuizHint('u1', {
      question: '管理员与访客的区别是什么？',
      options: ['管理员可写', '访客可写', '都一样', '都不行'],
      source: '报告.md',
      fingerprint: 'fp1',
      qid: 3,
    }, { complete });
    expect(res).toEqual({ hint: '回到『权限模型』一节', covered: true, source: 'generated' });
    const call = complete.mock.calls[0][0] as { message: string; systemPrompt: string; sessionId: string };
    expect(call.message).toContain('管理员与访客的区别是什么？');
    expect(call.message).toContain('A. 管理员可写');
    expect(call.message).toContain('权限模型分两类角色');
    expect(call.systemPrompt).toBe(HINT_SYSTEM_PROMPT);
    // 单发无状态会话：与出题同款，避免历史累积拖慢重试
    expect(call.sessionId).toContain('aside-kbquizhint-');
  });

  it('同指纹同题号第二次直接命中缓存（不再打模型）', async () => {
    const complete = ok('{"hint":"看第二节"}');
    const args = { question: 'Q', options: [], source: '', fingerprint: 'fp-cache', qid: 1 } as const;
    await kbQuizHint('u1', args, { complete });
    await kbQuizHint('u1', args, { complete });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('材料里找不到线索时如实返回 covered=false（不编）', async () => {
    const res = await kbQuizHint('u1', { question: 'Q', fingerprint: 'fp2', qid: 1 }, {
      complete: ok('{"hint":"这份材料里没有直接讲到这一点","covered":false}'),
    });
    expect(res.covered).toBe(false);
    expect(res.source).toBe('generated');
  });

  it('有来源文档时只送那一份（线索不串材料）', async () => {
    collectMock.mockReturnValue([
      '## 报告.md\n权限模型分两类角色。',
      '## 另一份.md\n讲的是排期与预算，与本题无关。',
    ]);
    const complete = ok('{"hint":"回到权限模型"}');
    await kbQuizHint('u1', { question: 'Q', source: '报告.md', fingerprint: 'fp3', qid: 1 }, { complete });
    const message = (complete.mock.calls[0][0] as { message: string }).message;
    expect(message).toContain('权限模型');
    expect(message).not.toContain('排期与预算');
  });

  it('三条降级路径都给原因：empty / model-failed / unparsable', async () => {
    collectMock.mockReturnValue([]);
    const empty = await kbQuizHint('u1', { question: 'Q' }, { complete: ok('{}') });
    expect(empty).toMatchObject({ hint: '', covered: false, source: 'degraded', reason: 'empty' });

    collectMock.mockReturnValue(['## a.md\n内容']);
    const unparsable = await kbQuizHint('u1', { question: 'Q', fingerprint: 'fp4', qid: 1 }, { complete: ok('不是 JSON') });
    expect(unparsable).toMatchObject({ covered: false, source: 'degraded', reason: 'unparsable' });

    const modelFailed = await kbQuizHint('u1', { question: 'Q', fingerprint: 'fp5', qid: 1 }, { complete: fail('provider down') });
    expect(modelFailed).toMatchObject({ source: 'degraded', reason: 'model-failed' });
  });

  it('超过 30s 预算按 timeout 降级（不无限等模型）', async () => {
    vi.useFakeTimers();
    try {
      const pending = kbQuizHint('u1', { question: 'Q', fingerprint: 'fp-timeout', qid: 1 }, {
        complete: vi.fn(() => new Promise<never>(() => { /* 永不返回 */ })),
      });
      await vi.advanceTimersByTimeAsync(HINT_LLM_TIMEOUT_MS + 10);
      await expect(pending).resolves.toMatchObject({ source: 'degraded', reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('题面为空直接返回 empty，不浪费一次模型调用', async () => {
    const complete = ok('{"hint":"x"}');
    const res = await kbQuizHint('u1', { question: '   ' }, { complete });
    expect(res).toMatchObject({ source: 'degraded', reason: 'empty' });
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('kb_quiz 来源收集', () => {
  it('按首次出现顺序去重，空来源丢弃', () => {
    expect(collectQuizSources([
      { id: 1, type: 'single', question: 'a', options: [], answer: 'x', explain: '', source: '报告.md' } as never,
      { id: 2, type: 'short', question: 'b', options: [], answer: 'y', explain: '' } as never,
      { id: 3, type: 'single', question: 'c', options: [], answer: 'z', explain: '', source: '报告.md' } as never,
      { id: 4, type: 'single', question: 'd', options: [], answer: 'w', explain: '', source: '计划.md' } as never,
    ])).toEqual(['报告.md', '计划.md']);
  });
});
