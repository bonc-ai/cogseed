/**
 * transcript.* IPC — 转写纠错词表与清理产物
 *
 * 分层规则（AGENTS.md §Layering）：本文件只做**参数收敛 + 调用 features**，
 * 不写业务逻辑。所有 feature 调用都把 `ctx.userId` 作为首参，因此不存在
 * "用当前活跃用户写别人的库"这条隐式路径。
 *
 * 通道列表（P0）：
 *   transcript.glossary.list / upsert / setStatus / delete / import / export
 *   transcript.correct.scan        —— 只读扫描，产出候选 + 拒绝原因
 *   transcript.correct.apply       —— 按确认结果替换，落 run 快照，原文不可变
 *   transcript.run.list / get / report / notes / revert
 *   transcript.issues.list / resolve
 *
 * 本体接线（P1，2026-09-15）：
 *   transcript.glossary.syncOntology —— 归组 + 挂 ontologyRef + 出建议（+可选反哺候选）
 *   transcript.glossary.adoptSeed    —— 采纳"待补错形"建议，建 ontology_seed 词条
 *   transcript.glossary.applyAlignment —— 采纳"对齐"建议，改词条写法（只改 correct）
 *   transcript.glossary.setScope / setIgnored / addAllow —— 接受的三个动作（范围/忽略/加白）
 */

import * as transcriptGlossary from '../features/transcript_glossary';
import * as transcriptAutoCorrect from '../features/transcript_auto_correct';
import * as transcriptRuns from '../features/transcript_correction_runs';
import * as transcriptOntology from '../features/transcript_ontology_bridge';
import * as transcriptFillers from '../features/transcript_filler_rules';
import * as transcriptMerge from '../features/transcript_speaker_merge';
import * as transcriptSeed from '../features/transcript_glossary_seed';
import * as transcriptLlm from '../features/transcript_llm_candidates';
import * as transcriptHeadings from '../features/transcript_headings';
import * as transcriptQuery from '../features/transcript_query_rewrite';
import * as transcriptPack from '../features/transcript_contribution_pack';
import { cogseedKbManager } from '../features/cogseed_backend/cogseed-kb-store';

interface IpcContext {
  userId: string;
}

type Payload = Record<string, unknown>;

const MAX_TRANSCRIPT_CHARS = 400_000;

function requireText(value: unknown, field: string, max = 200_000): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`missing transcript ${field}`);
  if (value.length > max) throw new Error(`transcript ${field} too long`);
  return value;
}

function optionalText(value: unknown, field: string, max = 200): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`invalid transcript ${field}`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) throw new Error(`transcript ${field} too long`);
  return text;
}

function optionalId(value: unknown, field: string): string | undefined {
  return optionalText(value, field, 128);
}

function stringList(value: unknown, max = 200): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('invalid transcript list');
  return value.filter((v): v is string => typeof v === 'string' && !!v.trim()).slice(0, max);
}

function riskLevels(value: unknown): Array<'low' | 'medium' | 'high'> | undefined {
  const list = stringList(value, 3);
  if (!list) return undefined;
  return list.filter((v): v is 'low' | 'medium' | 'high' => v === 'low' || v === 'medium' || v === 'high');
}

function issueInputs(value: unknown): Array<{
  span: { start: number; end: number };
  text: string;
  reason: transcriptRuns.IssueReason;
  suggestion?: string;
}> {
  if (!Array.isArray(value)) return [];
  const allowed: transcriptRuns.IssueReason[] = ['unknown_entity', 'ambiguous_name', 'mixed_speech', 'asr_unrecoverable'];
  return value.slice(0, 200).map((raw) => {
    const item = raw as Partial<{ span: { start: number; end: number }; text: string; reason: string; suggestion: string }>;
    const start = typeof item?.span?.start === 'number' ? Math.max(0, Math.floor(item.span.start)) : 0;
    const end = typeof item?.span?.end === 'number' ? Math.max(start, Math.floor(item.span.end)) : start;
    const reason = allowed.includes(item?.reason as transcriptRuns.IssueReason)
      ? (item!.reason as transcriptRuns.IssueReason)
      : 'unknown_entity';
    return {
      span: { start, end },
      text: typeof item?.text === 'string' ? item.text.slice(0, 500) : '',
      reason,
      ...(typeof item?.suggestion === 'string' ? { suggestion: item.suggestion.slice(0, 300) } : {}),
    };
  });
}

