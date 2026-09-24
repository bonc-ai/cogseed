/**
 * transcript_correction_runs — 一次"清理"的产物与回滚（三件套之 B/C）
 *
 * 三件套（方案 v0.2 §三）：
 *   A. 原文            —— **本模块永不改写**；只读入参、记 sha1（"原文件保持不变"）
 *   B. 清理版          —— after.txt（替换 + 口癖删除后的文本）
 *   C. 对照表          —— diff.json / report（术语对照、依据、参数）
 *
 * 落盘：`<uid>/local/cogseed/transcript/runs/<runId>/`（机器私有派生物，见 paths.ts）
 *   run.json        —— 元数据：sourceSha1 / 参数 / 统计 / 状态
 *   before.txt      —— 原文快照（回滚的唯一依据）
 *   after.txt       —— 清理版
 *   diff.json       —— 逐条已应用编辑（entryRef / wrong / correct / count / spans）
 *   offset-map.json —— 偏移映射（keep/replace/delete 段），供时间戳与锚点重算
 *
 * 回滚语义：`revertRun` 只**返回**原文并校验 sha1，不去写任何文档——把"恢复"
 * 交给调用方（宿主视图/文件层），避免这里再引入一条隐蔽的写路径。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { userTranscriptRunDir, userTranscriptRunsDir } from '../paths';
import { createLogger } from '../logger';
import type { ApplyResult, AppliedSummary, OffsetSegment } from './transcript_auto_correct';
import { loadGlossary } from './transcript_glossary';

const log = createLogger('transcript_correction_runs');

const RUN_ID_RE = /^run_[A-Za-z0-9_-]{6,80}$/;

export type RunStatus = 'draft' | 'applied' | 'reverted';

export interface CorrectionRunParams {
  glossaryVersion?: number;
  fillerRulePack?: string;
  mergeSpeaker?: boolean;
  addHeadings?: boolean;
  contextMaterials?: string[];
  [key: string]: unknown;
}

export interface CorrectionRun {
  runId: string;
  docId: string;
  uid: string;
  sourceSha1: string;
  /** 原文路径（仅记录，永不写入）。 */
  sourcePath?: string;
  params: CorrectionRunParams;
  applied: AppliedSummary[];
  deletedFillers: Record<string, number>;
  mergedBlocks: number;
  counts: { replace: number; delete: number; charsIn: number; charsOut: number };
  retention: number;
  overRewriteSuspected: boolean;
  pendingTotal: number;
  status: RunStatus;
  createdAt: number;
  revertedAt?: number;
  /** 交付台账：本 run 产出的文件（如另存到知识库的清理版），只追加。 */
  deliveries?: RunDelivery[];
  /**
   * 检索命中对比台账（方案 §五 P0-5「记录替换前/后检索命中数」）。
   * 只追加：留痕"当时搜错形与搜正确写法各命中多少"，供复核，不宣称因果。
   */
  searchCompares?: SearchCompare[];
}

export interface SearchCompare {
  query: string;
  rewritten: string;
  beforeHits: number;
  afterHits: number;
  /**
   * 命中的**片段标题**（KB 入库时取该段首行），比条数有信息量：
   * 搜错形与搜正确写法命中的片段是否不同，才说明改写解决了"搜不到"。
   */
  beforeSources?: string[];
  afterSources?: string[];
  applied: Array<{ wrong: string; correct: string; count: number }>;
  /** 由主进程落盘时补（调用方不必传）。 */
  at?: number;
}

export interface RunDelivery {
  /**
   * `cleaned_copy` = 另存进知识库的清理版；
   * `local_copy`   = 另存到用户本机文件夹的清理版（两者可能出现，也可能只有一份）。
   */
  kind: 'cleaned_copy' | 'local_copy';
  path: string;
  at: number;
}

/*
 * 未决项（待核 / `issues.json` / 「【转写存疑】」标记）已随"模型候选并入扫描"整体移除：
 * 扫描结果本身就是唯一的候选清单，勾选即确认，不再有并行的"待核"状态。
 * 历史 run 目录里残留的 issues.json 不再被读取（其余产物照旧可回看/回滚）。
 */

export interface CreateRunInput {
  docId: string;
  sourceText: string;
  sourcePath?: string;
  result: ApplyResult;
  params?: CorrectionRunParams;
  mergedBlocks?: number;
  /** 时间/说话人锚点（方案 §4.2：删除与合并后时间锚点必须可重算）。 */
  anchors?: unknown[];
}

