/**
 * transcript_rewrite + transcript_clean_pipeline — 受约束重建层与确定性清理层
 *
 * 重点覆盖（对齐 AGENTS「测业务不变量、恢复路径、文本陷阱」）：
 *   - **锚点纪律**：引用不存在的发言 id 的段落必须被丢弃——这条直接对治一个真实事故：
 *     人工+模型清理版结尾有一整句 `21:15:15—21:15:26「…我先试试 Codex…」`，
 *     而原文最大时间戳是 21:15:11、且「晚安」「完善」「额外」在原文各出现 0 次；
 *   - **防擅自删内容**：未被任何段落引用的源发言必须被列出来；
 *   - **防新增实体**：段里出现原文没有的拉丁专名要记问题，但**词表规范形必须豁免**
 *     （规范形在原文中出现 0 次，不豁免则每一处合法归一都会被误报）；
 *   - 口癖删除**不得见词就删**（`这个方案` 的"这个"不该删）；
 *   - 实体归一**模糊通道默认不自动替换**（真实误召回：`cookie→Cogseed` 0.80、`id→EduSeed` 0.67）；
 *   - 保留率区间与锚点覆盖率必须如实上报。
 */

import { describe, it, expect } from 'vitest';
import {
  REWRITE_MIN_RETENTION,
  REWRITE_MAX_RETENTION,
  buildRewriteRequest,
  extractJsonArray,
  parseRewriteResponse,
  toSuspectNotes,
  verifyRewrite,
  applyQuotedFallback,
  type SourceUtterance,
} from '../../../src/main/features/transcript_rewrite';
import {
  mergeBlocks,
  normalizeEntities,
  parseSource,
  removeFillers,
  renderMarkdown,
  tidyPunctuation,
} from '../../../src/main/features/transcript_clean_pipeline';
import { defaultBoundary, type GlossaryEntry } from '../../../src/main/features/transcript_glossary';

let seq = 0;
function entry(over: Partial<GlossaryEntry> & { wrong: string; correct: string }): GlossaryEntry {
  seq += 1;
  return {
    id: over.id ?? `g_w${seq}`,
    wrong: over.wrong,
    correct: over.correct,
    action: over.action ?? 'replace',
    kind: over.kind ?? 'product',
    riskLevel: over.riskLevel ?? 'low',
    boundary: over.boundary ?? defaultBoundary(over.wrong, over.action ?? 'replace'),
    contextDeny: over.contextDeny ?? [],
    contextAllow: over.contextAllow ?? [],
    scope: over.scope ?? { docIds: [], scenarioTags: [], global: true },
    freq: over.freq ?? 0,
    source: over.source ?? 'manual',
    status: over.status ?? 'active',
    ownerScope: over.ownerScope ?? 'personal',
    replacedIn: over.replacedIn ?? [],
    createdBy: over.createdBy ?? 'manual',
    createdAt: over.createdAt ?? 1,
    updatedAt: over.updatedAt ?? 1,
    lastVerifiedAt: over.lastVerifiedAt ?? 1,
  };
}

const SRC: SourceUtterance[] = [
  { id: 'U0001', speaker: 'Richard', at: '2026-09-05 19:31:32', text: 'Hello。' },
  { id: 'U0002', speaker: '张浩', at: '2026-09-05 19:31:34', text: '哈喽哈喽能听到吗？' },
  { id: 'U0003', speaker: 'Richard', at: '2026-09-05 19:35:24', text: '长期来说的话，你应该是，就是你的身份，实际上是你的个人本体。' },
  { id: 'U0004', speaker: 'Richard', at: '2026-09-05 19:35:36', text: '那你要是你比如说你从静雯，比如换成保康的话，那他就应该那什么了呀。' },
];

