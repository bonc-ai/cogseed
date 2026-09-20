import { describe, it, expect } from 'vitest';
import {
  buildReviewRequest,
  generateReviewCandidates,
  parseReviewResponse,
  splitForReview,
  LLM_CANDIDATE_MIN_CONFIDENCE,
  REVIEW_CHUNK_CHARS,
  REVIEW_MAX_PER_CHUNK,
} from '../../../src/main/features/transcript_llm_candidates';

// 一份真实形态的中文会议转写：错写是小写英文/同音字，不是 CamelCase
const TRANSCRIPT = [
  '嗯然后我们这个季度的 roadmap 还没有对齐，傅平老师说下周要过一遍。',
  'coxyx 那边负责 tools 的部分，plugins 也要一起看。',
  '这块是 SpeakerA 在跟，他提过 KSTAR 的事情。',
].join('\n');

const known = ['SpeakerA', 'Cogseed', 'KSTAR'];

describe('读正文提候选：不再靠词形准入', () => {
  it('中文稿 + 小写英文错写照样能提到候选（旧判据下这是 0 条）', async () => {
    let asked = 0;
    const result = await generateReviewCandidates('u', TRANSCRIPT, {
      knownTargets: known,
      runModel: async () => {
        asked += 1;
        return JSON.stringify([
          { wrong: 'roadmap', correct: 'Roadmap Plan', confidence: 0.82, reason: '上下文在讲排期' },
          { wrong: 'coxyx', correct: 'Cogseed', confidence: 0.95, reason: '读音接近' },
        ]);
      },
    });
    expect(asked).toBe(1);
    expect(result.candidates.map((c) => [c.wrong, c.correct])).toEqual([
      ['coxyx', 'Cogseed'],
      ['roadmap', 'Roadmap Plan'],
    ]);
    // 位置必须是原文绝对坐标，且能对回原文
    for (const c of result.candidates) {
      expect(TRANSCRIPT.slice(c.start, c.start + c.wrong.length)).toBe(c.wrong);
    }
    expect(result.candidates.find((c) => c.wrong === 'coxyx')?.inAllowlist).toBe(true);
    expect(result.candidates.find((c) => c.wrong === 'roadmap')?.inAllowlist).toBe(false);
    expect(result.outsideAllowlist).toBe(1);
    expect(result.skipped).toBeUndefined();
    expect(result.chunksScanned).toBe(1);
    expect(result.chunksTotal).toBe(1);
  });

  it('落点用折叠串定位：模型回的大小写/全角与正文不一致也能标到正确位置', () => {
    const chunk = '这里写着 ＣＯＸＹ 和 coxy，两处都像错写。';
    const { candidates } = parseReviewResponse(
      JSON.stringify([
        { wrong: 'coxy', correct: 'Cogseed', confidence: 0.9, reason: 'r' },
      ]),
      chunk,
      1000,
      ['Cogseed'],
    );
    // 全角 ＣＯＸＹ（折叠后=coxy）+ 小写 coxy 两处都要标到
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.start).sort((a, b) => a - b)).toEqual([1000 + 5, 1000 + 12]);
    for (const c of candidates) {
      // wrong 用正文原文（而不是模型回的字符串），保证 span 与 text 对齐
      expect(chunk.slice(c.start - 1000, c.start - 1000 + c.wrong.length)).toBe(c.wrong);
    }
  });

  it('正文里定位不到的（模型幻觉/改写过的片段）整条丢弃，并如实记账', () => {
    const { candidates, rejected } = parseReviewResponse(
      JSON.stringify([
        { wrong: '正文里没有这句话', correct: 'X', confidence: 0.9, reason: '' },
        { wrong: '一样', correct: '一样', confidence: 0.9, reason: '' },
      ]),
      '正文里只有这一句。一样',
      0,
      [],
    );
    expect(candidates).toEqual([]);
    expect(rejected.map((r) => r.why)).toEqual(['not_in_text', 'identical_pair']);
  });

  it('模型回的片段两头带空格时，span 按正文实际长度算（不按模型字符串长度）', () => {
    const chunk = '这块是 coxyx 在跟';
    const { candidates } = parseReviewResponse(
      JSON.stringify([{ wrong: '  coxyx ', correct: 'Cogseed', confidence: 0.9, reason: 'r' }]),
      chunk,
      0,
      ['Cogseed'],
    );
    expect(candidates).toHaveLength(1);
    // 必须精确等于 coxyx（5 字符），不能因为模型带了空格而多切两个字符
    expect(candidates[0].wrong).toBe('coxyx');
    expect(chunk.slice(candidates[0].start, candidates[0].start + candidates[0].wrong.length)).toBe('coxyx');
  });

  it('名单外的写法保留并标注（静默丢弃会让"模型说了什么"不可观测）', () => {
    const chunk = '这块是 coxyx 在跟';
    const { candidates } = parseReviewResponse(
      JSON.stringify([{ wrong: 'coxyx', correct: '某个新词', confidence: 0.9, reason: 'r' }]),
      chunk,
      0,
      ['Cogseed'],
    );
    expect(candidates[0]).toMatchObject({ correct: '某个新词', inAllowlist: false });
  });

  it('同一段同一位置同一目标只留一条，且每段有条数上限', () => {
    const chunk = 'coxyx '.repeat(REVIEW_MAX_PER_CHUNK + 10);
    const { candidates } = parseReviewResponse(
      JSON.stringify([{ wrong: 'coxyx', correct: 'Cogseed', confidence: 0.9, reason: 'r' }]),
      chunk,
      0,
      ['Cogseed'],
    );
    expect(candidates.length).toBeLessThanOrEqual(REVIEW_MAX_PER_CHUNK);
    expect(new Set(candidates.map((c) => c.start)).size).toBe(candidates.length);
  });

  it('低置信标 pending（只能进待确认，不允许自动替换）', () => {
    const { candidates } = parseReviewResponse(
      JSON.stringify([
        { wrong: 'roadmap', correct: 'A', confidence: 0.3, reason: '' },
        { wrong: 'coxyx', correct: 'Cogseed', confidence: 0.95, reason: '' },
      ]),
      TRANSCRIPT,
      0,
      known,
    );
    expect(candidates.find((c) => c.wrong === 'coxyx')?.pending).toBe(false);
    expect(candidates.find((c) => c.wrong === 'roadmap')?.pending).toBe(true);
    expect(LLM_CANDIDATE_MIN_CONFIDENCE).toBeGreaterThan(0.3);
  });

  it('模型输出被包在 ```json / 夹带解释也能解析；纯废话返回空', () => {
    const wrapped = '```json\n[{"wrong":"coxyx","correct":"Cogseed","confidence":0.8,"reason":"x"}]\n```';
    expect(parseReviewResponse(wrapped, TRANSCRIPT, 0, known).candidates).toHaveLength(1);
    expect(parseReviewResponse('我不知道', TRANSCRIPT, 0, known).candidates).toEqual([]);
    expect(parseReviewResponse('[不是合法 json', TRANSCRIPT, 0, known).candidates).toEqual([]);
  });
});

