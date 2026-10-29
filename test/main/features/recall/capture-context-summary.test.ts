import { describe, expect, it } from 'vitest';
import { CaptureContextInterruptedError, captureContextSourceDigest, summarizeCaptureContext, validateCaptureContextSummary } from '../../../../src/main/features/recall/capture-context-summary';
import type { CaptureContextCheckpoint } from '../../../../src/main/features/recall/capture-context-summary';

function topic(messageId: string, quote: string, attribution = 'user_requirement', content = quote) {
  return { title: '具体话题', content, conditions: ['仅限项目甲'], unresolved: [], attribution, evidence: [{ messageId, quote }] };
}
function mockRun(inputs: any[] = []) {
  return async (json: string) => {
    const input = JSON.parse(json); inputs.push(input);
    if (input.stage === 'chunk') {
      const correction = input.segments.find((segment: any) => segment.text.includes('一直是中文'));
      const segment = correction ?? input.segments.find((segment: any) => segment.text.trim());
      return JSON.stringify({ coveredIds: input.segments.map((s: any) => s.id), topics: segment ? [topic(segment.messageId,
        correction ? '一直是中文' : segment.text.slice(0, 10), segment.role === 'assistant' ? 'assistant_proposal' : 'user_requirement',
        correction ? '之前英文说法记错，一直是中文' : '背景待结合后文')] : [] });
    }
    const topics = input.inputs.flatMap((node: any) => node.topics);
    return JSON.stringify({ coveredIds: input.inputs.map((node: any) => node.id), topics: topics.length ? [{ ...topics[0],
      id: undefined, content: topics.some((t: any) => t.content.includes('一直是中文')) ? '之前英文说法记错，一直是中文' : '背景待结合后文',
      evidence: topics.flatMap((t: any) => t.evidence), inputIds: topics.map((t: any) => t.id) }] : [] });
  };
}