describe('① 冻结解析 parseSource', () => {
  it('逐条拆出发言，id 从 U0001 起按序稳定', () => {
    const text = [
      '2026-09-05 19:26:04 会议已开启实时转写，机器识别结果仅供参考 ',
      'Richard 2026-09-05 19:31:32 ',
      'Hello.  ',
      '张浩 2026-09-05 19:31:34 ',
      '哈喽哈喽能听到吗？ ',
    ].join('\n');
    const out = parseSource(text);
    expect(out.map((u) => u.id)).toEqual(['U0001', 'U0002']);
    expect(out[0].speaker).toBe('Richard');
    expect(out[0].at).toBe('2026-09-05 19:31:32');
    expect(out[1].text).toBe('哈喽哈喽能听到吗？');
  });

  it('跳过会议横幅；无发言人的散行不产出条目', () => {
    const out = parseSource('2026-09-05 19:26:04 会议已开启实时转写，机器识别结果仅供参考\n随便一行\n');
    expect(out).toHaveLength(0);
  });

  it('同一条发言跨多行时拼成一条（换行不切段）', () => {
    const out = parseSource('Richard 2026-09-05 19:31:32 \n第一行\n第二行\n张浩 2026-09-05 19:31:34 \n好的\n');
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe('第一行第二行');
  });

  it('相对时钟导出（无日期）同样解析出全部发言，`at` 沿用原文时钟', () => {
    // 真机事故（2026-09-18）：旧正则硬要日期，这类稿子解析出 0 条发言 →
    // 整条清理管线静默失效（77 分钟的稿子清理版为空）。
    const text = [
      '牛保康 02:45',
      '喂海运哥能听到吗？',
      '尹镇宇 02:56',
      '我这边能听到？',
      '刘海运 01:00:35',
      '然后下边就是实现的现状与缺口。',
    ].join('\n');
    const out = parseSource(text);
    expect(out).toHaveLength(3);
    expect(out.map((u) => u.speaker)).toEqual(['牛保康', '尹镇宇', '刘海运']);
    expect(out.map((u) => u.at)).toEqual(['02:45', '02:56', '01:00:35']);
    expect(out[0].text).toBe('喂海运哥能听到吗？');
    expect(out[2].text).toBe('然后下边就是实现的现状与缺口。');
    // id 仍是稳定锚点
    expect(out.map((u) => u.id)).toEqual(['U0001', 'U0002', 'U0003']);
  });

  it('相对时钟导出不带日期的转写声明横幅也跳过', () => {
    const out = parseSource('00:00:00 会议已开启实时转写，机器识别结果仅供参考\n牛保康 02:45\n喂海运哥能听到吗？\n');
    expect(out).toHaveLength(1);
    expect(out[0].speaker).toBe('牛保康');
    expect(out[0].text).toBe('喂海运哥能听到吗？');
  });
});

describe('② 口癖删除 removeFillers', () => {
  it('删语气词并修掉删词留下的悬空标点', () => {
    const { items, totals } = removeFillers([
      { id: 'U0001', speaker: 'A', at: 't', text: '嗯，那先过一下产品这边。' },
      { id: 'U0002', speaker: 'A', at: 't', text: '呃，还有就是，嗯，关于官网。' },
    ]);
    expect(items[0].text).toBe('那先过一下产品这边。');
    expect(items[1].text).not.toMatch(/^，/);
    expect(items[1].text).not.toContain('，，');
    expect(totals['嗯']).toBe(2);
    expect(totals['呃']).toBe(1);
  });

  it('**绝不"见词就删"**：`这个方案` 里的"这个"不该被删', () => {
    const { items } = removeFillers([
      { id: 'U0001', speaker: 'A', at: 't', text: '这个方案要重新评估。' },
    ]);
    expect(items[0].text).toContain('这个方案');
  });

  it('tidyPunctuation 收敛重复标点与句首悬空标点', () => {
    expect(tidyPunctuation('，，然后。')).toBe('然后。');
    expect(tidyPunctuation('好的，，，继续')).toBe('好的，继续');
    expect(tidyPunctuation('就是没法评估。，好。')).toBe('就是没法评估。，好。');
  });
});

describe('③ 实体归一 normalizeEntities', () => {
  const cogseed = entry({ wrong: 'coxy', correct: 'Cogseed' });
  const kstar = entry({ wrong: 'K star', correct: 'KSTAR', kind: 'term' });

  it('归一化通道（大小写/分隔符）自动替换', () => {
    const r = normalizeEntities('这块用的是 K-STAR 记录', [kstar], { domainTerms: ['KSTAR'] });
    expect(r.text).toBe('这块用的是 KSTAR 记录');
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0].channel).toBe('normalized');
  });

  it('模糊通道**默认不自动替换**，只进 pending（真实误召回：cookie→Cogseed 0.80）', () => {
    const r = normalizeEntities('它本地是有个 cookie 吗', [cogseed], { domainTerms: ['Cogseed'] });
    expect(r.text).toBe('它本地是有个 cookie 吗'); // 未被改动
    expect(r.pending.some((p) => p.wrong === 'cookie')).toBe(true);
    expect(r.applied).toHaveLength(0);
  });

  it('显式放行模糊通道才会替换（人工确认后的路径）', () => {
    const r = normalizeEntities('它本地是有个 cookie 吗', [cogseed], {
      domainTerms: ['Cogseed'],
      autoChannels: ['normalized', 'weak', 'phonetic', 'edit'],
    });
    expect(r.text).toContain('Cogseed');
  });
});