describe('分段与成本上界', () => {
  it('按上限切段，并如实回报 truncated（不假装全看过）', async () => {
    const long = 'roadmap 在这里。'.repeat(3000); // 3 万字 → 10 段，超过 8 段上限
    const { chunks, totalChunks, truncated } = splitForReview(long);
    expect(chunks).toHaveLength(8);
    expect(totalChunks).toBeGreaterThan(8);
    expect(truncated).toBe(true);
    expect(chunks.reduce((n, c) => n + c.text.length, 0)).toBeLessThan(long.length);

    const result = await generateReviewCandidates('u', long, {
      runModel: async () => '[]',
    });
    expect(result.truncated).toBe(true);
    expect(result.chunksScanned).toBe(8);
    expect(result.chunksTotal).toBe(totalChunks);
  });

  it('分段边界落在换行/句末，不把一处错写劈成两半', () => {
    // 句末落在第 3000 字边界之前的窗口里 → 应该在这里断开，而不是硬切在第 3000 字
    const text = `${'a'.repeat(2800)}。\n${'b'.repeat(1000)}`;
    const { chunks } = splitForReview(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text.endsWith('。\n')).toBe(true);
    // 接缝处不漏字：两段拼起来等于原文
    expect(chunks.map((c) => c.text).join('')).toBe(text);
  });

  it('空正文不发请求', async () => {
    let asked = false;
    const result = await generateReviewCandidates('u', '   \n  ', {
      runModel: async () => { asked = true; return '[]'; },
    });
    expect(asked).toBe(false);
    expect(result.skipped).toBe('empty_text');
    expect(result.chunksTotal).toBe(0);
  });
});

