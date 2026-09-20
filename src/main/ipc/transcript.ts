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
import * as transcriptMetrics from '../features/transcript_metrics';
import * as transcriptDocTags from '../features/transcript_doc_tags';
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
   * 装入方案附 A 的初始词表种子（幂等）。`for → Foo` 等方案明写"默认不入册"
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
   * 检索命中对比（方案 §五 P2-4 / §8.1-9 人工基线要求）：
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
    // cogseedKbManager.search 返回 VecSearchHit[]。**只数条数会骗人**：库里同时有
    // 原稿与清理版时两边都能命中、数字打平。真正有信息量的是"命中了哪些来源"——
    // 搜错形只该找到原稿，搜正确写法只该找到清理版（这才说明改写解决了"搜不到"）。
    const hitsOf = (result: unknown): Array<{ sourceId: string; title: string }> => {
      if (!Array.isArray(result)) return [];
      // VecSearchHit: { file_id, rel_path, kind, chunk_idx, title, content, score, distance }
      return (result as Array<Record<string, unknown>>).map((hit) => ({
        sourceId: String(hit?.rel_path ?? hit?.file_id ?? ''),
        title: String(hit?.title ?? ''),
      }));
    };
    // 标题就是"命中片段的标题"（KB 入库时取该段首行）→ 截断，且**每侧最多留 2 条**
    // （留 5 条会让附记表格变成一整段难读的长文本）
    const titlesOf = (hits: Array<{ sourceId: string; title: string }>): string[] => {
      const out: string[] = [];
      for (const hit of hits) {
        const raw = (hit.title || hit.sourceId).replace(/\s+/g, ' ').trim();
        if (!raw) continue;
        const label = raw.length > 24 ? `${raw.slice(0, 24)}…` : raw;
        if (!out.includes(label)) out.push(label);
      }
      return out.slice(0, 2);
    };
    const beforeHits = hitsOf(before);
    const afterHits = hitsOf(after);
    return {
      query,
      rewritten: rewrite.rewritten,
      applied: rewrite.applied,
      beforeHits: beforeHits.length,
      afterHits: afterHits.length,
      beforeSources: titlesOf(beforeHits),
      afterSources: titlesOf(afterHits),
      /** 命中来源是否确实不同（改写带来"搜得到"的证据；0/0 时无意义）。 */
      sourcesDiffer: rewrite.changed
        && beforeHits.length > 0
        && afterHits.length > 0
        && titlesOf(beforeHits).join('|') !== titlesOf(afterHits).join('|'),
      compareAvailable: rewrite.changed,
    };
  },

  /**
   * 本地埋点（方案 §8.2「可选埋点，本地」）：确认耗时与保留率。
   * 只写本机 `<uid>/local/…/metrics.jsonl`，不联网、不上报；
   * 测不了的指标在 summary 里如实列出 `notMeasurable`，不编数字。
   */
  'transcript.metrics.record': async (payload: Payload, ctx: IpcContext) => {
    const docId = optionalId(payload?.docId, 'docId') ?? '';
    if (payload?.kind === 'confirm_latency') {
      transcriptMetrics.recordConfirmLatency(ctx.userId, {
        ms: Number(payload?.ms) || 0,
        docId,
        rows: Number(payload?.rows) || 0,
        accepted: Number(payload?.accepted) || 0,
      });
    } else if (payload?.kind === 'retention') {
      transcriptMetrics.recordRetention(ctx.userId, {
        retention: Number(payload?.retention) || 0,
        charsIn: Number(payload?.charsIn) || 0,
        charsOut: Number(payload?.charsOut) || 0,
        overRewrite: payload?.overRewrite === true,
        docId,
      });
    } else {
      throw new Error('transcript metrics: unknown kind');
    }
    return { ok: true };
  },

  'transcript.metrics.summary': async (_payload: Payload, ctx: IpcContext) => ({
    summary: transcriptMetrics.summarizeMetrics(
      transcriptMetrics.readEvents(ctx.userId),
      transcriptGlossary.listEntries(ctx.userId, { status: 'active' }).length,
    ),
  }),

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

  /**
   * 转写文档的「场景标签」读 / 写 / 建议 —— 「仅本场景」这条作用域的前置数据。
   *
   * 为什么放在这里：`transcript.correct.scan` / `.apply` / `transcript.glossary.setScope`
   * 都收 `scenarioTags`，但此前渲染层没有任何来源可传（面板 ctx 里恒为空），于是
   * 「仅本场景」永远置灰、带场景标签的词条也永远命中不了。这三条把"文档 → 标签"
   * 补上：面板读它、写它，扫描/接受时带上它。
   */
  'transcript.docTags.get': async (payload: Payload, ctx: IpcContext) => {
    const docId = optionalId(payload?.docId, 'docId');
    if (!docId) return { ok: false, error: 'missing docId', tags: [] as string[] };
    return { ok: true, docId, tags: transcriptDocTags.readTagsForDoc(ctx.userId, docId) };
  },
  'transcript.docTags.set': async (payload: Payload, ctx: IpcContext) => {
    const docId = optionalId(payload?.docId, 'docId');
    if (!docId) return { ok: false, error: 'missing docId' };
    return transcriptDocTags.setTagsForDoc(ctx.userId, docId, payload?.tags);
  },
  'transcript.docTags.suggest': async (_payload: Payload, ctx: IpcContext) => ({
    ok: true,
    tags: await transcriptDocTags.suggestScenarioTags(ctx.userId),
  }),

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
  /**
   * 扫描 = **一个候选清单**：词表命中（含作用域/护栏/口癖）+ 可选的模型复核。
   *
   * `includeReview: true` 时再让模型读一遍正文，把它的建议转成同构候选
   * （`entryRef: model_<i>`、`fromModel: true`、`riskLevel: 'medium'`）**追加在
   * 同一个列表后面**——不另开一套 UI，也没有第二条"待核"状态线。
   *
   * 风险等级给 `medium` 的用意：面板只预勾 `low`，所以模型建议**永远不会被预勾**，
   * 必须逐条人工确认；同时它又不算"未处理的高危候选"，不会把产物误标成 draft。
   */
  'transcript.correct.scan': async (payload: Payload, ctx: IpcContext) => {
    const text = requireText(payload?.text, 'text', MAX_TRANSCRIPT_CHARS);
    const docId = optionalId(payload?.docId, 'docId');
    const scenarioTags = stringList(payload?.scenarioTags, 20);
    const entries = transcriptGlossary.listEntries(ctx.userId, { status: 'active' });
    const scan = transcriptAutoCorrect.scanText(text, entries, {
      ...(docId ? { docId } : {}),
      ...(scenarioTags ? { scenarioTags } : {}),
      includeDelete: payload?.includeDelete === true,
    });
    if (payload?.includeReview !== true) return { ...scan, review: null };

    // 优先参考名单 = 词表正确写法 + 记忆分组字段值（不含投影里的结构标签）
    const known = new Set<string>();
    for (const entry of entries) {
      known.add(entry.wrong);
      known.add(entry.correct);
    }
    const canonical = transcriptOntology.collectCanonicalNames(ctx.userId);
    for (const name of canonical) known.add(name.name);
    const allowed = [
      ...entries.filter((e) => e.action !== 'delete').map((e) => e.correct),
      ...canonical.filter((n) => n.source === 'ontology' && n.seedKind !== 'field' && n.seedKind !== 'group').map((n) => n.name),
    ].filter((value) => !!value && value.length <= 60);
    // 词形可疑的位置只作为"重点线索"提示模型，不决定要不要问
    const hints = transcriptAutoCorrect
      .detectSuspectEntities(text, known, transcriptLlm.LLM_CANDIDATE_MAX_HINTS)
      .map((suspect) => ({ text: suspect.text, start: suspect.span.start }));
    const review = await transcriptLlm.generateReviewCandidates(ctx.userId, text, {
      knownTargets: allowed,
      hints,
      sessionKey: docId,
    });
    const modelCandidates: transcriptAutoCorrect.CorrectionCandidate[] = review.candidates.map((candidate, index) => ({
      entryRef: `model_${index}`,
      wrong: candidate.wrong,
      correct: candidate.correct,
      action: 'replace' as const,
      confidence: candidate.confidence,
      riskLevel: 'medium' as const,
      context: candidate.reason,
      span: { start: candidate.start, end: candidate.start + candidate.wrong.length },
      ignoredCount: 0,
      contextAllow: [],
      fromModel: true,
    }));
    return {
      ...scan,
      candidates: [...scan.candidates, ...modelCandidates],
      stats: {
        ...scan.stats,
        candidates: scan.candidates.length + modelCandidates.length,
      },
      review: {
        modelCandidates: modelCandidates.length,
        chunksScanned: review.chunksScanned,
        chunksTotal: review.chunksTotal,
        truncated: review.truncated,
        failedChunks: review.failedChunks,
        outsideAllowlist: review.outsideAllowlist,
        rejected: review.rejected.length,
        skipped: review.skipped ?? '',
        knownCount: allowed.length,
      },
    };
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
    // 模型建议（方案 §五 P2-1，与扫描合并后）：按 headings 同款"合成 ref"接入，
    // 复用同一条替换/偏移/回滚管道，不另起第二套改写逻辑。
    //
    // 两条硬要求：
    //   1. **span 必须与正文逐字对上**（折叠后比较，容忍大小写/全角）。扫描到 apply
    //      之间可能重扫或换稿，旧坐标会错位——对不上就丢弃，绝不按脏坐标改正文。
    //   2. **必须显式勾选才应用**：模型候选不进 `syntheticRefs` 那套"给了就一定应用"，
    //      只能从 acceptedIds 里来；没传 acceptedIds 时一条都不应用（否则
    //      applyCorrections 的"缺省=全部非 high"会让模型建议被静默全量应用）。
    const modelInputs = Array.isArray(payload?.models) ? payload.models.slice(0, 200) : [];
    const modelCandidates: transcriptAutoCorrect.CorrectionCandidate[] = modelInputs
      .map((raw, index): transcriptAutoCorrect.CorrectionCandidate | null => {
        const item = raw as Partial<{ start: unknown; wrong: unknown; correct: unknown; confidence: unknown; reason: unknown }>;
        const start = typeof item?.start === 'number' && Number.isFinite(item.start)
          ? Math.max(0, Math.min(Math.floor(item.start), text.length))
          : -1;
        const wrong = typeof item?.wrong === 'string' ? item.wrong.trim() : '';
        const correct = typeof item?.correct === 'string' ? item.correct.trim() : '';
        if (start < 0 || !wrong || !correct) return null;
        const end = start + wrong.length;
        if (end > text.length) return null;
        if (transcriptGlossary.foldText(text.slice(start, end)) !== transcriptGlossary.foldText(wrong)) return null;
        const confidenceRaw = Number(item?.confidence);
        return {
          entryRef: `model_${index}`,
          wrong,
          correct,
          action: 'replace' as const,
          confidence: Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0,
          // medium：不预勾（面板只预勾 low），但也不计进"未处理高危"。
          riskLevel: 'medium' as const,
          context: typeof item?.reason === 'string' ? item.reason.slice(0, 200) : '',
          span: { start, end },
          ignoredCount: 0,
          contextAllow: [] as string[],
        };
      })
      .filter((item): item is transcriptAutoCorrect.CorrectionCandidate => item !== null);
    const droppedModels = modelInputs.length - modelCandidates.length;

    const allCandidates = [...scan.candidates, ...mergeCandidates, ...headingCandidates, ...modelCandidates];
    const syntheticRefs = [...mergeCandidates, ...headingCandidates].map((c) => c.entryRef);
    const acceptedAll = syntheticRefs.length
      ? [...(acceptedIds ?? []), ...syntheticRefs]
      : (acceptedIds ?? (modelCandidates.length ? [] : undefined));
    const applied0 = transcriptAutoCorrect.applyCorrections(text, allCandidates, {
      ...(acceptedAll ? { acceptedIds: acceptedAll } : {}),
      ...(riskLevels(payload?.acceptRiskLevels) ? { acceptRiskLevels: riskLevels(payload?.acceptRiskLevels)! } : {}),
    });
    const result = applied0;
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
    // 「勾选并应用 = 确认」：把**真的被应用**的模型建议记进词表（source: meeting_accept，
    // 作用域收窄到本文档）。只认 result.applied——勾了但被护栏挡掉的不算确认。
    // 词表命中的候选（g_*）本来就在表里，这里的 ref 只筛 model_*。
    const appliedModelRefs = new Set(result.applied.map((a) => a.entryRef));
    const confirmedPairs = modelCandidates
      .filter((candidate) => appliedModelRefs.has(candidate.entryRef))
      .map((candidate) => ({ wrong: candidate.wrong, correct: candidate.correct }));
    const glossaryWrites = transcriptGlossary.rememberConfirmedPairs(ctx.userId, confirmedPairs, { docId });
    return { run, result, denied: scan.denied, glossaryWrites, droppedModels };
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

  /** 记录一次检索命中对比（只追加，见 P0-5"记录替换前/后检索命中数"）。 */
  'transcript.run.recordSearchCompare': async (payload: Payload, ctx: IpcContext) => ({
    run: transcriptRuns.recordSearchCompare(
      ctx.userId,
      requireText(payload?.runId, 'runId', 128),
      {
        query: requireText(payload?.query, 'query', 500),
        rewritten: typeof payload?.rewritten === 'string' ? payload.rewritten : '',
        beforeHits: Number(payload?.beforeHits) || 0,
        afterHits: Number(payload?.afterHits) || 0,
        ...(stringList(payload?.beforeSources, 5) ? { beforeSources: stringList(payload?.beforeSources, 5)! } : {}),
        ...(stringList(payload?.afterSources, 5) ? { afterSources: stringList(payload?.afterSources, 5)! } : {}),
        applied: Array.isArray(payload?.applied)
          ? (payload.applied as Array<{ wrong?: unknown; correct?: unknown; count?: unknown }>).map((item) => ({
            wrong: String(item?.wrong ?? ''),
            correct: String(item?.correct ?? ''),
            count: Number(item?.count) || 0,
          }))
          : [],
      },
    ),
  }),

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

};
