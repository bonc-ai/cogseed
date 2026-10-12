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
 *                                      （+rejectedIds 拒绝回执 / +receipts，specs/013 T028）
 *   transcript.correct.unreject    —— 撤销拒绝（被拒抑制可逆，specs/013 T032）
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
import * as meetingMetrics from '../features/meeting_metrics';
import * as transcriptDocTags from '../features/transcript_doc_tags';
import * as transcriptRecall from '../features/transcript_recall';
import * as meetingDoc from '../features/meeting_doc';
import * as meetingRefs from '../features/meeting_refs';
import { cognitionContextFileSourceId } from '../features/recall/source-catalog';
import { listRecallCandidates, saveRecallCandidate } from '../features/recall/candidate-service';
import { safeId } from '../storage';
import {
  isCandidateSuppressed,
  listReviewDecisions,
  writeReviewDecision,
} from '../features/cognition/review-decision';
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

/**
 * 模型候选的 ref：优先用渲染层带回的扫描期 ref（`model_<n>`），拿不到/形状不对才按数组下标兜底。
 *
 * 为什么必须认它：`acceptedIds` 由面板按扫描期的 ref 传上来，若主进程按 payload 下标重编
 * `model_<i>`，只勾了第 2 条时就会"勾的是 model_1、建的是 model_0"，勾选的建议既没进正文、
 * 也没被记进词表，且不报错（真机："模型建议接受了进不了词汇表"）。
 *
 * 为什么限制形状：这个 ref 会进 `recordReplacement` 的 `replacedIn` 台账，
 * 不能允许渲染层用一个像词表条目 id（`g_*`）的值来冒充，所以只认 `model_<数字>`。
 */