describe('部分失败不拖垮其余段（诚实回报）', () => {
  it('一段失败、一段成功 → 返回成功的候选，并记 failedChunks', async () => {
    const text = `${'x'.repeat(REVIEW_CHUNK_CHARS)}\ncoxyx 在跟`;
    let call = 0;
    const result = await generateReviewCandidates('u', text, {
      knownTargets: known,
      runModel: async () => {
        call += 1;
        if (call === 1) throw new Error('boom');
        return JSON.stringify([{ wrong: 'coxyx', correct: 'Cogseed', confidence: 0.9, reason: 'r' }]);
      },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.failedChunks).toBe(1);
    expect(result.chunksScanned).toBe(1);
    expect(result.skipped).toBeUndefined();
  });

  it('所有段都失败 → 报 model_failed（不再和"模型说没有"混为一谈）', async () => {
    const result = await generateReviewCandidates('u', TRANSCRIPT, {
      runModel: async () => { throw new Error('boom'); },
    });
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toBe('model_failed');
    expect(result.failedChunks).toBe(result.chunksTotal);
  });
});

describe('请求构造', () => {
  it('提示词带上正文、已知写法与重点线索，并写明 wrong 必须逐字出现', () => {
    const request = buildReviewRequest('coxyx 在跟', known, [{ text: 'coxyx', start: 0 }]);
    expect(request.message).toContain('coxyx 在跟');
    expect(request.message).toContain('SpeakerA、Cogseed、KSTAR');
    expect(request.message).toContain('重点线索');
    expect(request.systemPrompt).toContain('逐字');
    // 提示词必须说清"产出只是候选"
    expect(request.systemPrompt).toContain('给人复核的候选');
  });

  it('没有已知写法也照常问（这正是最需要模型看一眼的情况）', () => {
    const request = buildReviewRequest('coxyx 在跟', [], []);
    expect(request.message).toContain('（无）');
    expect(request.allowed).toEqual([]);
  });

  it('保护区（代码块/URL）里的候选一律丢弃', async () => {
    const text = '看这个 https://example.com/roadmap 和 `roadmap` 还有 roadmap 本身。';
    const result = await generateReviewCandidates('u', text, {
      runModel: async () => JSON.stringify([
        { wrong: 'roadmap', correct: 'Roadmap Plan', confidence: 0.9, reason: 'r' },
      ]),
    });
    // 3 处 roadmap：URL 里、行内代码里被丢，只剩正文那一处
    expect(result.candidates).toHaveLength(1);
    expect(text.slice(result.candidates[0].start, result.candidates[0].start + 7)).toBe('roadmap');
    expect(result.candidates[0].start).toBe(text.lastIndexOf('roadmap'));
  });

  it('注入 runModel 时能跑通闭环（无模型配置也能测）', async () => {
    const result = await generateReviewCandidates('u', TRANSCRIPT, {
      knownTargets: known,
      runModel: async () => JSON.stringify([
        { wrong: 'SpeakerA', correct: 'SpeakerA', confidence: 0.9, reason: '自反应被丢' },
        { wrong: 'KSTAR', correct: 'KSTAR2', confidence: 0.5, reason: 'ok' },
      ]),
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ wrong: 'KSTAR', correct: 'KSTAR2', pending: true });
    expect(result.rejected.some((r) => r.why === 'identical_pair')).toBe(true);
  });
});