describe('④ 重建契约 buildRewriteRequest / parseRewriteResponse', () => {
  it('请求里带上源发言 id、词表与场景', () => {
    const req = buildRewriteRequest(SRC, {
      scenario: '教育智能体演示汇报',
      glossary: [{ correct: 'Cogseed', forms: ['coxy', 'cox'] }],
    });
    expect(req.message).toContain('U0001｜Richard｜2026-09-05 19:31:32｜Hello。');
    expect(req.message).toContain('Cogseed ← coxy / cox');
    expect(req.message).toContain('教育智能体演示汇报');
    expect(req.systemPrompt).toContain('绝对禁止');
  });

  it('extractJsonArray 能抠出裸 JSON 与 ```json 围栏里的 JSON', () => {
    expect(extractJsonArray('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(extractJsonArray('好的，如下：\n```json\n[{"a":1}]\n```\n完毕')).toEqual([{ a: 1 }]);
    expect(extractJsonArray('模型没输出 JSON')).toBeNull();
  });

  it('解析时丢掉"没给 srcIds"和"空文本"的段落，并如实记账', () => {
    const raw = JSON.stringify([
      { srcIds: ['U0001'], text: '好。' },
      { srcIds: [], text: '没有锚点的段落' },
      { srcIds: ['U0001'], text: '   ' },
    ]);
    const { paragraphs, issues } = parseRewriteResponse(raw);
    expect(paragraphs).toHaveLength(1);
    expect(issues.map((i) => i.reason)).toEqual(['unreferenced_paragraph', 'empty_paragraph']);
  });
});

describe('⑤ 锚点校验 verifyRewrite（本模块存在的意义）', () => {
  it('**引用不存在的 id 的段落必须被丢弃** —— 直接对治"清理版凭空补出结尾"的真实事故', () => {
    const result = verifyRewrite(SRC, [
      { srcIds: ['U0003'], text: SRC[2].text },
      // 伪造：原文最大时间戳是 19:35:36，根本不存在 U9999 这条发言
      { srcIds: ['U9999'], text: '好的，晚安。我先试试 Codex，看看能不能把这次会议整理得更完善一些。' },
    ]);
    expect(result.paragraphs).toHaveLength(1);
    expect(result.issues.some((i) => i.reason === 'invalid_anchor')).toBe(true);
    // 而且必须记账，不能静默丢
    const issue = result.issues.find((i) => i.reason === 'invalid_anchor');
    expect(issue?.detail).toContain('U9999');
  });

  it('未被任何段落引用的源发言必须被列出来（防模型擅自删内容）', () => {
    const result = verifyRewrite(SRC, [{ srcIds: ['U0003'], text: SRC[2].text }]);
    expect(result.uncovered).toEqual(['U0001', 'U0002', 'U0004']);
  });

  it('新增实体会被记录，但**词表规范形必须豁免**', () => {
    const flagged = verifyRewrite(SRC, [
      { srcIds: ['U0001'], text: 'Hello。这段里凭空多了一个 Gartner9 的说法。' },
    ]);
    expect(flagged.issues.some((i) => i.reason === 'new_entity')).toBe(true);

    const ok = verifyRewrite(
      SRC,
      [{ srcIds: ['U0001'], text: 'Hello。这段用了 Cogseed 的规范写法。' }],
      { allowedTerms: ['Cogseed'] },
    );
    expect(ok.issues.some((i) => i.reason === 'new_entity')).toBe(false);
  });

  it('只是大小写/空格差异的写法不算"新增实体"（NotebookLM vs notebook lm）', () => {
    const S = [...SRC, { id: 'U0007', speaker: '张浩', at: 't', text: '那个是照 notebook lm 那么做的一个东西。' }];
    const ok = verifyRewrite(S, [{ srcIds: ['U0007'], text: '那个是照 NotebookLM 那么做的一个东西。' }], { allowedTerms: [] });
    expect(ok.issues.some((i) => i.reason === 'new_entity')).toBe(false);

    // 但真正的"原文没有的写法"仍要报出
    const bad = verifyRewrite(S, [{ srcIds: ['U0007'], text: '那个是照 OpenMAIC 那么做的一个东西。' }], { allowedTerms: [] });
    expect(bad.issues.some((i) => i.reason === 'new_entity')).toBe(true);
  });

  it('相似度过低的段落标 suspect，不进正文（机器侧计算，不用模型自报置信度）', () => {
    const result = verifyRewrite(SRC, [
      { srcIds: ['U0001'], text: '这是一段和 Hello 完全无关的长文本，凭空写了很多内容，明显不是重建而是编造。' },
    ]);
    expect(result.paragraphs[0].suspect).toBe(true);
    expect(result.issues.some((i) => i.reason === 'low_similarity')).toBe(true);
  });

  it('保留率如实计算并给出是否落在区间内', () => {
    const result = verifyRewrite(SRC, [{ srcIds: ['U0003'], text: SRC[2].text }]);
    expect(result.stats.retention).toBeGreaterThan(0);
    expect(result.stats.retention).toBeLessThanOrEqual(REWRITE_MAX_RETENTION);
    expect(result.stats.retentionOk).toBe(true);
    const tiny = verifyRewrite(SRC, [{ srcIds: ['U0003'], text: '身份。' }]);
    expect(tiny.stats.retention).toBeLessThan(REWRITE_MIN_RETENTION);
    expect(tiny.stats.retentionOk).toBe(false);
  });

  it('锚点覆盖率为 1（本模块保证每段都有锚点）且多段引用同一发言时正确去重', () => {
    const result = verifyRewrite(SRC, [
      { srcIds: ['U0003'], text: SRC[2].text },
      { srcIds: ['U0003', 'U0004'], text: SRC[2].text + SRC[3].text },
    ], { allowedTerms: [] });
    expect(result.stats.anchorCoverage).toBe(1);
    expect(result.uncovered).toEqual(['U0001', 'U0002']);
  });

  it('**第三人称转述被直接判定**（实测失败模式：模型把"重建"做成"写摘要"）', () => {
    const result = verifyRewrite(
      SRC,
      [
        { srcIds: ['U0003', 'U0004'], text: 'Richard 指出，个人本体与个人身份是直接连接的，换成保康就全都对不上了。' },
      ],
      { speakers: ['Richard', '张浩'], allowedTerms: [] },
    );
    expect(result.issues.some((i) => i.reason === 'narration_style')).toBe(true);
    expect(result.stats.narrationCount).toBe(1);
  });

  it('第一人称原话不会被误判为转述', () => {
    const result = verifyRewrite(
      SRC,
      [{ srcIds: ['U0003'], text: '长期来说，身份实际上就是你的个人本体。' }],
      { speakers: ['Richard', '张浩'], allowedTerms: [] },
    );
    expect(result.issues.some((i) => i.reason === 'narration_style')).toBe(false);
  });

  it('跨说话人的段落按"谁的话更能解释它"定归属，而不是一律算第一个人', () => {
    const result = verifyRewrite(
      SRC,
      [{ srcIds: ['U0002', 'U0003'], text: '长期来说，身份实际上就是你的个人本体。' }],
      { allowedTerms: [] },
    );
    // U0002 是张浩、U0003 是 Richard；文本明显是 Richard 说的 → 必须归给 Richard
    expect(result.paragraphs[0].speaker).toBe('Richard');
    expect(result.issues.some((i) => i.reason === 'mixed_speaker')).toBe(false);
  });

  it('把一段对话焊成一句（谁的都解释不了）→ 判 mixed_speaker 并摘出正文', () => {
    const result = verifyRewrite(
      SRC,
      [{ srcIds: ['U0001', 'U0002'], text: '会议开始了，两边互相打招呼，然后说了一下投屏的事。' }],
      { allowedTerms: [] },
    );
    expect(result.issues.some((i) => i.reason === 'mixed_speaker')).toBe(true);
    expect(result.stats.mixedSpeakerCount).toBe(1);
    expect(result.paragraphs[0].suspect).toBe(true);
  });

  it('**过度归一被抓住**：用了规范形但来源里没有依据（真实案例 code→Cogseed）', () => {
    const cogseedEntry = entry({ wrong: 'coxy', correct: 'Cogseed' });
    const bad = verifyRewrite(
      SRC,
      [{ srcIds: ['U0003'], text: '相当于把插件的功能全都内化到 Cogseed 里面。' }],
      { allowedTerms: ['Cogseed'], canonicalForms: [{ correct: 'Cogseed', forms: ['coxy', 'cox'] }] },
    );
    expect(bad.issues.some((i) => i.reason === 'unsupported_canonical')).toBe(true);

    // 来源里确实出现了词表形态（coxy）→ 不算过度归一
    const ok = verifyRewrite(
      [...SRC, { id: 'U0005', speaker: '张浩', at: 't', text: '我的 coxy 是个人大管家。' }],
      [{ srcIds: ['U0005'], text: '我的 Cogseed 是个人大管家。' }],
      { allowedTerms: ['Cogseed'], canonicalForms: [{ correct: 'Cogseed', forms: ['coxy', 'cox'] }] },
    );
    expect(ok.issues.some((i) => i.reason === 'unsupported_canonical')).toBe(false);
    expect(cogseedEntry.correct).toBe('Cogseed');
  });

  it('**引例被抹平被抓住**：说话人在举错写例子，产出改成规范形 → 语义破坏', () => {
    const S = [...SRC, { id: 'U0009', speaker: 'Richard', at: 't', text: '你看咱们现在转写里面，它一会儿叫什么？coxy 一会儿叫别的。' }];
    const bad = verifyRewrite(
      S,
      [{ srcIds: ['U0009'], text: '你看咱们现在的转写，一会儿叫 Cogseed，一会儿叫别的什么。' }],
      { allowedTerms: ['Cogseed'], canonicalForms: [{ correct: 'Cogseed', forms: ['coxy', 'cox'] }] },
    );
    expect(bad.issues.some((i) => i.reason === 'quoted_form_flattened')).toBe(true);

    // 保留引例 → 不告警
    const ok = verifyRewrite(
      S,
      [{ srcIds: ['U0009'], text: '你看咱们现在的转写，一会儿叫 coxy，一会儿叫别的什么。' }],
      { allowedTerms: ['Cogseed'], canonicalForms: [{ correct: 'Cogseed', forms: ['coxy', 'cox'] }] },
    );
    expect(ok.issues.some((i) => i.reason === 'quoted_form_flattened')).toBe(false);
  });

  it('**挂名丢弃被抓住**：id 被引用但该条内容没进产出（不丢信息的空档）', () => {
    const S = [...SRC, { id: 'U0011', speaker: 'Richard', at: 't', text: '就会有大量这种沉淀的东西需要处理，你稍等一下我看看这个。' }];
    const bad = verifyRewrite(
      S,
      [{ srcIds: ['U0003', 'U0011'], text: SRC[2].text }],
      { allowedTerms: [], checkDroppedUtterances: true },
    );
    const hit = bad.issues.filter((i) => i.reason === 'dropped_utterance');
    expect(hit).toHaveLength(1);
    expect(hit[0].srcIds).toEqual(['U0011']);
    expect(bad.stats.droppedUtteranceCount).toBe(1);
  });

  it('挂名丢弃检查**默认关闭**（实测噪声率过高，留着会淹没真信号）', () => {
    const S = [...SRC, { id: 'U0011', speaker: 'Richard', at: 't', text: '就会有大量这种沉淀的东西需要处理，你稍等一下我看看这个。' }];
    const off = verifyRewrite(S, [{ srcIds: ['U0003', 'U0011'], text: SRC[2].text }], { allowedTerms: [] });
    expect(off.issues.some((i) => i.reason === 'dropped_utterance')).toBe(false);
  });

  it('极短应答被合并/删除属正常，不报挂名丢弃', () => {
    const S = [...SRC, { id: 'U0012', speaker: '张浩', at: 't', text: '对对。' }];
    const ok = verifyRewrite(S, [{ srcIds: ['U0003', 'U0012'], text: SRC[2].text }],
      { allowedTerms: [], checkDroppedUtterances: true });
    expect(ok.issues.some((i) => i.reason === 'dropped_utterance')).toBe(false);
  });

  it('质量门把"摘要化"与"过度改写/没清理"区分开（诊断可行动）', () => {
    const summarized = verifyRewrite(
      SRC,
      [
        { srcIds: ['U0001'], text: '会议开始，双方互相问候，确认能听到。' },
        { srcIds: ['U0002'], text: '张浩询问是否开始投屏。' },
      ],
      { speakers: ['Richard', '张浩'], allowedTerms: [] },
    );
    expect(summarized.stats.qualityGate).toBe('summarized');

    const fine = verifyRewrite(SRC, [
      { srcIds: ['U0003'], text: SRC[2].text },
      { srcIds: ['U0004'], text: SRC[3].text },
    ]);
    expect(fine.stats.qualityGate).toBe('pass');
  });

  it('toSuspectNotes 只输出需要人来判断的两类问题', () => {
    const result = verifyRewrite(SRC, [
      { srcIds: ['U0001'], text: '和 Hello 毫无关系的编造长文本内容内容内容内容内容内容。' },
      { srcIds: ['U0002'], text: '哈喽哈喽能听到吗？多了一个 Bogus7。' },
    ], { allowedTerms: [] });
    const notes = toSuspectNotes(result);
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) expect(n.note).toMatch(/待核/);
  });
});

describe('⑤b 引例段确定性回退（不依赖模型遵守提示词）', () => {
  it('被标记的引例段回退为源发言原文并加可见标注', () => {
    const S = [...SRC, { id: 'U0009', speaker: 'Richard', at: 't', text: '它一会儿叫什么？coxy 一会儿叫别的。' }];
    const v = verifyRewrite(
      S,
      [{ srcIds: ['U0009'], text: '它一会儿叫 Cogseed，一会儿叫别的什么。' }],
      { allowedTerms: ['Cogseed'], canonicalForms: [{ correct: 'Cogseed', forms: ['coxy', 'cox'] }] },
    );
    const map = new Map(S.map((u) => [u.id, u.text]));
    const fixed = applyQuotedFallback(v.paragraphs, v.issues, (id) => map.get(id) ?? '');
    expect(fixed.repaired).toHaveLength(1);
    expect(fixed.paragraphs[0].text).toContain('coxy');            // 引例被救回
    expect(fixed.paragraphs[0].text).toContain('回退原文表述');      // 标注可见
  });

  it('没被标记的段落原样不动', () => {
    const v = verifyRewrite(SRC, [{ srcIds: ['U0003'], text: SRC[2].text }]);
    const fixed = applyQuotedFallback(v.paragraphs, v.issues, () => 'X');
    expect(fixed.repaired).toHaveLength(0);
    expect(fixed.paragraphs[0].text).toBe(SRC[2].text);
  });
});

describe('⑥ 结构合并与渲染', () => {
  it('同人相邻段落合并为一块，并给出起止时间与合并后的锚点', () => {
    const blocks = mergeBlocks([
      { srcIds: ['U0003'], text: '甲', similarity: 1, speaker: 'Richard', from: '2026-09-05 19:35:24', to: '2026-09-05 19:35:24', suspect: false },
      { srcIds: ['U0004'], text: '乙', similarity: 1, speaker: 'Richard', from: '2026-09-05 19:35:36', to: '2026-09-05 19:35:36', suspect: false },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].paragraphs).toEqual(['甲', '乙']);
    expect(blocks[0].srcIds).toEqual(['U0003', 'U0004']);
  });

  it('发言人切换时开新块', () => {
    const blocks = mergeBlocks([
      { srcIds: ['U0001'], text: '甲', similarity: 1, speaker: 'A', from: 't1', to: 't1', suspect: false },
      { srcIds: ['U0002'], text: '乙', similarity: 1, speaker: 'B', from: 't2', to: 't2', suspect: false },
    ]);
    expect(blocks).toHaveLength(2);
  });

  it('渲染产物含：说话人｜时间块、逐段锚点、整理说明、附记与未决项', () => {
    const md = renderMarkdown(
      [{ speaker: 'Richard', from: '2026-09-05 19:35:24', to: '2026-09-05 19:35:36', paragraphs: ['身份是个人本体的一部分。'], srcIds: ['U0003', 'U0004'] }],
      {
        title: '测试标题', date: '2026-09-05', speakers: ['Richard'],
        glossaryTable: [{ correct: 'Cogseed', forms: 'coxy、cox', basis: '项目文档' }],
        openItems: ['〔本次额外入册，尚未经人工确认〕静文 → 静雯'],
        materials: ['原始转写：x.txt'],
        stats: { '字符保留率': '50%' },
      },
    );
    expect(md).toContain('# 测试标题');
    expect(md).toContain('**Richard｜19:35:24—19:35:36**');
    expect(md).toContain('⟦U0003-U0004⟧');
    expect(md).toContain('每个段落都回引了源发言 id');
    expect(md).toContain('| Cogseed | coxy、cox | 项目文档 |');
    expect(md).toContain('未决项');
    expect(md).toContain('本次运行统计');
  });
});
