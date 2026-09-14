/**
 * transcript_correction_runs — 一次"清理"的产物与回滚（三件套之 B/C）
 *
 * 三件套（方案 v0.2 §三）：
 *   A. 原文            —— **本模块永不改写**；只读入参、记 sha1（"原文件保持不变"）
 *   B. 清理版          —— after.txt（替换 + 口癖删除后的文本）
 *   C. 对照表/未决项    —— diff.json / issues.json / report（术语对照、待核清单、参数）
 *
 * 落盘：`<uid>/local/cogseed/transcript/runs/<runId>/`（机器私有派生物，见 paths.ts）
 *   run.json        —— 元数据：sourceSha1 / 参数 / 统计 / 状态
 *   before.txt      —— 原文快照（回滚的唯一依据）
 *   after.txt       —— 清理版
 *   diff.json       —— 逐条已应用编辑（entryRef / wrong / correct / count / spans）
 *   offset-map.json —— 偏移映射（keep/replace/delete 段），供时间戳与锚点重算
 *   issues.json     —— 未决项（待核），有 open 项时产物只能标 draft
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
}

export type IssueReason =
  | 'unknown_entity'
  | 'ambiguous_name'
  | 'mixed_speech'
  | 'asr_unrecoverable';

export interface OpenIssue {
  id: string;
  runId: string;
  docId: string;
  span: { start: number; end: number };
  text: string;
  reason: IssueReason;
  suggestion?: string;
  /** 写回清理版的可见标记。 */
  marker: '【转写存疑】';
  status: 'open' | 'resolved';
  createdAt: number;
  resolvedAt?: number;
  resolution?: string;
}

export interface CreateRunInput {
  docId: string;
  sourceText: string;
  sourcePath?: string;
  result: ApplyResult;
  params?: CorrectionRunParams;
  mergedBlocks?: number;
  issues?: Array<Omit<OpenIssue, 'id' | 'runId' | 'docId' | 'marker' | 'status' | 'createdAt'>>;
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
    // 有未决项/未确认高危候选时，产物只能标 draft（方案 §8.1-7）。
    status: input.result.status === 'applied' && (input.issues?.length ?? 0) === 0 ? 'applied' : 'draft',
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
  writeJson(path.join(dir, 'offset-map.json'), { generatedAt: run.createdAt, segments: input.result.offsetMap });

  if (input.issues && input.issues.length) {
    const now = Date.now();
    const issues: OpenIssue[] = input.issues.map((issue, idx) => ({
      id: `isu_${sha1(`${runId}|${idx}|${issue.text}`).slice(0, 10)}`,
      runId,
      docId: run.docId,
      span: issue.span,
      text: issue.text,
      reason: issue.reason,
      ...(issue.suggestion ? { suggestion: issue.suggestion } : {}),
      marker: '【转写存疑】',
      status: 'open' as const,
      createdAt: now,
    }));
    writeJson(path.join(dir, 'issues.json'), issues);
  }
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

// ── 未决项（待核）──────────────────────────────────────────────────────

export function listIssues(
  userId: string,
  filter: { runId?: string; status?: 'open' | 'resolved' } = {},
): OpenIssue[] {
  const runs = filter.runId
    ? (getRun(userId, filter.runId) ? [filter.runId] : [])
    : listRuns(userId).map((r) => r.runId);
  const out: OpenIssue[] = [];
  for (const runId of runs) {
    const issues = readJson<OpenIssue[]>(path.join(runDir(userId, runId), 'issues.json')) ?? [];
    for (const issue of issues) {
      if (filter.status && issue.status !== filter.status) continue;
      out.push(issue);
    }
  }
  return out;
}

export function resolveIssue(userId: string, runId: string, issueId: string, resolution: string): OpenIssue | null {
  const file = path.join(runDir(userId, runId), 'issues.json');
  const issues = readJson<OpenIssue[]>(file);
  if (!issues) return null;
  const target = issues.find((i) => i.id === issueId);
  if (!target) return null;
  target.status = 'resolved';
  target.resolvedAt = Date.now();
  target.resolution = resolution.slice(0, 500);
  writeJson(file, issues);
  // 队列清空后才允许把 run 从 draft 提升为 applied。
  const remaining = issues.filter((i) => i.status === 'open').length;
  const run = getRun(userId, runId);
  if (run && remaining === 0 && run.pendingTotal === 0 && run.status === 'draft') {
    writeJson(path.join(runDir(userId, runId), 'run.json'), { ...run, status: 'applied' });
  }
  return target;
}

// ── 三件套之 C：对照表 / 报告 ───────────────────────────────────────────

export interface CorrectionReport {
  run: CorrectionRun;
  /** 术语对照表：清理后用词 ← 原始转写典型形式（← 次数）。 */
  terminology: Array<{ wrong: string; correct: string; action: string; count: number; entryRef: string }>;
  issues: OpenIssue[];
  params: CorrectionRunParams;
  contextMaterials: string[];
  notes: string[];
}

export function buildReport(userId: string, runId: string): CorrectionReport {
  const run = getRun(userId, runId);
  if (!run) throw new Error('transcript runs: run not found');
  const issues = listIssues(userId, { runId });
  const notes: string[] = [];
  if (run.overRewriteSuspected) notes.push(`字符保留率 ${(run.retention * 100).toFixed(1)}% 低于阈值，疑似过度改写`);
  if (run.pendingTotal > 0) notes.push(`还有 ${run.pendingTotal} 条候选未确认`);
  if (issues.some((i) => i.status === 'open')) notes.push(`还有 ${issues.filter((i) => i.status === 'open').length} 处待核`);
  return {
    run,
    terminology: run.applied.map((a) => ({
      wrong: a.wrong, correct: a.correct, action: a.action, count: a.count, entryRef: a.entryRef,
    })),
    issues,
    params: run.params,
    contextMaterials: Array.isArray(run.params.contextMaterials) ? run.params.contextMaterials : [],
    notes,
  };
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
