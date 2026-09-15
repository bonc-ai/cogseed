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
 *   transcript.run.list / get / report / revert
 *   transcript.issues.list / resolve
 */

import * as transcriptGlossary from '../features/transcript_glossary';
import * as transcriptAutoCorrect from '../features/transcript_auto_correct';
import * as transcriptRuns from '../features/transcript_correction_runs';

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

export const invokeHandlers = {
  // ── 词表 ──────────────────────────────────────────────────────────────
  'transcript.glossary.list': async (payload: Payload, ctx: IpcContext) => ({
    entries: transcriptGlossary.listEntries(ctx.userId, {
      ...(payload?.kind ? { kind: payload.kind as transcriptGlossary.GlossaryKind } : {}),
      ...(payload?.riskLevel ? { riskLevel: payload.riskLevel as transcriptGlossary.RiskLevel } : {}),
      ...(payload?.status ? { status: payload.status as transcriptGlossary.EntryStatus } : {}),
    }),
    file: 'transcript-glossary.json',
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
    const result = transcriptAutoCorrect.applyCorrections(text, scan.candidates, {
      ...(acceptedIds ? { acceptedIds } : {}),
      ...(riskLevels(payload?.acceptRiskLevels) ? { acceptRiskLevels: riskLevels(payload?.acceptRiskLevels)! } : {}),
    });
    const params = {
      glossaryVersion: 2,
      ...(optionalText(payload?.fillerRulePack, 'fillerRulePack', 40)
        ? { fillerRulePack: optionalText(payload?.fillerRulePack, 'fillerRulePack', 40)! }
        : {}),
      ...(payload?.params && typeof payload.params === 'object' ? (payload.params as Record<string, unknown>) : {}),
    };
    const mergeSpeaker = payload?.mergeSpeaker === true;
    const run = transcriptRuns.createRun(ctx.userId, {
      docId,
      sourceText: text,
      ...(optionalText(payload?.sourcePath, 'sourcePath', 500)
        ? { sourcePath: optionalText(payload?.sourcePath, 'sourcePath', 500)! }
        : {}),
      result,
      params,
      mergedBlocks: typeof payload?.mergedBlocks === 'number' ? Math.max(0, Math.floor(payload.mergedBlocks)) : 0,
      issues: issueInputs(payload?.issues),
    });
    transcriptGlossary.recordReplacement(
      ctx.userId,
      result.applied.map((a) => a.entryRef),
      { docId, runId: run.runId },
    );
    void mergeSpeaker;
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