export function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

function assertRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) throw new Error('transcript runs: invalid runId');
}

function runDir(userId: string, runId: string): string {
  assertRunId(runId);
  return userTranscriptRunDir(userId, runId);
}

export function createRun(userId: string, input: CreateRunInput): CorrectionRun {
  if (!input.docId) throw new Error('transcript runs: docId is required');
  if (typeof input.sourceText !== 'string') throw new Error('transcript runs: sourceText is required');
  const stamp = Date.now().toString(36);
  const suffix = sha1(`${input.docId}|${input.sourceText}`).slice(0, 8);
  const runId = `run_${stamp}_${suffix}`;
  const dir = runDir(userId, runId);
  fs.mkdirSync(dir, { recursive: true });

  const replaceCount = input.result.applied.filter((a) => a.action === 'replace').reduce((n, a) => n + a.count, 0);
  const deleteCount = input.result.applied.filter((a) => a.action === 'delete').reduce((n, a) => n + a.count, 0);
  const run: CorrectionRun = {
    runId,
    docId: input.docId,
    uid: userId,
    sourceSha1: sha1(input.sourceText),
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    params: input.params ?? {},
    applied: input.result.applied,
    deletedFillers: input.result.deletedFillers,
    mergedBlocks: input.mergedBlocks ?? 0,
    counts: {
      replace: replaceCount,
      delete: deleteCount,
      charsIn: input.result.charsIn,
      charsOut: input.result.charsOut,
    },
    retention: input.result.retention,
    overRewriteSuspected: input.result.overRewriteSuspected,
    pendingTotal: input.result.pendingTotal,
    // 没勾选的候选仍存在时产物只能标 draft（方案 §8.1-7）：`ApplyResult.status`
    // 已经按"未处理的高危候选数"算过。
    status: input.result.status === 'applied' ? 'applied' : 'draft',
    createdAt: Date.now(),
  };

  writeJson(path.join(dir, 'run.json'), run);
  fs.writeFileSync(path.join(dir, 'before.txt'), input.sourceText, 'utf8');
  fs.writeFileSync(path.join(dir, 'after.txt'), input.result.text, 'utf8');
  writeJson(path.join(dir, 'diff.json'), {
    generatedAt: run.createdAt,
    docId: run.docId,
    entries: run.applied,
    deletedFillers: run.deletedFillers,
    params: run.params,
  });
  writeJson(path.join(dir, 'offset-map.json'), {
    generatedAt: run.createdAt,
    segments: input.result.offsetMap,
    // 锚点：原稿块 → 合并块的时间区间与原文范围，供引用/时间戳回查
    anchors: Array.isArray(input.anchors) ? input.anchors : [],
  });
  return run;
}

export function getRun(userId: string, runId: string): CorrectionRun | null {
  return readJson<CorrectionRun>(path.join(runDir(userId, runId), 'run.json'));
}

export function readRunText(userId: string, runId: string, which: 'before' | 'after'): string | null {
  try {
    return fs.readFileSync(path.join(runDir(userId, runId), `${which}.txt`), 'utf8');
  } catch {
    return null;
  }
}

export function readOffsetMap(userId: string, runId: string): OffsetSegment[] {
  const payload = readJson<{ segments: OffsetSegment[] }>(path.join(runDir(userId, runId), 'offset-map.json'));
  return payload?.segments ?? [];
}