/**
 * 把"待核"标记真正写进清理版，并返回插入后的 span。
 * 输入 span 必须是**清理版**坐标（调用方先用 mapOffset 从原文坐标换算过来）；
 * 映射不到的（落在被删除区域且无对应位置）直接丢弃，不假装标上了。
 */
function withIssueMarkers(
  applied: transcriptAutoCorrect.ApplyResult,
  issues: Array<{
    span: { start: number; end: number };
    text: string;
    reason: transcriptRuns.IssueReason;
    suggestion?: string;
  }>,
): {
  result: transcriptAutoCorrect.ApplyResult;
  issues: Array<{
    span: { start: number; end: number };
    text: string;
    reason: transcriptRuns.IssueReason;
    suggestion?: string;
  }>;
} {
  if (issues.length === 0) return { result: applied, issues: [] };
  const resolved = issues
    .map((issue) => {
      const at = transcriptAutoCorrect.mapOffset(applied.offsetMap, issue.span.start);
      if (at === null) return null;
      const start = Math.max(0, Math.min(at, applied.text.length));
      const end = Math.max(start, Math.min(
        transcriptAutoCorrect.mapOffset(applied.offsetMap, issue.span.end) ?? start + 1,
        applied.text.length,
      ));
      return { ...issue, span: { start, end } };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  if (resolved.length === 0) return { result: applied, issues: [] };

  const marked = transcriptAutoCorrect.insertIssueMarkers(applied.text, resolved.map((i) => i.span));
  // byStart 以**输入**插入点为键，同一位置多条待核共用同一个标记 span
  const withSpans = resolved
    .map((issue) => {
      const span = marked.byStart.get(issue.span.start);
      return span ? { ...issue, span } : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const charsOut = marked.text.length;
  const charsIn = applied.charsIn;
  const retention = charsIn > 0 ? charsOut / charsIn : 1;
  return {
    result: {
      ...applied,
      text: marked.text,
      charsOut,
      retention,
      overRewriteSuspected: retention < transcriptAutoCorrect.OVER_REWRITE_THRESHOLD,
    },
    issues: withSpans,
  };
}

export const invokeHandlers = {
  // ── 词表 ──────────────────────────────────────────────────────────────
  'transcript.glossary.list': async (payload: Payload, ctx: IpcContext) => ({
    entries: transcriptGlossary.listEntries(ctx.userId, {
      ...(payload?.kind ? { kind: payload.kind as transcriptGlossary.GlossaryKind } : {}),
      ...(payload?.riskLevel ? { riskLevel: payload.riskLevel as transcriptGlossary.RiskLevel } : {}),
      ...(payload?.status ? { status: payload.status as transcriptGlossary.EntryStatus } : {}),
      ...(typeof payload?.search === 'string' && payload.search ? { search: payload.search } : {}),
    }),
    // 词表 owner 与最后维护时间（方案 §七）；管理页据此显示表级归属。
    meta: transcriptGlossary.readMeta(ctx.userId),
    file: 'transcript-glossary.json',
  }),

  /**
   * 装入口癖规则包（方案 §五 P1-1）：把默认规则写成 `action=delete` +
   * `kind=filler` 的词条，之后走既有词表链路（可暂停、可删、可回滚）。
   * 幂等：已在词表里的词只更新规则字段，不重复入库。
   */
  'transcript.glossary.seedFillers': async (_payload: Payload, ctx: IpcContext) => {
    let created = 0;
    let updated = 0;
    for (const rule of transcriptFillers.fillerRuleEntries()) {
      const result = transcriptGlossary.upsertEntry(ctx.userId, {
        wrong: rule.wrong,
        action: 'delete',
        kind: 'filler',
        boundary: 'substring',
        riskLevel: 'low',
        source: 'import',
      });
      if (result.entry) {
        if (result.created) created += 1;
        else updated += 1;
      }
    }
    return { created, updated, pack: transcriptFillers.FILLER_PACK_VERSION };
  },

  /**
   * 装入方案附 A 的初始词表种子（幂等）。`for → Forge` 等方案明写"默认不入册"
   * 的词**不在种子里**（见 transcript_glossary_seed）。
   */
  'transcript.glossary.seedInitial': async (_payload: Payload, ctx: IpcContext) => {
    const result = transcriptSeed.seedInitialEntries(ctx.userId);
    return { ...result, excluded: transcriptSeed.SEED_EXCLUDED.map((row) => row.wrong) };
  },

  /**
   * 贡献包导出（方案 §五 P3-1）：按 kind/scenarioTags 导出子集，
   * **人名类默认不导**；包里剥掉 replacedIn / scope.docIds 等本地隐私字段。
   */
  'transcript.glossary.exportPack': async (payload: Payload, ctx: IpcContext) => ({
    pack: transcriptPack.buildContributionPack(ctx.userId, {
      ...(stringList(payload?.kinds, 20) ? { kinds: stringList(payload?.kinds, 20)! as transcriptGlossary.GlossaryKind[] } : {}),
      ...(stringList(payload?.scenarioTags, 20) ? { scenarioTags: stringList(payload?.scenarioTags, 20)! } : {}),
      includePeople: payload?.includePeople === true,
      ownerScope: payload?.ownerScope === 'team' || payload?.ownerScope === 'org' ? payload.ownerScope : 'personal',
    }),
  }),

  /** 贡献包导入预览（治理闸门：先给人看新增/冲突/高风险/人名，再决定导不导）。 */
  'transcript.glossary.reviewPack': async (payload: Payload, ctx: IpcContext) => {
    const pack = transcriptPack.parseContributionPack(payload?.pack ?? payload);
    if (!pack) throw new Error('transcript glossary: invalid contribution pack');
    return { review: transcriptPack.reviewContributionPack(ctx.userId, pack), ownerScope: pack.ownerScope };
  },

  /** 贡献包导入：优先级 组织 > 团队 > 个人（本地更高时保留本地并如实计数）。 */
  'transcript.glossary.importPack': async (payload: Payload, ctx: IpcContext) => {
    const pack = transcriptPack.parseContributionPack(payload?.pack ?? payload);
    if (!pack) throw new Error('transcript glossary: invalid contribution pack');
    return transcriptPack.applyContributionPack(ctx.userId, pack);
  },

  /** 检索前 query 同义改写开关（方案 §五 P2-3，默认关）。 */
  'transcript.queryRewrite.set': async (payload: Payload, ctx: IpcContext) => ({
    enabled: transcriptGlossary.setQueryRewrite(ctx.userId, payload?.enabled === true),
  }),

  'transcript.queryRewrite.status': async (_payload: Payload, ctx: IpcContext) => ({
    enabled: transcriptGlossary.isQueryRewriteEnabled(ctx.userId),
  }),

  /**
   * 检索命中对比（方案 §五 P2-4 / §8.1-9 Richard 原话要求）：
   * 同一份知识库里"搜错形"与"搜正确写法"各命中多少，如实并列（自测口径，不宣称因果）。
   */
  'transcript.query.compare': async (payload: Payload, ctx: IpcContext) => {
    const query = requireText(payload?.query, 'query', 500);
    const k = typeof payload?.k === 'number' ? Math.max(1, Math.min(50, Math.floor(payload.k))) : 10;
    const rewrite = transcriptQuery.rewriteQuery(ctx.userId, query, { enabled: true });
    const [before, after] = await Promise.all([
      cogseedKbManager.search(ctx.userId, query, { k }),
      rewrite.changed
        ? cogseedKbManager.search(ctx.userId, rewrite.rewritten, { k })
        : Promise.resolve(null),
    ]);
    // cogseedKbManager.search 返回的就是命中数组（VecSearchHit[]），这里只数条数
    const countOf = (result: unknown): number => (Array.isArray(result) ? result.length : 0);
    return {
      query,
      rewritten: rewrite.rewritten,
      applied: rewrite.applied,
      beforeHits: countOf(before),
      afterHits: countOf(after),
      compareAvailable: rewrite.changed,
    };
  },

  'transcript.glossary.setOwnerNote': async (payload: Payload, ctx: IpcContext) => ({
    ownerNote: transcriptGlossary.setOwnerNote(ctx.userId, typeof payload?.note === 'string' ? payload.note : ''),
  }),

  'transcript.glossary.upsert': async (payload: Payload, ctx: IpcContext) => {
    const result = transcriptGlossary.upsertEntry(ctx.userId, payload ?? {});
    return result;
  },

  'transcript.glossary.setStatus': async (payload: Payload, ctx: IpcContext) => ({
    entry: transcriptGlossary.setEntryStatus(
      ctx.userId,
      requireText(payload?.id, 'id', 128),
      payload?.status === 'paused' ? 'paused' : 'active',
    ),
  }),

  'transcript.glossary.delete': async (payload: Payload, ctx: IpcContext) => ({
    deleted: transcriptGlossary.deleteEntry(ctx.userId, requireText(payload?.id, 'id', 128)),
  }),

  'transcript.glossary.import': async (payload: Payload, ctx: IpcContext) => ({
    ...transcriptGlossary.importGlossary(ctx.userId, payload?.payload ?? payload, {
      mode: payload?.mode === 'replace' ? 'replace' : 'merge',
    }),
  }),

  'transcript.glossary.export': async (payload: Payload, ctx: IpcContext) => ({
    bundle: transcriptGlossary.exportGlossary(ctx.userId, { includePeople: payload?.includePeople === true }),
  }),

  /**
   * 本体/记忆接线（P1）。**只读来源 + 只写词表一个字段**：
   *   - 来源（本体分组/长期记忆）为空时如实返回 0，不造占位数据；
   *   - 反哺走既有候选池 addCandidate（candidate_id 幂等），默认开启，
   *     面板可传 contribute:false 只做只读预览。
   */
  'transcript.glossary.syncOntology': async (payload: Payload, ctx: IpcContext) =>
    transcriptOntology.syncOntology(ctx.userId, {
      contribute: payload?.contribute !== false,
      ...(typeof payload?.minFreq === 'number' ? { minFreq: Math.max(1, Math.floor(payload.minFreq)) } : {}),
      ...(stringList(payload?.runIds, 50) ? { runIds: stringList(payload?.runIds, 50)! } : {}),
      ...(stringList(payload?.docIds, 50) ? { docIds: stringList(payload?.docIds, 50)! } : {}),
    }),

  'transcript.glossary.adoptSeed': async (payload: Payload, ctx: IpcContext) => {
    const ref = payload?.ontologyRef as { groupId?: unknown; fieldId?: unknown } | undefined;
    const groupId = optionalText(ref?.groupId, 'groupId', 200);
    const fieldId = optionalText(ref?.fieldId, 'fieldId', 200);
    const entry = transcriptOntology.adoptMissingSuggestion(ctx.userId, {
      wrong: requireText(payload?.wrong, 'wrong', 200),
      correct: requireText(payload?.correct, 'correct', 200),
      ...(payload?.kind ? { kind: payload.kind as transcriptGlossary.GlossaryKind } : {}),
      ...(groupId ? { ontologyRef: { groupId, fieldId: fieldId ?? '' } } : {}),
    });
    return { entry };
  },

  /**
   * 接受范围（方案 §七）：本文档 / 当前任务 / 全局。
   * 高危词条拒绝全局（方案 §2.2 红线），拒绝项如实回报，不静默降级。
   */
  'transcript.glossary.setScope': async (payload: Payload, ctx: IpcContext) => {
    const choice = payload?.choice === 'doc' || payload?.choice === 'task' || payload?.choice === 'global'
      ? payload.choice
      : 'keep';
    return transcriptGlossary.setScope(ctx.userId, stringList(payload?.ids, 500) ?? [], {
      choice,
      ...(optionalId(payload?.docId, 'docId') ? { docId: optionalId(payload?.docId, 'docId')! } : {}),
      ...(stringList(payload?.scenarioTags, 20) ? { scenarioTags: stringList(payload?.scenarioTags, 20)! } : {}),
    });
  },

  /** 忽略（可逆、降权）与恢复：只留痕，不删词条、不动台账。 */
  'transcript.glossary.setIgnored': async (payload: Payload, ctx: IpcContext) => ({
    updated: transcriptGlossary.setIgnored(
      ctx.userId,
      stringList(payload?.ids, 500) ?? [],
      payload?.ignored === true,
    ),
  }),

  /** 加白（误杀加白）：窗口内出现该词则整条候选静默。 */
  'transcript.glossary.addAllow': async (payload: Payload, ctx: IpcContext) => ({
    updated: transcriptGlossary.addContextAllow(
      ctx.userId,
      stringList(payload?.ids, 500) ?? [],
      requireText(payload?.term, 'term', 40),
    ),
  }),

  /** 移除一条加白（白名单静默候选，必须可撤）。 */
  'transcript.glossary.removeAllow': async (payload: Payload, ctx: IpcContext) => ({
    updated: transcriptGlossary.removeContextAllow(
      ctx.userId,
      stringList(payload?.ids, 500) ?? [],
      requireText(payload?.term, 'term', 40),
    ),
  }),

  'transcript.glossary.applyAlignment': async (payload: Payload, ctx: IpcContext) => ({
    entry: transcriptOntology.applyAlignment(
      ctx.userId,
      requireText(payload?.entryId, 'entryId', 128),
      requireText(payload?.correct, 'correct', 200),
    ),
  }),

  // ── 扫描与替换 ────────────────────────────────────────────────────────
  'transcript.correct.scan': async (payload: Payload, ctx: IpcContext) => {
    const text = requireText(payload?.text, 'text', MAX_TRANSCRIPT_CHARS);
    const entries = transcriptGlossary.listEntries(ctx.userId, { status: 'active' });
    const scan = transcriptAutoCorrect.scanText(text, entries, {
      ...(optionalId(payload?.docId, 'docId') ? { docId: optionalId(payload?.docId, 'docId')! } : {}),
      ...(stringList(payload?.scenarioTags, 20) ? { scenarioTags: stringList(payload?.scenarioTags, 20)! } : {}),
      includeDelete: payload?.includeDelete === true,
    });
    return scan;
  },

  /**
   * 疑似专名探测（只读）：找出"词表与记忆分组里都没有"的混合大小写/全大写拉丁串。
   * 保守设计（宁漏勿噪）：不产出任何替换，只给"标待核"当输入。
   */
  'transcript.correct.suspects': async (payload: Payload, ctx: IpcContext) => {
    const text = requireText(payload?.text, 'text', MAX_TRANSCRIPT_CHARS);
    const known = new Set<string>();
    for (const entry of transcriptGlossary.listEntries(ctx.userId, { status: 'active' })) {
      known.add(entry.wrong);
      known.add(entry.correct);
    }
    for (const name of transcriptOntology.collectCanonicalNames(ctx.userId)) known.add(name.name);
    const limit = typeof payload?.limit === 'number' ? Math.max(1, Math.min(500, Math.floor(payload.limit))) : 200;
    return { suspects: transcriptAutoCorrect.detectSuspectEntities(text, known, limit) };
  },

  /**
   * 主题标题候选（方案 §五 P2-2）：只提议，不改正文；用户点「采用」后
   * 才在 apply 时作为结构编辑插入 `## 标题`。
   */
  'transcript.headings.suggest': async (payload: Payload, ctx: IpcContext) => {
    const text = requireText(payload?.text, 'text', MAX_TRANSCRIPT_CHARS);
    return transcriptHeadings.suggestHeadings(ctx.userId, text, {
      sessionKey: optionalId(payload?.docId, 'docId'),
    });
  },

  /**
   * 受约束 LLM 候选（方案 §五 P2-1）：只问"疑似专名"，只认白名单目标，
   * 低置信只进待确认。**不自动替换**——替换照旧走 apply 的护栏与风险分级。
   */
  'transcript.correct.llmCandidates': async (payload: Payload, ctx: IpcContext) => {
    const text = requireText(payload?.text, 'text', MAX_TRANSCRIPT_CHARS);
    const entries = transcriptGlossary.listEntries(ctx.userId, { status: 'active' });
    const known = new Set<string>();
    for (const entry of entries) {
      known.add(entry.wrong);
      known.add(entry.correct);
    }
    const canonical = transcriptOntology.collectCanonicalNames(ctx.userId);
    for (const name of canonical) known.add(name.name);
    const suspects = transcriptAutoCorrect.detectSuspectEntities(text, known, transcriptLlm.LLM_CANDIDATE_MAX_SUSPECTS);
    // 白名单 = 词表正确写法 + 记忆分组字段值（**不含**投影里的结构标签）
    const allowed = [
      ...entries.filter((e) => e.action !== 'delete').map((e) => e.correct),
      ...canonical.filter((n) => n.source === 'ontology' && n.seedKind !== 'field' && n.seedKind !== 'group').map((n) => n.name),
    ].filter((value) => !!value && value.length <= 60);
    const result = await transcriptLlm.generateCandidates(
      ctx.userId,
      suspects.map((suspect) => ({
        text: suspect.text,
        context: text.slice(Math.max(0, suspect.span.start - 30), Math.min(text.length, suspect.span.end + 30)).replace(/\n/g, ' '),
        start: suspect.span.start,
      })),
      allowed,
      { sessionKey: optionalId(payload?.docId, 'docId') },
    );
    return {
      ...result,
      suspects: suspects.map((suspect) => ({ text: suspect.text, span: suspect.span })),
      allowedCount: allowed.length,
    };
  },

  /**
   * 替换入口。注意三件事：
   *   1. `acceptedIds` 缺省时只接受 low/medium 风险候选；high 一律进 pending。
   *   2. **不写回任何文档**：产出清理版 + run 快照，调用方决定落地位置。
   *   3. 接受后按词条追加台账（只追加），freq +1。
   */
  'transcript.correct.apply': async (payload: Payload, ctx: IpcContext) => {
    const text = requireText(payload?.text, 'text', MAX_TRANSCRIPT_CHARS);
    const docId = requireText(payload?.docId, 'docId', 200);
    const scenarioTags = stringList(payload?.scenarioTags, 20);
    const entries = transcriptGlossary.listEntries(ctx.userId, { status: 'active' });
    const scan = transcriptAutoCorrect.scanText(text, entries, {
      docId,
      ...(scenarioTags ? { scenarioTags } : {}),
      includeDelete: payload?.includeDelete === true,
    });
    const acceptedIds = stringList(payload?.acceptedIds, 1000);
    // 同人段落合并（方案 §五 P1-2）：合并 = 编辑集（删冗余块头 + 插时间区间），
    // 因此走同一条替换/偏移/回滚流水线，而不是第二套改写逻辑。
    const merge = payload?.mergeSpeaker === true
      ? transcriptMerge.mergeSpeakerEdits(text)
      : null;
    const mergeCandidates: transcriptAutoCorrect.CorrectionCandidate[] = merge
      ? merge.edits.map((edit, index) => ({
        entryRef: `merge_${index}`,
        wrong: edit.wrong,
        correct: edit.correct,
        action: edit.action,
        confidence: 1,
        riskLevel: 'low' as const,
        context: '',
        span: edit.span,
        ignoredCount: 0,
        contextAllow: [],
        // 结构编辑：不计入口癖删除统计（否则 355 个块头会占满 deletedFillers）
        structure: true,
      }))
      : [];
    // 主题标题（方案 §五 P2-2）：只在用户显式采用后才插入，且是结构编辑
    const headingInputs = Array.isArray(payload?.headings) ? payload.headings.slice(0, 50) : [];
    // 标题要插在"这一段的开头"。但同人段落合并会删掉冗余块头，锚点若落在被删的块头里
    // 就会被 apply 当成已消费而**静默丢弃**（真机踩过：采用 3 个只进 1 个）。
    // 这里把锚点挪到该段之后，标题照旧插在这一段前面。
    const deletedSpans = merge
      ? merge.edits.filter((edit) => edit.action === 'delete').map((edit) => edit.span)
      : [];
    const anchorFor = (start: number): number => {
      let at = start;
      for (const span of deletedSpans) {
        if (at >= span.start && at <= span.end) at = Math.max(at, span.end);
      }
      return at;
    };
    const headingCandidates: transcriptAutoCorrect.CorrectionCandidate[] = headingInputs
      .map((raw, index) => {
        const item = raw as Partial<{ start: number; title: string }>;
        const rawStart = typeof item?.start === 'number' ? Math.max(0, Math.min(Math.floor(item.start), text.length)) : -1;
        const start = rawStart >= 0 ? anchorFor(rawStart) : -1;
        const title = typeof item?.title === 'string' ? item.title.trim().slice(0, 60) : '';
        if (start < 0 || !title) return null;
        return {
          entryRef: `heading_${index}`,
          wrong: '',
          correct: `## ${title}\n`,
          action: 'replace' as const,
          confidence: 1,
          riskLevel: 'low' as const,
          context: '',
          span: { start, end: start },
          ignoredCount: 0,
          contextAllow: [],
          structure: true,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    const allCandidates = [...scan.candidates, ...mergeCandidates, ...headingCandidates];
    const syntheticRefs = [...mergeCandidates, ...headingCandidates].map((c) => c.entryRef);
    const acceptedAll = syntheticRefs.length
      ? [...(acceptedIds ?? []), ...syntheticRefs]
      : acceptedIds;
    const applied0 = transcriptAutoCorrect.applyCorrections(text, allCandidates, {
      ...(acceptedAll ? { acceptedIds: acceptedAll } : {}),
      ...(riskLevels(payload?.acceptRiskLevels) ? { acceptRiskLevels: riskLevels(payload?.acceptRiskLevels)! } : {}),
    });
    // 未决项（方案 §4.3/§8.1-7）：用户标的 span 在**原文**坐标系，先按偏移映射
    // 落到清理版，再插「【转写存疑】」。有未决项时 createRun 会把产物标 draft。
    const { result, issues } = withIssueMarkers(applied0, issueInputs(payload?.issues));
    const params = {
      glossaryVersion: 2,
      ...(optionalText(payload?.fillerRulePack, 'fillerRulePack', 40)
        ? { fillerRulePack: optionalText(payload?.fillerRulePack, 'fillerRulePack', 40)! }
        : {}),
      ...(payload?.params && typeof payload.params === 'object' ? (payload.params as Record<string, unknown>) : {}),
    };
    const run = transcriptRuns.createRun(ctx.userId, {
      docId,
      sourceText: text,
      ...(issues.length ? { issues } : {}),
      ...(optionalText(payload?.sourcePath, 'sourcePath', 500)
        ? { sourcePath: optionalText(payload?.sourcePath, 'sourcePath', 500)! }
        : {}),
      result,
      params,
      mergedBlocks: merge ? merge.blocksAfter : 0,
      ...(merge ? { anchors: merge.anchors } : {}),
    });
    transcriptGlossary.recordReplacement(
      ctx.userId,
      result.applied.map((a) => a.entryRef),
      { docId, runId: run.runId },
    );
    return { run, result, denied: scan.denied };
  },

  // ── 产物 ──────────────────────────────────────────────────────────────
  'transcript.run.list': async (payload: Payload, ctx: IpcContext) => ({
    runs: transcriptRuns.listRuns(ctx.userId, {
      ...(optionalId(payload?.docId, 'docId') ? { docId: optionalId(payload?.docId, 'docId')! } : {}),
    }),
  }),

  'transcript.run.get': async (payload: Payload, ctx: IpcContext) => {
    const runId = requireText(payload?.runId, 'runId', 128);
    return {
      run: transcriptRuns.getRun(ctx.userId, runId),
      before: transcriptRuns.readRunText(ctx.userId, runId, 'before'),
      after: transcriptRuns.readRunText(ctx.userId, runId, 'after'),
      offsetMap: transcriptRuns.readOffsetMap(ctx.userId, runId),
    };
  },

  'transcript.run.report': async (payload: Payload, ctx: IpcContext) => ({
    report: transcriptRuns.buildReport(ctx.userId, requireText(payload?.runId, 'runId', 128)),
  }),

  /**
   * 清理附记（方案 §五 P1-3 / §七）：术语对照表 + 口癖删除 + 未决项 +
   * 上下文材料 + 本次参数，渲染成 Markdown 供预览与另存。
   */
  'transcript.run.notes': async (payload: Payload, ctx: IpcContext) => {
    const runId = requireText(payload?.runId, 'runId', 128);
    const report = transcriptRuns.buildReport(ctx.userId, runId);
    return { markdown: transcriptRuns.renderRunNotes(report), report };
  },

  /** 追加"清理版已另存到某路径"的交付记录（只追加，供审计反查）。 */
  'transcript.run.annotate': async (payload: Payload, ctx: IpcContext) => ({
    run: transcriptRuns.annotateRun(ctx.userId, requireText(payload?.runId, 'runId', 128), {
      kind: payload?.kind,
      path: requireText(payload?.path, 'path', 500),
    }),
  }),

  /** 回滚只**返回**原文与校验结果，不写任何文档。 */
  'transcript.run.revert': async (payload: Payload, ctx: IpcContext) =>
    transcriptRuns.revertRun(ctx.userId, requireText(payload?.runId, 'runId', 128)),

  // ── 未决项（待核）────────────────────────────────────────────────────
  'transcript.issues.list': async (payload: Payload, ctx: IpcContext) => ({
    issues: transcriptRuns.listIssues(ctx.userId, {
      ...(optionalId(payload?.runId, 'runId') ? { runId: optionalId(payload?.runId, 'runId')! } : {}),
      ...(payload?.status === 'open' || payload?.status === 'resolved' ? { status: payload.status } : {}),
    }),
  }),

  'transcript.issues.resolve': async (payload: Payload, ctx: IpcContext) => ({
    issue: transcriptRuns.resolveIssue(
      ctx.userId,
      requireText(payload?.runId, 'runId', 128),
      requireText(payload?.issueId, 'issueId', 128),
      typeof payload?.resolution === 'string' ? payload.resolution : '',
    ),
  }),
};