describe('complete source context summaries', () => {
  it('accepts and discards a harmless local topic id from a real provider response', async () => {
    const text = '从2026年10月11日起，我有一个长期的表达偏好：回答我的复杂问题时，先直接说结论，再解释关键原因，避免开头先铺很长的背景。这是以后类似问题都适用的偏好，并不要求省略必要证据。';
    const response = { coveredIds: ['m0:0'], topics: [{ id: 't1', title: '用户长期表达偏好：复杂问题先结论后原因',
      content: '用户自2026年10月11日起声明一个长期表达偏好：回答复杂问题时，应先直接给出结论，再解释关键原因，避免开头先铺很长背景。该偏好适用于以后的类似问题，且不要求省略必要证据。',
      conditions: ['适用于2026年10月11日以后的类似复杂问题', '不要求省略必要证据'], unresolved: [], attribution: 'user_requirement',
      evidence: [{ messageId: 'synthetic-preference-day1', quote: '回答我的复杂问题时，先直接说结论，再解释关键原因，避免开头先铺很长的背景。' }] }] };
    const result = await summarizeCaptureContext([{ id: 'synthetic-preference-day1', role: 'user', text }], { run: async () => JSON.stringify(response) });
    expect(result.topics[0]).not.toHaveProperty('id');
    expect(result.topics[0].evidence[0]).toMatchObject({ start: 26, end: 63, role: 'user' });
  });
  it.each([null, 12, {}, [], '', '  ', 'x'.repeat(201)])('rejects malformed topic annotation %j', async id => {
    await expect(summarizeCaptureContext([{ id: 'u', role: 'user', text: '中文' }], {
      run: async () => JSON.stringify({ coveredIds: ['m0:0'], topics: [{ ...topic('u', '中文'), id }] }),
    })).rejects.toThrow('invalid topic annotation');
  });
  it('still rejects other unknown fields despite allowing local ids', async () => {
    await expect(summarizeCaptureContext([{ id: 'u', role: 'user', text: '中文' }], {
      run: async () => JSON.stringify({ coveredIds: ['m0:0'], topics: [{ ...topic('u', '中文'), id: 't1', approved: true }] }),
    })).rejects.toThrow('object shape');
  });
  it('submits a long single message without trimming and includes the final correction', async () => {
    const text = '  项目甲改用英文。' + '材料😀\n'.repeat(1_200) + '之前记错了，一直是中文。  ';
    const calls: any[] = [];
    const result = await summarizeCaptureContext([{ id: 'u1', role: 'user', text }], { run: mockRun(calls), maxInputChars: 4_000 });
    const pieces = calls.filter(call => call.stage === 'chunk').flatMap(call => call.segments);
    expect(pieces.map(piece => piece.text).join('')).toBe(text);
    expect(pieces.every(piece => text.slice(piece.start, piece.end) === piece.text)).toBe(true);
    expect(calls.every(call => JSON.stringify(call).length <= 4_000)).toBe(true);
    expect(result.topics[0].content).toContain('一直是中文');
    expect(result.topics[0].evidence.some(e => e.quote === '一直是中文')).toBe(true);
    expect(result.coverage.sourceChars).toBe(text.length);
    expect(result.coverage.processedSegmentIds).toEqual(pieces.map(piece => piece.id));
  });

  it('keeps separate themes, short Chinese quotes, roles and discovery provenance', async () => {
    const messages = [{ id: 'u', role: 'user', text: '中文。附数据。' }, { id: 'a', role: 'assistant', text: '建议全部改为英文。', discovery: true }];
    const result = await summarizeCaptureContext(messages, { run: async json => {
      expect(JSON.parse(json).segments[1].discovery).toBe(true);
      return JSON.stringify({ coveredIds: ['m0:0', 'm1:0'], topics: [topic('u', '中文'), topic('u', '附数据'), topic('a', '改为英文', 'assistant_proposal')] });
    } });
    expect(result.topics).toHaveLength(3);
    expect(result.topics[2].evidence[0]).toMatchObject({ role: 'assistant', start: 4, end: 8 });
    expect(result.topics[0].evidence[0].quote).toBe('中文');
  });

  it.each([
    { coveredIds: [], topics: [topic('u', '中文')] },
    { coveredIds: ['m0:0'], topics: [topic('u', '英文')] },
    { coveredIds: ['m0:0'], topics: [topic('a', '中文')] },
    { coveredIds: ['m0:0'], topics: [{ ...topic('u', '中文'), evidence: [] }] },
    { coveredIds: ['m0:0'], topics: [{ ...topic('u', '中文'), attribution: 'old_category' }] },
    { coveredIds: ['m0:0'], topics: [], eligible: false },
    { coveredIds: ['m0:0'], topics: [] },
    { coveredIds: ['m0:0', 'm0:0'], topics: [] },
  ])('fails explicitly on fabricated or malformed output %j', async response => {
    await expect(summarizeCaptureContext([{ id: 'u', role: 'user', text: '中文' }], { run: async () => JSON.stringify(response) })).rejects.toThrow();
  });

  it('does not turn assistant-only evidence into a user requirement', async () => {
    await expect(summarizeCaptureContext([{ id: 'a', role: 'assistant', text: '中文' }], {
      run: async () => JSON.stringify({ coveredIds: ['m0:0'], topics: [topic('a', '中文')] }),
    })).rejects.toThrow('user attribution');
  });

  it('checkpoints completed chunks and resumes without repeating submitted source', async () => {
    const messages = [{ id: 'u', role: 'user', text: '材料'.repeat(3_000) + '一直是中文' }];
    let checkpoint: CaptureContextCheckpoint;
    const firstCalls: any[] = [];
    await expect(summarizeCaptureContext(messages, { run: mockRun(firstCalls), maxInputChars: 4_000,
      onCheckpoint: cp => { checkpoint = cp; }, shouldContinue: async () => !checkpoint,
    })).rejects.toBeInstanceOf(CaptureContextInterruptedError);
    expect(checkpoint.chunks).toHaveLength(1);
    const resumedCalls: any[] = [];
    const result = await summarizeCaptureContext(messages, { run: mockRun(resumedCalls), maxInputChars: 4_000, checkpoint });
    const sourceCalls = [...firstCalls, ...resumedCalls].filter(call => call.stage === 'chunk');
    const ids = sourceCalls.flatMap(call => call.segments.map((s: any) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.coverage.processedSegmentIds).toEqual(ids);
    await expect(summarizeCaptureContext([{ ...messages[0], text: messages[0].text + '改变' }], {
      run: mockRun(), maxInputChars: 4_000, checkpoint,
    })).rejects.toThrow('checkpoint mismatch');
    const invalid = JSON.parse(JSON.stringify(checkpoint));
    invalid.chunks[0].topics[0].evidence[0].quote = '伪造';
    await expect(summarizeCaptureContext(messages, { run: mockRun(), maxInputChars: 4_000, checkpoint: invalid })).rejects.toThrow();
  });

  it('rejects dropped merge topics and oversized model output', async () => {
    const run = mockRun();
    await expect(summarizeCaptureContext([{ id: 'u', role: 'user', text: '材料'.repeat(3_000) }], {
      maxInputChars: 4_000, run: async json => {
        const input = JSON.parse(json);
        if (input.stage === 'chunk') return run(json);
        return JSON.stringify({ coveredIds: input.inputs.map((n: any) => n.id), topics: [] });
      },
    })).rejects.toThrow('dropped input topic');
    await expect(summarizeCaptureContext([{ id: 'u', role: 'user', text: '中文' }], { run: async () => ' '.repeat(16_001) })).rejects.toThrow('output too large');
  });

  it('accepts empty source without calling a model, and propagates model failure', async () => {
    expect((await summarizeCaptureContext([], { run: async () => { throw new Error('must not run'); } })).coverage.messageCount).toBe(0);
    await expect(summarizeCaptureContext([{ id: 'u', role: 'user', text: '中文' }], { run: async () => { throw new Error('runner failed'); } })).rejects.toThrow('runner failed');
  });
  it('revalidates stored summaries, exact source digest, coverage and original coordinates without model calls', async () => {
    const messages = [{ id: 'u', role: 'user', text: '中文。中文。' }];
    const summary = await summarizeCaptureContext(messages, { run: async () => JSON.stringify({
      coveredIds: ['m0:0'], topics: [{ ...topic('u', '中文'), evidence: [{ messageId: 'u', quote: '中文', start: 3, end: 5 }] }],
    }) });
    expect(summary.sourceDigest).toBe(captureContextSourceDigest(messages));
    expect(validateCaptureContextSummary(summary, messages)).toEqual(summary);
    expect(summary.topics[0].evidence[0].start).toBe(3);
    for (const mutate of [
      (value: any) => { value.sourceDigest = 'different'; },
      (value: any) => { value.completedAt = 'tomorrow'; },
      (value: any) => { value.coverage.processedSegmentIds = []; },
      (value: any) => { value.coverage.segmentCount++; },
      (value: any) => { value.coverage.messageCount++; },
      (value: any) => { value.coverage.sourceChars++; },
      (value: any) => { value.coverage.maxInputChars = undefined; },
      (value: any) => { value.topics[0].evidence[0].quote = '英文'; },
      (value: any) => { value.topics[0].evidence[0].role = 'assistant'; },
      (value: any) => { value.topics[0].evidence[0].start = -1; },
      (value: any) => { value.topics[0].evidence[0].end = 6; },
      (value: any) => { value.topics = []; },
    ]) {
      const invalid = JSON.parse(JSON.stringify(summary)); mutate(invalid);
      expect(() => validateCaptureContextSummary(invalid, messages)).toThrow();
    }
    expect(() => validateCaptureContextSummary(summary, [{ ...messages[0], text: messages[0].text + ' ' }])).toThrow('digest mismatch');
    expect(captureContextSourceDigest([{ ...messages[0], discovery: true }])).not.toBe(summary.sourceDigest);
  });

  it('checkpoints merges with topic mappings and resumes without repeating completed merges', async () => {
    const messages = [{ id: 'u', role: 'user', text: '材料'.repeat(10_000) }];
    let checkpoint: CaptureContextCheckpoint;
    const calls: any[] = [];
    const run = async (json: string) => {
      const input = JSON.parse(json); calls.push(input);
      if (input.stage === 'chunk') return JSON.stringify({ coveredIds: input.segments.map((s: any) => s.id),
        topics: [topic('u', '材料', 'user_requirement', '摘要'.repeat(400))] });
      const topics = input.inputs.flatMap((n: any) => n.topics);
      return JSON.stringify({ coveredIds: input.inputs.map((n: any) => n.id), topics: [{ ...topic('u', '材料', 'user_requirement', '摘要'.repeat(400)),
        evidence: [topics[0].evidence[0]], inputIds: topics.map((t: any) => t.id) }] });
    };
    await expect(summarizeCaptureContext(messages, { run, maxInputChars: 4_000,
      onCheckpoint: cp => { checkpoint = cp; }, shouldContinue: async () => !checkpoint?.merges?.length,
    })).rejects.toBeInstanceOf(CaptureContextInterruptedError);
    expect(checkpoint.merges).toHaveLength(1);
    const completedInputIds = checkpoint.merges[0].inputIds;
    expect(checkpoint.merges[0].topicInputIds.length).toBe(checkpoint.merges[0].topics.length);
    calls.length = 0;
    const result = await summarizeCaptureContext(messages, { run, maxInputChars: 4_000, checkpoint });
    expect(calls.every(call => call.stage === 'merge')).toBe(true);
    expect(calls.some(call => JSON.stringify(call.inputs.map((n: any) => n.id)) === JSON.stringify(completedInputIds))).toBe(false);
    expect(validateCaptureContextSummary(result, messages)).toEqual(result);
    const invalid = JSON.parse(JSON.stringify(checkpoint)); invalid.merges[0].topicInputIds = [[]];
    await expect(summarizeCaptureContext(messages, { run, maxInputChars: 4_000, checkpoint: invalid })).rejects.toThrow();
  });

  it('compresses large valid chunk responses before pairing them and bounds unsuccessful retries', async () => {
    const messages = [{ id: 'u', role: 'user', text: '材料'.repeat(20_000) }];
    let compressions = 0;
    const run = async (json: string) => {
      const input = JSON.parse(json);
      expect(json.length).toBeLessThanOrEqual(24_000);
      expect(input.outputBudgetChars).toBeLessThan(12_000);
      if (input.stage === 'chunk') return JSON.stringify({ coveredIds: input.segments.map((s: any) => s.id), topics:
        [0, 1, 2].map(() => topic('u', '材料', 'user_requirement', '大'.repeat(3_800))) });
      if (input.compression) compressions++;
      const topics = input.inputs.flatMap((n: any) => n.topics);
      return JSON.stringify({ coveredIds: input.inputs.map((n: any) => n.id), topics: [{ ...topic('u', '材料'),
        evidence: topics.flatMap((t: any) => t.evidence), inputIds: topics.map((t: any) => t.id) }] });
    };
    const result = await summarizeCaptureContext(messages, { run });
    expect(compressions).toBeGreaterThanOrEqual(2);
    expect(result.coverage.sourceChars).toBe(messages[0].text.length);
    let attempts = 0;
    await expect(summarizeCaptureContext([{ id: 'u', role: 'user', text: '材料' }], { run: async json => {
      const input = JSON.parse(json);
      const topics = [0, 1, 2].map(() => topic('u', '材料', 'user_requirement', '大'.repeat(3_800)));
      if (input.compression) {
        attempts++;
        return JSON.stringify({ coveredIds: input.inputs.map((n: any) => n.id), topics: topics.map((t, i) => ({ ...t,
          evidence: input.inputs[0].topics[i].evidence, inputIds: [input.inputs[0].topics[i].id] })) });
      }
      return JSON.stringify({ coveredIds: input.segments.map((s: any) => s.id), topics });
    } })).rejects.toThrow('compression budget exhausted');
    expect(attempts).toBe(2);
  });

});

it('carries source timestamps into full-context summarization for relative dates and dated owner changes', async () => {
  const text = '从下周起项目甲由合成接手人甲接手，先前是合成前任乙负责。';
  await summarizeCaptureContext([{ id: 'u-date', role: 'user', text, ts: '2026-10-15T02:00:00.000Z', discovery: true }], {
    run: async json => {
      const input = JSON.parse(json); expect(input.segments[0].ts).toBe('2026-10-15T02:00:00.000Z');
      return JSON.stringify({ coveredIds: ['m0:0'], topics: [topic('u-date', text)] });
    },
  });
});