/** 目录扫描（与项目列表同范式），坏文件跳过并告警。 */
export function listRuns(userId: string, filter: { docId?: string } = {}): CorrectionRun[] {
  const root = userTranscriptRunsDir(userId);
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const runs: CorrectionRun[] = [];
  for (const name of names) {
    if (!RUN_ID_RE.test(name)) continue;
    const run = getRun(userId, name);
    if (!run) {
      log.warn('run.json unreadable; skipping', { runId: name });
      continue;
    }
    if (filter.docId && run.docId !== filter.docId) continue;
    runs.push(run);
  }
  return runs.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 回滚：校验 before.txt 的 sha1 与 run 记录一致后返回原文。
 * **不写任何文档**——恢复动作由调用方决定写到哪里。
 */
export function revertRun(userId: string, runId: string): { run: CorrectionRun; text: string; sha1Matched: boolean } {
  const run = getRun(userId, runId);
  if (!run) throw new Error('transcript runs: run not found');
  const before = readRunText(userId, runId, 'before');
  if (before === null) throw new Error('transcript runs: snapshot missing');
  const sha1Matched = sha1(before) === run.sourceSha1;
  if (!sha1Matched) log.error('snapshot sha1 mismatch', { runId });
  const next: CorrectionRun = { ...run, status: 'reverted', revertedAt: Date.now() };
  writeJson(path.join(runDir(userId, runId), 'run.json'), next);
  return { run: next, text: before, sha1Matched };
}

/**
 * 追加一条交付记录（只追加）。用于把"另存到知识库 / 另存到本地文件夹"的产物路径与 run 绑定，
 * 否则清理版文件名换成人类可读的时间戳后，就无法从文件名反查是哪次清理产出的。
 * 无论 run 处于 draft/applied/reverted，交付事实都要留下。
 *
 * kind 只认白名单两种：未知值一律记 `cleaned_copy`（历史调用方不传 kind，行为不变）。
 */
export function annotateRun(
  userId: string,
  runId: string,
  delivery: { kind?: unknown; path?: unknown },
): CorrectionRun | null {
  const run = getRun(userId, runId);
  if (!run) return null;
  // 注意：局部名不要用 path —— 会遮蔽 node:path 模块（tsc 会直接报错）。
  const deliveryPath = typeof delivery?.path === 'string' ? delivery.path.trim() : '';
  if (!deliveryPath) throw new Error('transcript runs: delivery path is required');
  const kind: RunDelivery['kind'] = delivery?.kind === 'local_copy' ? 'local_copy' : 'cleaned_copy';
  const record: RunDelivery = { kind, path: deliveryPath.slice(0, 500), at: Date.now() };
  const next: CorrectionRun = {
    ...run,
    deliveries: [...(run.deliveries ?? []), record].slice(-50),
  };
  writeJson(path.join(runDir(userId, runId), 'run.json'), next);
  return next;
}

export interface TerminologyRow {
  wrong: string;
  correct: string;
  action: string;
  count: number;
  entryRef: string;
  /** 依据（方案 §五 P1-3 要求对照表带"依据"）：来自当前词表的来源/风险/类别。 */
  basis: {
    source: string;
    riskLevel: string;
    kind: string;
    freq: number;
    /** 来自记忆分组时给出定位（groupId/fieldId）。 */
    ontologyRef?: { groupId: string; fieldId: string };
    /** 词表里已经找不到这条（被删/被改）——如实标注，不编依据。 */
    missingInGlossary?: boolean;
  };
}

export interface CorrectionReport {
  run: CorrectionRun;
  /** 术语对照表：清理后用词 ← 原始转写典型形式（← 次数）。 */
  terminology: TerminologyRow[];
  params: CorrectionRunParams;
  contextMaterials: string[];
  /** 上下文材料清单（方案 §七：附记要列清这次依据了哪些东西）。 */
  materials: string[];
  /** 本 run 已另存出去的清理版路径（可能为空）。 */
  deliveries: RunDelivery[];
  notes: string[];
}

export function buildReport(userId: string, runId: string): CorrectionReport {
  const run = getRun(userId, runId);
  if (!run) throw new Error('transcript runs: run not found');
  const notes: string[] = [];
  if (run.overRewriteSuspected) notes.push(`字符保留率 ${(run.retention * 100).toFixed(1)}% 低于阈值，疑似过度改写`);
  if (run.pendingTotal > 0) notes.push(`还有 ${run.pendingTotal} 条候选未确认`);
  // 依据来自**当前**词表（词条可能事后被改/被删，那就如实标 missingInGlossary）
  const glossary = loadGlossary(userId);
  const byId = new Map(glossary.entries.map((entry) => [entry.id, entry]));
  const terminology: TerminologyRow[] = run.applied
    // 结构性编辑（合并块头）不属于"术语对照表"
    .filter((a) => !a.entryRef.startsWith('merge_'))
    .map((a) => {
      const entry = byId.get(a.entryRef);
      return {
        wrong: a.wrong,
        correct: a.correct,
        action: a.action,
        count: a.count,
        entryRef: a.entryRef,
        basis: entry
          ? {
            source: entry.source,
            riskLevel: entry.riskLevel,
            kind: entry.kind,
            freq: entry.freq,
            ...(entry.ontologyRef ? { ontologyRef: entry.ontologyRef } : {}),
          }
          : { source: 'unknown', riskLevel: 'unknown', kind: 'unknown', freq: 0, missingInGlossary: true },
      };
    });
  const contextMaterials = Array.isArray(run.params.contextMaterials) ? run.params.contextMaterials : [];
  // 材料清单：能由事实推出的就推（源文件、词表、规则包、记忆分组），不编造
  const ontologyBacked = terminology.filter((row) => row.basis.ontologyRef).length;
  const materials = [
    run.sourcePath
      ? `源转写：${run.sourcePath}（sha1 ${run.sourceSha1.slice(0, 8)}）`
      : `源转写：${run.docId}（sha1 ${run.sourceSha1.slice(0, 8)}）`,
    `词表：transcript-glossary.json v${run.params.glossaryVersion ?? 2}（本次用到 ${new Set(terminology.map((r) => r.entryRef)).size} 条）`,
    ...(run.params.fillerRulePack ? [`口癖规则包：${run.params.fillerRulePack}`] : []),
    ...(run.mergedBlocks > 0 ? [`同人段落合并：${run.mergedBlocks} 块（时间锚点见 offset-map.json.anchors）`] : []),
    ...(ontologyBacked > 0 ? [`记忆分组：${ontologyBacked} 条词条带本体引用`] : []),
    ...contextMaterials.map((item) => `补充材料：${item}`),
  ];
  return {
    run,
    terminology,
    params: run.params,
    contextMaterials,
    materials,
    deliveries: run.deliveries ?? [],
    notes,
  };
}

/**
 * 清理附记（方案 §五 P1-3 / §七）：把 run 的一切事实渲染成一份 Markdown。
 *
 * 原则：**只写 run 里已有的东西**，推不出来的不写；产物是 draft 时必须
 * 在开头写明"未决项未清零，不得宣称完成"（§8.1-7）。
 * 纯函数，便于单测（不碰磁盘）。
 */
export function renderRunNotes(report: CorrectionReport, opts: { generatedAt?: number } = {}): string {
  const run = report.run;
  const when = new Date(opts.generatedAt ?? Date.now()).toISOString().replace('T', ' ').slice(0, 19);
  const retention = (Number(run.retention) || 0) * 100;
  const lines: string[] = [];

  lines.push('# 转写清理附记');
  lines.push('');
  lines.push(`- 生成时间：${when}`);
  lines.push(`- 文档：${run.docId}`);
  lines.push(`- run：${run.runId}`);
  lines.push(`- 原文指纹：sha1 ${run.sourceSha1}`);
  lines.push(`- 原文字符：${run.counts.charsIn} → 清理版字符：${run.counts.charsOut}（保留率 ${retention.toFixed(1)}%）`);
  lines.push(`- 替换 ${run.counts.replace} 处 · 删除 ${run.counts.delete} 处 · 同人段落合并 ${run.mergedBlocks} 块`);
  lines.push(`- 产物状态：${run.status === 'draft' ? '**草稿（draft）**' : '已应用（applied）'}`);
  lines.push('');
  if (run.status === 'draft') {
    lines.push('> ⚠️ 本次产物是草稿：' + (report.notes.length ? report.notes.join('；') : '存在未确认项')
      + '。未确认项清零前不得宣称清理完成。');
    lines.push('');
  }

  lines.push('## 一、术语对照表');
  lines.push('');
  if (report.terminology.length === 0) {
    lines.push('本次没有术语替换。');
  } else {
    lines.push('| 清理后用词 | 原始典型形式 | 处数 | 类别 | 风险 | 依据 |');
    lines.push('|---|---|---|---|---|---|');
    for (const row of report.terminology) {
      const basis = row.basis.missingInGlossary
        ? '词表中已不存在该词条'
        : `${row.basis.source}${row.basis.ontologyRef ? `（记忆分组 ${row.basis.ontologyRef.fieldId}）` : ''} · 已确认 ${row.basis.freq} 次`;
      lines.push(`| ${row.correct || '（删除）'} | ${row.wrong} | ${row.count} | ${row.basis.kind} | ${row.basis.riskLevel} | ${basis} |`);
    }
  }
  lines.push('');

  lines.push('## 二、口癖与填充词删除');
  lines.push('');
  const fillerKeys = Object.keys(run.deletedFillers ?? {});
  if (fillerKeys.length === 0) {
    lines.push('本次没有删除口癖（未装规则包或未接受）。');
  } else {
    lines.push('| 词 | 删除处数 |');
    lines.push('|---|---|');
    for (const key of fillerKeys.sort((a, b) => (run.deletedFillers[b] ?? 0) - (run.deletedFillers[a] ?? 0))) {
      lines.push(`| ${key} | ${run.deletedFillers[key]} |`);
    }
  }
  lines.push('');

  lines.push('## 三、上下文材料');
  lines.push('');
  if (report.materials.length === 0) lines.push('（无）');
  else for (const item of report.materials) lines.push(`- ${item}`);
  lines.push('');

  const compares = run.searchCompares ?? [];
  if (compares.length) {
    lines.push('## 五、检索命中对比');
    lines.push('');
    lines.push('> 自测口径：同一份库里"搜错形"与"搜正确写法"各自的命中条数与命中片段（该段首行），**不宣称因果**。');
    lines.push('');
    lines.push('| 搜什么 | 改写为 | 命中 | 命中片段（前 2） | 对比 |');
    lines.push('|---|---|---|---|---|');
    for (const item of compares) {
      const before = (item.beforeSources?.length ? item.beforeSources.join('、') : '（无）');
      const after = (item.afterSources?.length ? item.afterSources.join('、') : '（无）');
      const differ = item.beforeSources?.length && item.afterSources?.length
        ? (item.beforeSources.join('|') === item.afterSources.join('|') ? '片段相同' : '片段不同')
        : '—';
      lines.push(`| ${item.query} | ${item.rewritten || '（未改写）'} | ${item.beforeHits} → ${item.afterHits} | ${before} → ${after} | ${differ} |`);
    }
    lines.push('');
  }

  lines.push('## 六、本次参数');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify({ ...report.params, runId: run.runId, status: run.status, pendingTotal: run.pendingTotal }, null, 2));
  lines.push('```');
  lines.push('');
  if (report.deliveries.length) {
    lines.push('## 六、交付记录');
    lines.push('');
    for (const delivery of report.deliveries) {
      lines.push(`- ${delivery.kind}：${delivery.path}（${new Date(delivery.at).toISOString().slice(0, 19)}）`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push('*原文从未被就地改写：以上所有替换/删除都发生在派生文件里，回滚只需校验 sha1（`transcript.run.revert`）。*');
  return lines.join('\n');
}

/**
 * 记录一次检索命中对比（只追加）。方案 §五 P0-5 要求 run 里能回看
 * "替换前/后检索命中数"——但**只记录实际发生的观察**，不推因果。
 */
export function recordSearchCompare(userId: string, runId: string, input: SearchCompare): CorrectionRun {
  assertRunId(runId);
  const run = getRun(userId, runId);
  if (!run) throw new Error('transcript runs: run not found');
  const entry: SearchCompare = {
    query: String(input.query ?? '').slice(0, 500),
    rewritten: String(input.rewritten ?? '').slice(0, 500),
    beforeHits: Math.max(0, Math.floor(Number(input.beforeHits) || 0)),
    afterHits: Math.max(0, Math.floor(Number(input.afterHits) || 0)),
    ...(Array.isArray(input.beforeSources) ? { beforeSources: input.beforeSources.map(String).slice(0, 5) } : {}),
    ...(Array.isArray(input.afterSources) ? { afterSources: input.afterSources.map(String).slice(0, 5) } : {}),
    applied: Array.isArray(input.applied)
      ? input.applied.slice(0, 50).map((item) => ({
        wrong: String(item?.wrong ?? '').slice(0, 200),
        correct: String(item?.correct ?? '').slice(0, 200),
        count: Math.max(0, Math.floor(Number(item?.count) || 0)),
      }))
      : [],
    at: typeof input.at === 'number' ? input.at : Date.now(),
  };
  const next: CorrectionRun = {
    ...run,
    searchCompares: [...(run.searchCompares ?? []), entry].slice(-50),
  };
  writeJson(path.join(runDir(userId, runId), 'run.json'), next);
  return next;
}

// ── 小工具 ──────────────────────────────────────────────────────────────

function writeJson(target: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'ENOENT') log.warn('json unreadable', { file: path.basename(file), code });
    return null;
  }
}