function modelEntryRefFor(value: unknown, index: number): string {
  if (typeof value === 'string' && /^model_\d{1,4}$/.test(value)) return value;
  return `model_${index}`;
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

/**
 * 【specs/013 T021】scan 返回体的降级如实标注（与 `MeetingDocRef.degraded` 同口径）：
 * 只记"缺什么"（无说话人 / 无场景标签 / 没跑过纠错 run），不编造定位——
 * 界面文案（渲染层后续任务）按码出"缺失说明"，不得猜说话人或位置。
 */
function scanDegraded(
  userId: string,
  info: { speakers?: string[]; scenarioTags?: string[]; docId?: string },
): string[] {
  const degraded: string[] = [];
  if (!info.speakers?.length) degraded.push('no_speakers');
  if (!info.scenarioTags?.length) degraded.push('no_scenario_tags');
  // 没有 docId 时无从关联任何 run，与"没跑过 run"同按缺失如实记。
  if (!info.docId || transcriptRuns.listRuns(userId, { docId: info.docId }).length === 0) {
    degraded.push('no_transcript_run');
  }
  return degraded;
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

  // 候选区（待核）的 IPC（candidates / adoptCandidate / discardCandidate / clearCandidates）
  // 已随「模型建议并入扫描」整体移除：模型候选现在是扫描结果里的一行，勾选即确认。
  // 见 src/main/features/transcript_glossary.ts 顶部说明与 dev/cx677-candidate-gate 的设计。

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
    // 【specs/013 T020】情景信号进扫描：说话人由主进程用 parseTranscriptBlocks 现算
    // （meeting_doc.computeSpeakers：去重保序 ≤50；不由渲染层传，防已发生的时钟格式
    // 漂移事故）；topic 由调用方透传。两者只进 ScanOptions 的展示位，
    // **不参与 scopeAllows**（作用域语义不动）。
    const speakers = meetingDoc.computeSpeakers(text);
    const topic = optionalText(payload?.topic, 'topic', 200);
    const entries = transcriptGlossary.listEntries(ctx.userId, { status: 'active' });
    const scan = transcriptAutoCorrect.scanText(text, entries, {
      ...(docId ? { docId } : {}),
      ...(scenarioTags ? { scenarioTags } : {}),
      ...(speakers ? { speakers } : {}),
      ...(topic ? { topic } : {}),
      includeDelete: payload?.includeDelete === true,
    });
    // 【specs/013 T008】本体规范名进纠错依据（FR-001）：只读调既有
    // transcriptOntology.collectCanonicalNames，把规范名喂进依据（追加
    // { source:'ontology', name, groupId?, fieldId? } 并列依据）；未命中的候选
    // 原样保留。下方 includeReview 分支的 allow 名单构造零改动（各用各的读）。
    const canonical = transcriptOntology.collectCanonicalNames(ctx.userId);
    // 【specs/013 T016】字面行显式标 channel:'exact'（类型缺省同值；面板要能直接
    // 读通道来源，合并去重与 byChannel 统计也以此口径为准）。
    let candidates: transcriptAutoCorrect.CorrectionCandidate[] = transcriptAutoCorrect
      .attachOntologyRefs(scan.candidates, canonical)
      .map((c) => ({ ...c, channel: 'exact' as const }));

    // 【specs/013 T015】召回通道并入扫描（FR-012 前半）：`includeRecall` 缺省 false，
    // 不传时一次 recallCandidates 都不调（照 includeReview 的"不点不花钱"先例）。
    // 召回候选转成同构 CorrectionCandidate（channel:'recall'、原样 confidence 与
    // disposition；confidence 恒 < 1 由 MAX_RECALL_CONFIDENCE = 0.99 结构性保证），
    // 经 mergeRecallCandidates（T016）与字面命中合并去重后**追加在同一清单**——
    // 不新开面板、不新增第二条状态线。
    let recallRows = 0;
    let recallSummary: {
      candidates: number;
      byChannel: Record<transcriptRecall.RecallChannel, number>;
      abandoned: Array<{ surface: string; count: number }>;
      merged: number;
    } | undefined;
    if (payload?.includeRecall === true) {
      const recall = transcriptRecall.recallCandidates(text, entries, {
        ...(docId ? { docId } : {}),
        ...(scenarioTags ? { scenarioTags } : {}),
        // 域内概念 = 本体规范名（suggest 升级的既有判据；脱域一律 review）
        domainTerms: canonical.map((item) => item.name),
      });
      const entryById = new Map(entries.map((e) => [e.id, e] as const));
      const recallCandidatesList: transcriptAutoCorrect.CorrectionCandidate[] = recall.candidates.map((r) => ({
        entryRef: r.entryRef,
        wrong: r.wrong,
        correct: r.correct,
        action: 'replace' as const,
        confidence: r.confidence,
        riskLevel: r.riskLevel,
        context: r.context,
        span: r.span,
        ignoredCount: entryById.get(r.entryRef)?.ignoredCount ?? 0,
        contextAllow: entryById.get(r.entryRef)?.contextAllow ?? [],
        channel: 'recall' as const,
        disposition: r.disposition,
        refs: [{
          source: 'glossary' as const,
          entryId: r.entryRef,
          kind: r.kind,
          freq: entryById.get(r.entryRef)?.freq ?? 0,
        }],
      }));
      // 【specs/013 T016】合并去重（D5）：同 span 已在字面命中 → 召回条目不出行、
      // 只把词条依据并入该行 refs（并列依据）；其余重叠复用既有消解规则
      // （通道优先 → 长 span → freq → 靠前），IPC 层不重算。
      const merged = transcriptAutoCorrect.mergeRecallCandidates(candidates, recallCandidatesList);
      candidates = merged.candidates;
      recallRows = merged.candidates.filter((c) => c.channel === 'recall').length;
      // 【specs/013 T017】召回统计如实透出：byChannel 四键（recall 内部消解后计数）、
      // abandoned = 兜不住的孤立形态（residual，只报形态不给映射）；merged = 并入
      // 既有行 refs 未出行的条数。truncated 沿用既有语义（字面候选打满上限即 true）。
      recallSummary = {
        candidates: recallRows,
        byChannel: recall.stats.byChannel,
        abandoned: recall.stats.residual,
        merged: merged.merged,
      };
    }

    // 【specs/013 T027】资产规范名进纠错依据（FR-001）：本会议已挂载的资产，
    // 其规范名（statement ‖ title）参与依据来源——只读调 meeting_refs 的清单
    // （version/title 取挂载时的**冻结版**，非当前版），命中候选追加
    // { source:'asset', assetId, version, title } 并列依据（形态对齐
    // attachOntologyRefs；未挂载/未命中 ⇒ 原样返回，行为零变化）。
    // 放在 recall 合并之后：同 span 并入的召回行与字面行走同一套依据追加。
    if (docId) {
      const assetNames = await meetingRefs.listMeetingAssetCanonicalNames(ctx.userId, docId);
      candidates = meetingRefs.attachAssetRefs(candidates, assetNames);
    }

    // 【specs/013 T029】拒绝后不再重复建议（FR-001 后半）：读**既有**回执账本的
    // 末条判定（isCandidateSuppressed 同款口径，review-decision.ts:246-253——
    // 不新写第二套抑制判据、不新增标记位），被拒形态的候选不出行。target_ref
    // 与 T028 写入侧同构：meeting:<docId>:<entryRef>。账本落盘 ⇒ 跨进程重启后
    // 仍生效；撤销（T032 的 unreject 通道）/新决定覆盖（既有 accept 语义）后
    // 末条不再是抑制态，行为与既有口径一致。模型候选（model_<i>，次序不稳定）
    // 不做抑制查询；引例只读行不是建议，也不滤。
    let suppressedRows = 0;
    if (docId) {
      const entryRefs = [...new Set(candidates.map((c) => c.entryRef))];
      const suppressedByRef = new Map<string, boolean>();
      await Promise.all(entryRefs.map(async (entryRef) => {
        suppressedByRef.set(
          entryRef,
          await isCandidateSuppressed(ctx.userId, `meeting:${docId}:${entryRef}`),
        );
      }));
      const before = candidates.length;
      candidates = candidates.filter((c) => !suppressedByRef.get(c.entryRef));
      suppressedRows = before - candidates.length;
      if (recallSummary && suppressedRows) {
        recallSummary = {
          ...recallSummary,
          candidates: candidates.filter((c) => c.channel === 'recall').length,
        };
      }
    }
    // 过滤后的通道计数如实重算（byChannel 不再引用过滤前的 scan.candidates.length）。
    const exactKept = candidates.filter((c) => c.channel !== 'recall').length;
    const recallKept = candidates.length - exactKept;

    // 【specs/013 T019】引例降级的可解释只读提示行（FR-011）：把 scanText 记下的
    // denied:quoted_example 转成 candidates 里 disposition:'quoted_example' 的只读
    // 条目（带命中标记词 quotedBy），追加在清单尾部——不是候选，不进 stats.candidates。
    const quotedRows = transcriptAutoCorrect.quotedExampleRows(text, scan.denied, entries);
    // 【specs/013 T021】降级如实标注（无说话人/无场景标签/没跑过 run）。
    const degraded = scanDegraded(ctx.userId, { speakers, scenarioTags, docId });

    if (payload?.includeReview !== true) {
      return {
        ...scan,
        candidates: [...candidates, ...quotedRows],
        stats: {
          ...scan.stats,
          // 口径：可替换候选数（字面 + 召回；不含引例只读行——它是提示不是候选）
          candidates: candidates.length,
          byChannel: { exact: exactKept, recall: recallKept, model: 0 },
          quotedExample: quotedRows.length,
          // 【specs/013 T029】被拒抑制滤掉的行数（如实透出：候选变少要有解释）
          suppressed: suppressedRows,
        },
        ...(recallSummary ? { recall: recallSummary } : {}),
        degraded,
        review: null,
      };
    }

    // 优先参考名单 = 词表正确写法 + 记忆分组字段值（不含投影里的结构标签）
    const known = new Set<string>();
    for (const entry of entries) {
      known.add(entry.wrong);
      known.add(entry.correct);
    }
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
    // 【specs/013 T056】token 采集落点（FR-009）：模型复核返回 usage 时落
    // meeting_model_usage 事件（新文件 meeting-metrics.jsonl，不混既有 metrics.jsonl）。
    // no_model / model_failed 时 generateReviewCandidates 不带 usage 字段 ⇒ 这里
    // 一条都不写（不写 0 假装测到）；写入失败在 meeting_metrics 内部吞掉，不炸扫描。
    if (review.usage) {
      meetingMetrics.recordMeetingMetric(ctx.userId, {
        kind: 'meeting_model_usage',
        docId: docId ?? '',
        operation: 'review',
        ...(review.usage.inputTokens !== undefined ? { inputTokens: review.usage.inputTokens } : {}),
        ...(review.usage.outputTokens !== undefined ? { outputTokens: review.usage.outputTokens } : {}),
        ...(review.usage.totalTokens !== undefined ? { totalTokens: review.usage.totalTokens } : {}),
      });
    }
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
    const finalCandidates = [...candidates, ...modelCandidates];
    return {
      ...scan,
      candidates: [...finalCandidates, ...quotedRows],
      stats: {
        ...scan.stats,
        candidates: finalCandidates.length,
        byChannel: { exact: exactKept, recall: recallKept, model: modelCandidates.length },
        quotedExample: quotedRows.length,
        // 【specs/013 T029】被拒抑制滤掉的行数（如实透出：候选变少要有解释）
        suppressed: suppressedRows,
      },
      ...(recallSummary ? { recall: recallSummary } : {}),
      degraded,
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
    // 【specs/013 T028】拒绝回执（FR-001 前半）：`rejectedIds` = 用户在面板上明确
    // 拒绝的候选 entryRef。两个动作语义：
    //   1. 被拒的候选**不参与本次替换**（从候选集中剔除——即使用户没传
    //      acceptedIds 走"缺省=全部非 high"，被拒形态也不能被替换）；
    //   2. 每个（存在的）entryRef 写一条既有回执账本（writeReviewDecision，
    //      target_ref = meeting:<docId>:<entryRef>，与 T029 的抑制读口同构）。
    // 回执幂等域：缺省用本次 run 的 runId；调用方重试**同一动作**时传原 run 的
    // runId（receiptRunId），同 key 命中既有决定直接返回、不产生第二条。
    const rejectedIds = stringList(payload?.rejectedIds, 1000);
    const receiptRunId = optionalId(payload?.receiptRunId, 'receiptRunId');
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
        const item = raw as Partial<{ entryRef: unknown; start: unknown; wrong: unknown; correct: unknown; confidence: unknown; reason: unknown }>;
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
          // ref 用渲染层带回来的**扫描期** ref（acceptedIds 里放的就是它）。
          // 早先按数组下标重编 `model_<i>`，而 payload 只含被勾选的条目 → 只勾第 2 条时
          // `model_1` 与 `model_0` 对不上：勾了的建议既没进正文、也没进词表，还不报错
          // （真机："模型建议接受了进不了词汇表"）。
          entryRef: modelEntryRefFor(item?.entryRef, index),
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
    // 【specs/013 T022】apply 侧引例闸（缺省 true，默认最安全的一侧）：模型建议落在
    // 引例位（span 窗口内命中 QUOTE_MARKERS）→ 一律不接受，只有**显式**
    // excludeQuoted:false 才放行。判据与 scanText 的 T018 同一处（isQuotedExampleSpan），
    // 两侧不会"这里提示是引例、那里又照样替换"。词条路径无需再滤：scanText 的
    // 引例闸是硬闸（引例位根本不进 scan.candidates，与 excludeQuoted 取值无关）；
    // merge/heading 是结构编辑（删块头/插标题），不改引例错形本身。
    const excludeQuoted = payload?.excludeQuoted !== false;
    const quotedBlockedModels = excludeQuoted
      ? modelCandidates.filter((candidate) => transcriptAutoCorrect.isQuotedExampleSpan(text, candidate.span))
      : [];
    const applyableModels = modelCandidates.filter((candidate) => !quotedBlockedModels.includes(candidate));
    const droppedModels = modelInputs.length - modelCandidates.length + quotedBlockedModels.length;

    // 【specs/013 T028】被拒的候选不参与本次替换：只对真实存在的条目生效
    // （词表词条 id 或本次合成 ref——对齐词表侧 setIgnored "只动存在条目"
    // 的口径，不存在的 id 静默跳过、不写垃圾账）。剔除后用户即使走
    // "缺省=全部非 high"也不会替换自己刚拒绝的形态。
    const knownRefs = new Set<string>([
      ...entries.map((entry) => entry.id),
      ...mergeCandidates.map((c) => c.entryRef),
      ...headingCandidates.map((c) => c.entryRef),
      ...applyableModels.map((c) => c.entryRef),
    ]);
    const rejectedSet = new Set((rejectedIds ?? []).filter((id) => knownRefs.has(id)));

    const allCandidates = [
      ...scan.candidates.filter((c) => !rejectedSet.has(c.entryRef)),
      ...mergeCandidates,
      ...headingCandidates,
      ...applyableModels,
    ];
    const syntheticRefs = [...mergeCandidates, ...headingCandidates].map((c) => c.entryRef);
    const acceptedAll = syntheticRefs.length
      ? [...(acceptedIds ?? []), ...syntheticRefs]
      : (acceptedIds ?? (applyableModels.length ? [] : undefined));
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
    // 【specs/013 T028】拒绝回执落账（FR-001 前半）：写**既有** writeReviewDecision
    // （review-decision.ts 一行不改）。target_ref = meeting:<docId>:<entryRef>（与
    // T029 抑制读口、data-model §1.5 同构）；idempotencyKey 含 runId（缺省本次 run；
    // 重试同一动作传 receiptRunId 复用原 key）——同动作重试命中幂等分支返回既有
    // 决定，不产生第二条。decision_type === 'reject' ⇒ 末条判定为抑制 ⇒ T029 生效。
    const receipts: Array<{ entryRef: string; decisionId: string }> = [];
    for (const entryRef of rejectedSet) {
      const decision = await writeReviewDecision(ctx.userId, {
        targetRef: `meeting:${docId}:${entryRef}`,
        decisionType: 'reject',
        decision: 'reject',
        actor: 'user',
        idempotencyKey: `meeting:${docId}:${entryRef}:reject:${receiptRunId ?? run.runId}`,
      });
      receipts.push({ entryRef, decisionId: decision.decision_id });
    }
    transcriptGlossary.recordReplacement(
      ctx.userId,
      result.applied.map((a) => a.entryRef),
      { docId, runId: run.runId },
    );
    // 「勾选并应用 = 确认」：把**真的被应用**的模型建议记进词表（source: meeting_accept，
    // 作用域收窄到本文档）。只认 result.applied——勾了但被护栏挡掉的不算确认。
    // 词表命中的候选（g_*）本来就在表里，这里的 ref 只筛 model_*。
    // （T022：被引例闸挡掉的模型建议同样不算确认——用 applyableModels 为准。）
    const appliedModelRefs = new Set(result.applied.map((a) => a.entryRef));
    const confirmedPairs = applyableModels
      .filter((candidate) => appliedModelRefs.has(candidate.entryRef))
      .map((candidate) => ({ wrong: candidate.wrong, correct: candidate.correct }));
    const glossaryWrites = transcriptGlossary.rememberConfirmedPairs(ctx.userId, confirmedPairs, { docId });
    return { run, result, denied: scan.denied, glossaryWrites, droppedModels, receipts };
  },

  /**
   * 【specs/013 T032】撤销拒绝（FR-001：被拒抑制必须可逆——否则"拒错一条"
   * 等于该形态永久不再建议）。
   *
   * 口径**对齐词表侧既有 `setIgnored(ids, ignored)`**（transcript_glossary.ts:589，
   * 布尔式批量、可逆、幂等）：
   *   - 撤销 = 向**既有**回执账本**追加**一条 `accept` 决定（账本 append-only，
   *     历史条目只增不减；不新增决定类型——`accept` 是既有 7 值之一，且
   *     `ReviewDecision.supersedes_ref` 的既有注释明写"reject 后 accept 覆盖"），
   *     `supersedes_ref` 指向被撤销的那条末条抑制决定；
   *   - 末条判定复用 `isCandidateSuppressed`（唯一判据，不新写第二套）：末条
   *     不是抑制态（从未拒绝 / 已撤销）⇒ 幂等跳过、不追加（对齐 setIgnored
   *     重复调用的无操作语义），不报错；
   *   - 撤销后末条为 accept ⇒ T029 的抑制过滤放行，该形态重新出现；再次拒绝
   *     （apply 的 rejectedIds）⇒ 又追加 reject ⇒ 再次抑制，往返可逆。
   *   - `decision: 'unreject'` 与常规 accept 区分（指标侧可按它/supersedes_ref
   *     剔除"撤销"对采纳率口径的污染，T055 用；本通道只如实记账）。
   */
  'transcript.correct.unreject': async (payload: Payload, ctx: IpcContext) => {
    const docId = requireText(payload?.docId, 'docId', 200);
    const ids = stringList(payload?.ids, 500) ?? [];
    const undone: Array<{ entryRef: string; decisionId: string }> = [];
    for (const entryRef of ids) {
      const targetRef = `meeting:${docId}:${entryRef}`;
      if (!(await isCandidateSuppressed(ctx.userId, targetRef))) continue;
      const decisions = await listReviewDecisions(ctx.userId, targetRef);
      const last = decisions[decisions.length - 1];
      const decision = await writeReviewDecision(ctx.userId, {
        targetRef,
        decisionType: 'accept',
        decision: 'unreject',
        actor: 'user',
        ...(last ? { supersedesRef: last.decision_id } : {}),
      });
      undone.push({ entryRef, decisionId: decision.decision_id });
    }
    return { undone };
  },

  /**
   * 【specs/013 T047】从纠错面板把词条「提出为候选」（FR-013 / US-504 AC3）。
   *
   * - 落点是 **recall/candidate-service 的候选池**（`recall/records/candidates`），
   *   不是既有回流 `contributeCandidates` 打到的个人本体候选池
   *   （`transcript_ontology_bridge.ts` 的 addCandidate——那是另一个池子）；
   * - 词条身份 + 哪次 run：`captureKey = glossary-<entryId>`（幂等键）、
   *   `evidenceRefs[].title = '<wrong>→<correct>'`、`excerpt = '<runId>'`（台账
   *   replacedIn 最近一条；没有就不写，不编造）；`sourceRefs` 记哪份文档
   *   （面板可选传 docId，缺省回落台账里的 docId；都没有 ⇒ 如实留空，候选落
   *   weak_observation——既有 reviewReady 闸不放宽）；
   * - **不新增 source kind**（C-002，已裁定选项①：复用 captureKey+refs 组合）；
   * - 幂等：先查既有 captureKey，命中 ⇒ `{ created:false }` 返回既有 id，不新增；
   * - tags/category（012 边界）：收到 ⇒ `field_not_available` 拒绝（同
   *   meeting.conclusions.precipitate 的 T048 口径；标签在晋升为正式资产后经
   *   资产管家打标，不映射、不静默丢弃）。
   */
  'transcript.correct.proposeCandidate': async (payload: Payload, ctx: IpcContext) => {
    const entryId = typeof payload?.entryId === 'string' ? payload.entryId.trim() : '';
    if (!entryId || entryId.length > 128 || !safeId(entryId)) {
      const error = new Error('transcript propose: invalid entry id');
      (error as { code?: string }).code = 'invalid_item_id';
      throw error;
    }
    const entryKind = payload?.entryKind;
    const GLOSSARY_KINDS: transcriptGlossary.GlossaryKind[] = ['product', 'people', 'org', 'term', 'venue', 'course', 'filler'];
    if (typeof entryKind !== 'string' || !GLOSSARY_KINDS.includes(entryKind as transcriptGlossary.GlossaryKind)) {
      const error = new Error('transcript propose: invalid entry kind');
      (error as { code?: string }).code = 'invalid_input';
      throw error;
    }
    for (const field of ['tags', 'category'] as const) {
      if (payload && typeof payload === 'object'
        && Object.prototype.hasOwnProperty.call(payload, field)
        && payload[field] !== undefined) {
        const error = new Error(
          `${field} is not available on glossary propose; tag the promoted asset via the asset steward (update_ability_asset fields.tags) instead`,
        );
        (error as { code?: string }).code = 'field_not_available';
        throw error;
      }
    }
    const entry = transcriptGlossary.listEntries(ctx.userId, {})
      .find((item) => item && item.id === entryId);
    if (!entry) {
      const error = new Error('transcript propose: glossary entry not found');
      (error as { code?: string }).code = 'item_missing';
      throw error;
    }

    const captureKey = `glossary-${entryId}`;
    const existing = (await listRecallCandidates(ctx.userId)).find((c) => c.captureKey === captureKey);
    if (existing) return { candidateId: existing.id, created: false };

    // 「哪份文档 / 哪次 run」：面板上下文优先（用户此刻在这份文档里提出），
    // 缺省回落台账 replacedIn 最近一条（真实替换记录）；都没有 ⇒ 留空（如实）。
    const panelDocId = optionalId(payload?.docId, 'docId');
    const ledger = Array.isArray(entry.replacedIn) && entry.replacedIn.length
      ? entry.replacedIn[entry.replacedIn.length - 1]
      : undefined;
    const docId = panelDocId || (ledger ? String(ledger.docId || '') : '');
    const runId = ledger ? String(ledger.runId || '') : '';
    const docTitle = docId.split(/[\\/]/).filter(Boolean).pop() || docId;
    const contextRef = docId
      ? [{
          kind: 'artifact_file' as const,
          subtype: 'context_file' as const,
          scope: 'personal' as const,
          id: cognitionContextFileSourceId(docId),
          title: docTitle,
        }]
      : [];
    const pair = entry.action === 'delete'
      ? `${entry.wrong}→（删除）`
      : `${entry.wrong}→${entry.correct}`;
    const candidate = await saveRecallCandidate(ctx.userId, {
      judgment: (typeof payload?.judgment === 'string' && payload.judgment.trim())
        ? payload.judgment.trim()
        : `纠错词条「${pair}」（${entryKind}）`,
      ...(typeof payload?.value === 'string' && payload.value.trim() ? { value: payload.value.trim() } : {}),
      suggestedType: 'personal',
      suggestedScope: 'personal',
      suggestedAction: 'create',
      sourceRefs: contextRef,
      evidenceRefs: docId
        ? [
            // 词条身份 + 哪次 run。title 前缀是契约钉死的 '<wrong>→<correct>'；
            // runId 同时并入 title 后缀——既有写口 normalizeCognitionSourceRefsForWrite
            // 会剥 excerpt（写侧只存来源元数据的既有纪律，一行不改），不并进 title
            // 的话「哪次 run」在落盘候选里永远读不回来。excerpt 仍按契约带上
            // （SaveRecallCandidateInput 输入侧），落盘侧以 title 为可读载体。
            {
              ...contextRef[0],
              title: runId ? `${pair} · ${runId}` : pair,
              ...(runId ? { excerpt: runId } : {}),
            },
            // 文档行（data-model §1.6「再加文档一条」）。
            { ...contextRef[0], title: `词条来源文档 ${docTitle}` },
          ]
        : [],
      captureKey,
    });
    return { candidateId: candidate.id, created: true };
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
