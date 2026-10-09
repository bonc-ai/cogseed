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

import { kbQuizHint, kbQuizSnippet, parseHintJson, collectQuizSources, HINT_SYSTEM_PROMPT, QUIZ_SYSTEM_PROMPT, HINT_LLM_TIMEOUT_MS, _internals } from '../../../src/main/features/kb_quiz';
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

describe('原文片段要能当 needle 用（「原文依据」高亮）', () => {
  it('清掉 `## 路径` 头与合成标题前缀，留下逐字正文', () => {
    const { quizQuoteText } = _internals;
    // sampleDocLines 用 withTitle 拼出来的形状：## 路径 + 标题：正文
    expect(quizQuoteText('## 9.16产物/报告.md\n权限模型：管理员分两类角色，访客只读。'))
      .toBe('管理员分两类角色，访客只读。');
    // 真句子自带冒号：砍掉的也是原文前缀，剩余照样逐字（不损失可定位性）
    expect(quizQuoteText('发版清理：以 CSV 文件为准')).toBe('以 CSV 文件为准');
    // 没有合成前缀的原样保留
    expect(quizQuoteText('正文第一句。正文第二句。')).toBe('正文第一句。正文第二句。');
    // 长前缀不砍：超过 40 字的头是句子，不是块标题
    const long = `${'长'.repeat(45)}：后面是正文`;
    expect(quizQuoteText(long)).toBe(long);
  });

  it('kbQuizSnippet 返回的片段直接可定位（不再带标题／路径前缀）', () => {
    collectMock.mockReturnValue(['## 9.16产物/报告.md\n权限模型：管理员分两类角色，访客只读。\n\n发版规范：清理以 CSV 为准。']);
    const res = kbQuizSnippet('u1', { question: '管理员分几类角色？', source: '报告.md' });
    expect(res.ok).toBe(true);
    expect(res.snippet).toBe('管理员分两类角色，访客只读。');
    // needle 的首词必须在片段开头：主进程三级匹配的兜底就是从首词开始
    expect(res.snippet.startsWith('管理员')).toBe(true);
  });
});

describe('定位到"哪一段"要准（真机反馈：文档对，段落不对）', () => {
  const { pickSnippet } = _internals;

  it('答案原文命中的那一段胜出，而不是"题干词命中更多"的废话段', () => {
    const noise = '发版清理时需要注意很多事项，清理流程、清理范围、清理时间都要提前确认，具体以团队约定为准，建议参考过往经验并做好记录。';
    const evidence = '发版清理必须以 CSV 文件为准。';
    const picked = pickSnippet([noise, evidence], '发版清理应以什么为准？', { answer: 'CSV 文件' });
    expect(picked?.snippet).toBe(evidence);
    expect(picked?.line).toBe(1);
  });

  it('返回句级窗口：命中句在窗口里，且从整段第一句之前不截断（不再只给段落前 320 字）', () => {
    const para = `铺垫第一句与本题无关。铺垫第二句同样无关。${'铺垫'.repeat(200)}。真正的依据在这里：清理以 CSV 为准。结尾无关的一句。`;
    const picked = pickSnippet([para], '发版清理以什么为准？', { answer: 'CSV 文件' });
    expect(picked).toBeTruthy();
    // 命中句必须落在窗口里，且窗口不能是从段落开头切的一大块
    expect(picked!.snippet).toContain('清理以 CSV 为准');
    expect(picked!.snippet.length).toBeLessThan(para.length / 2);
    expect(picked!.snippet.startsWith('铺垫第一句')).toBe(false);
    // 句界对齐：窗口以句号收尾（逐字取原文，不切半句）
    expect(picked!.snippet.endsWith('。')).toBe(true);
  });

  it('IDF：每段都有的词不做区分，只在少数段出现的词才算证据', () => {
    const common = '文档说明：这份材料围绕发版流程展开，包含若干注意事项与经验总结，供团队参考使用。';
    const rare = '发版清理必须以 CSV 文件为准，提示词里那份只是速览。';
    const other = '文档说明：这份材料围绕测试用例展开，包含若干注意事项与经验总结，供团队参考使用。';
    const picked = pickSnippet([common, other, rare], '发版清理以什么为准？');
    expect(picked?.line).toBe(2);
    expect(picked?.snippet).toContain('CSV');
  });

  it('问句虚词不参与检索：只有"什么/哪些/如何"这种题不硬凑一段出来', () => {
    const { queryTerms } = _internals;
    const terms = queryTerms('以下说法哪个正确？');
    expect(terms).not.toContain('什么');
    expect(terms).not.toContain('以下');
    expect(terms).not.toContain('哪个');
    // 题干全是虚词 → 选不出来就如实返回 null，不乱给一段
    expect(pickSnippet(['一段与题目无关的材料。'], '以下哪个正确？')).toBeNull();
  });

  it('答案进检索：kbQuizSnippet 用 answer 选段（拿到 answer 才可能选对）', () => {
    collectMock.mockReturnValue([
      '## CICD/发版规范.md\n发布流程：每周二冻结 develop 分支，由发版负责人确认版本号。\n\n发版清理：提示词里的清单只是速览，必须以 CSV 文件为准。',
    ]);
    const res = kbQuizSnippet('u1', { question: '发版清理以什么为准？', answer: 'CSV 文件', source: '发版规范.md' });
    expect(res.ok).toBe(true);
    expect(res.snippet).toContain('CSV');
  });
});

describe('解析（explain）必须落到材料事实', () => {
  it('prompt 明确禁止空话，并要求写出支撑答案的事实／原话', () => {
    expect(QUIZ_SYSTEM_PROMPT).toContain('必须落到材料的具体事实');
    expect(QUIZ_SYSTEM_PROMPT).toContain('根据材料可知');
    expect(QUIZ_SYSTEM_PROMPT).toContain('这符合题意');
    expect(QUIZ_SYSTEM_PROMPT).toContain('禁止');
    // 来源不得编造
    expect(QUIZ_SYSTEM_PROMPT).toContain('不要编造');
  });
});
