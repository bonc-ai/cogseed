/** 资产检查与历史整理报告。当前所有触发方式只生成建议，不改资产或候选。
 * 历史 applied 项、版本锚点与报告处置继续可读；内容修改由详情页显式提交。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { recallJsonRecordPath } from './paths';
import { readRecallJsonRecord, updateRecallJsonRecord, writeRecallJsonRecord } from './store';
import { clearedReportRow, reportRowAssetIds, type ReportContentOwnership } from './report-content-lifecycle';
import type { RecallJsonRecord } from './types';
import { listAbilityAssets } from './asset-service';
import type { RecallAbilityAssetRecord } from './candidate-service';

const log = createLogger('recall.asset-cleanup');

export type CleanupItemKind = 'title_normalized' | 'merged_duplicate' | 'tag_added' | 'title_regen' | 'statement_regen' | 'candidate_statement_regen';
export type CleanupItemStatus = 'applied' | 'skipped' | 'uncertain' | 'failed';

export interface CleanupReportItem extends ReportContentOwnership {
  assetId: string;
  kind: CleanupItemKind;
  status: CleanupItemStatus;
  before: string;
  after: string;
  reason: string;
  /** 本次改动写下的台账行 id（items[] 与台账一一对应的凭据）。 */
  ledgerRef?: string;
  /** 一步回滚锚点（改前在用版）。 */
  rollbackAnchor?: string;
  /** 合并项：被并入的目标。 */
  mergedIntoAssetId?: string;
  /** 失败/跳过的原因（如实写，不掩饰）。 */
  note?: string;
}

export interface CleanupUncertainItem extends ReportContentOwnership {
  assetId: string;
  title?: string;
  /** 拿不准的是什么（用户据此决定要不要管）。 */
  question: string;
  reason: string;
  /** 用户处置后置位；未处置时缺省。 */
  decision?: 'dismissed' | 'deferred';
}

export interface CleanupReport extends RecallJsonRecord {
  /** 缺省代表旧报告；不能据当前模式重写旧执行事实。 */
  mode?: 'report_only';
  id: string;
  trigger: 'user' | 'inspection';
  scope: { spaceId?: string; assetType?: string };
  /** 整理类型：'rules'＝规则整理（含义不变）；
   *  'title_regen'＝标题重起轮（LLM 含义生成）。旧报告无此字段＝规则轮。
   *  'full'＝规则、标题和正文的完整整理，见 runAssetFullCleanup。 */
  round?: 'rules' | 'title_regen' | 'statement_regen' | 'candidate_statement_regen' | 'full';
  /** 完整整理轮：被合并汇总的各分轮报告 id。分轮报告仍在盘上（回滚凭据、
   *  台账与版本锚点逐轮独立），列表按 supersededBy 隐藏分轮、只露合并报告。 */
  subReportIds?: string[];
  /** 本报告已被完整整理轮合并，列表不再单独露出（值＝合并报告 id）。 */
  supersededBy?: string;
  /** 完整整理轮：写前整库备份目录（标题/正文两轮各一个，回滚参考）。 */
  backupDirs?: string[];
  /** 完整整理轮：某分轮整轮未执行的原因（如模型未配置）。规则轮成果不陪葬，
   *  但必须如实上报，不静默（各轮"整轮失败上报"硬口径在合并层的落点）。 */
  roundErrors?: { title_regen?: string; statement_regen?: string; candidate_statement_regen?: string };
  /** 标题重起轮专用：写前整库备份目录（records/ 之外）。恢复走
   *  updateAbilityAsset 正门逐条改回，不做 raw 写回（见轮内注释）。 */
  backupDir?: string;
  items: CleanupReportItem[];
  uncertain: CleanupUncertainItem[];
  /** 本轮跳过的步骤。 */
  skippedSteps: string[];
  createdAt: string;
  finishedAt?: string;
  /** 中断（异常/取消）时置位：已执行项仍然有效且可回滚。 */
  interrupted?: boolean;
  scanned: number;
}

function reportsDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, 'cleanup-reports', 'placeholder'));
}

function asReport(value: RecallJsonRecord): CleanupReport {
  if (
    typeof value.trigger !== 'string'
    || !Array.isArray(value.items) || !Array.isArray(value.uncertain)
    || typeof value.createdAt !== 'string'
    || !value.scope || typeof value.scope !== 'object' || Array.isArray(value.scope)
  ) throw new Error('malformed cleanup report');
  return {
    ...value,
    skippedSteps: Array.isArray(value.skippedSteps) ? value.skippedSteps as string[] : [],
    scanned: Number(value.scanned) || 0,
  } as CleanupReport;
}

export async function readCleanupReport(userId: string, reportId: string): Promise<CleanupReport | undefined> {
  if (!safeId(reportId)) throw new Error('invalid cleanup report id');
  const raw = await readRecallJsonRecord(userId, 'cleanup-reports', reportId);
  return raw ? asReport(raw) : undefined;
}

export async function listCleanupReports(userId: string, limit = 20): Promise<CleanupReport[]> {
  let names: string[];
  try {
    names = await fs.readdir(reportsDirectory(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map((name) => readRecallJsonRecord(userId, 'cleanup-reports', name.slice(0, -5))));
  return records
    .filter((raw): raw is RecallJsonRecord => Boolean(raw))
    .flatMap((raw) => {
      try { return [asReport(raw)]; } catch { return []; }
    })
    // 被完整整理轮合并的分轮不再单独露出（合并报告已汇总其 items/uncertain）。
    .filter((report) => !report.supersededBy)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, Math.max(1, Math.min(100, limit)));
}

async function patchReport(
  userId: string,
  reportId: string,
  patch: (report: CleanupReport) => Partial<CleanupReport>,
): Promise<CleanupReport> {
  const updated = await updateRecallJsonRecord(userId, 'cleanup-reports', reportId, (raw) => {
    if (!raw) throw new Error('cleanup report not found');
    return { ...asReport(raw), ...patch(asReport(raw)) } as RecallJsonRecord;
  });
  return asReport(updated);
}

/** 只留"改名不改意"的规范化：首尾空白、内部连续空白、结尾的句读符号。
 *
 *  真机上**空白那一类基本已经打不中**：候选判断与资产写入口都会 collapse + trim
 *  空白（`boundedText` / `bounded`），所以能落盘的"不规范"主要是**结尾句读**
 *  （'。'、'、'、'；'、','）与历史遗留记录。这一步因此不是空转，但也不该被
 *  当成主力——它的价值是"顺手把标点收干净"，不是"修标题"。 */
export function normalizeAssetTitle(title: string): string {
  return String(title || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。、；;,\s]+$/, '')
    .trim();
}

/** 正文比对用的归一文本：空白与结尾标点不算差异（"一字不差"按这个口径）。 */
function comparableStatement(statement: string): string {
  return String(statement || '').replace(/\s+/g, ' ').trim();
}

/** 近重复判据：同类型、正文不同但字面高度重叠。**只用来提醒**（进 uncertain），
 *  不用来自动合并——"看起来像"不是"就是一个意思"，那需要人来判。
 *  导出给后台巡检复用：同一件事只该有一套判据（两处各写一份迟早给出不同答案）。 */
export function nearDuplicateScore(left: string, right: string): number {
  const bigrams = (text: string): Set<string> => {
    const flat = comparableStatement(text).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const out = new Set<string>();
    for (let index = 0; index + 2 <= flat.length; index += 1) out.add(flat.slice(index, index + 2));
    return out;
  };
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/** 近重复的提醒阈值：够高才提醒，避免把"同一类里的不同规则"也报成疑似重复。 */
const NEAR_DUPLICATE_THRESHOLD = 0.8;
/** 单轮参与两两比对的资产上限：超过就只做逐条规范化，不硬算（宁可少报）。 */
const NEAR_DUPLICATE_SCAN_LIMIT = 200;
/** 同源组多数标签的传播门槛（quickstart S1.4"机械可判定"）：组内除本条外
 *  ≥ 这么多比例、且 ≥2 条已有同名标签，才算"绝大多数"——单一成员的标签可能
 *  是它独有的，不构成共识。够不上就转 `uncertain[]`，不擅自打。 */
const TAG_CONSENSUS_RATIO = 2 / 3;
const TAG_CONSENSUS_MIN_SIBLINGS = 2;

export interface RunCleanupOptions {
  trigger?: 'user' | 'inspection';
  scope?: { spaceId?: string; assetType?: string };
}

/** 先落检查报告，再逐项追加建议；中断只影响报告，不修改内容。 */
export async function runAssetCleanup(userId: string, options: RunCleanupOptions = {}): Promise<CleanupReport> {
  const scope = options.scope || {};
  const reportId = `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();
  const all = await listAbilityAssets(userId);
  let pool = all.filter((asset) => asset.status !== 'purged');
  if (scope.spaceId) pool = pool.filter((asset) => asset.spaceId === scope.spaceId);
  if (scope.assetType) pool = pool.filter((asset) => asset.type === scope.assetType);

  // 标签可按规则判定时写入，需要含义判断时进入 uncertain[]。
  const skippedSteps: string[] = [];

  await writeRecallJsonRecord(userId, 'cleanup-reports', reportId, {
    schemaVersion: 1,
    ownerId: userId,
    id: reportId,
    trigger: options.trigger || 'user',
    scope: { ...(scope.spaceId ? { spaceId: scope.spaceId } : {}), ...(scope.assetType ? { assetType: scope.assetType } : {}) },
    round: 'rules',
    mode: 'report_only',
    items: [],
    uncertain: [],
    skippedSteps,
    createdAt,
    scanned: pool.length,
  } satisfies CleanupReport);

  const items: CleanupReportItem[] = [];
  const uncertain: CleanupUncertainItem[] = [];

  try {
    // ① 命名规范化建议：原始标题和正文保持原样。报告条目保存
    // 字段名与字数（标题全文不进报告——它是持久台账，不是内容副本）。
    for (const asset of pool) {
      const normalized = normalizeAssetTitle(asset.title);
      if (!normalized || normalized === asset.title) continue;
      const item: CleanupReportItem = { assetId: asset.id, kind: 'title_normalized', status: 'uncertain',
        before: `标题 ${asset.title.length} 字`, after: `标题 ${normalized.length} 字`, reason: '自动检查只提出标题规范化建议，等待逐条确认' };
      items.push(item);
      uncertain.push({ assetId: asset.id, question: `标题有可规范化的空白或结尾标点（${asset.title.length} 字 → ${normalized.length} 字），是否到详情页处理？`, reason: item.reason });
      await patchReport(userId, reportId, () => ({ items: [...items], uncertain: [...uncertain] }));
      continue;
    }

    // ② 同正文提醒：只标记需核对的双方，不构成身份合并授权。
    const active = pool.filter((asset) => asset.status === 'active');
    const byStatement = new Map<string, RecallAbilityAssetRecord[]>();
    for (const asset of active) {
      const key = `${asset.type}\u0000${comparableStatement(asset.statement)}`;
      const group = byStatement.get(key) || [];
      group.push(asset);
      byStatement.set(key, group);
    }
    for (const group of byStatement.values()) {
      if (group.length < 2) continue;
      const ordered = [...group].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
      const target = ordered[0];
      for (const source of ordered.slice(1)) {
        if (source.id === target.id) continue;
        const item: CleanupReportItem = { assetId: source.id, kind: 'merged_duplicate', status: 'uncertain',
          before: '独立条目', after: `建议并入 ${target.id}`, mergedIntoAssetId: target.id,
          reason: '同正文不构成合并授权；自动检查只报告，保留双方身份与内容' };
        items.push(item);
        // 引用对端用 id，不落标题全文。
        uncertain.push({ assetId: source.id, question: `与资产 ${target.id} 正文相同，是否需要人工核对身份与归并影响？`, reason: item.reason });
        await patchReport(userId, reportId, () => ({ items: [...items], uncertain: [...uncertain] }));
        continue;
      }
    }

    // ③ 疑似重复（正文不同但字面高度重叠）：**这是含义判断，交给用户**。
    const candidates = pool.slice(0, NEAR_DUPLICATE_SCAN_LIMIT);
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const left = candidates[i];
        const right = candidates[j];
        if (left.type !== right.type) continue;
        if (left.status === 'active' && right.status === 'active' && comparableStatement(left.statement) === comparableStatement(right.statement)) continue;
        if (compareAndMaybeUncertain(left, right, uncertain)) {
          const entry = uncertain[uncertain.length - 1];
          await patchReport(userId, reportId, (report) => ({ uncertain: [...report.uncertain, entry] }));
        }
      }
    }

    // 同源多数标签只作为建议；不传播元数据，不改变资产版本或审计。
    const siblingsByFamily = new Map<string, RecallAbilityAssetRecord[]>();
    for (const member of pool) {
      if (!member.familyName) continue;
      const group = siblingsByFamily.get(member.familyName) || [];
      group.push(member);
      siblingsByFamily.set(member.familyName, group);
    }
    for (const asset of pool) {
      if (asset.status !== 'active') continue;
      if (asset.tags && asset.tags.length) continue;
      const siblings = (siblingsByFamily.get(asset.familyName || '') || [])
        .filter((member) => member.id !== asset.id);
      const counts = new Map<string, { count: number; name: string }>();
      for (const sibling of siblings) {
        for (const rawName of sibling.tags || []) {
          const name = String(rawName).trim();
          if (!name) continue;
          const key = name.toLocaleLowerCase();
          const entry = counts.get(key) || { count: 0, name };
          entry.count += 1;
          counts.set(key, entry);
        }
      }
      const consensus = [...counts.values()]
        .filter((entry) => entry.count >= TAG_CONSENSUS_MIN_SIBLINGS
          && entry.count >= Math.ceil(siblings.length * TAG_CONSENSUS_RATIO))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
      if (consensus.length) {
        const names = consensus.map((entry) => entry.name);
        const item: CleanupReportItem = { assetId: asset.id, kind: 'tag_added', status: 'uncertain',
          // 标签名是用户手写内容（purge 墓碑同口径清理面），只落条数。
          before: '（未分类）', after: `标签 ${names.length} 条`, reason: '自动检查只建议同源标签，等待逐条确认' };
        items.push(item);
        uncertain.push({ assetId: asset.id, question: `同源多数标签建议补充 ${names.length} 条，是否到详情页查看？`, reason: item.reason });
        await patchReport(userId, reportId, () => ({ items: [...items], uncertain: [...uncertain] }));
        continue;
      }

    }

    return await patchReport(userId, reportId, () => ({ finishedAt: new Date().toISOString(), items, uncertain }));
  } catch (error) {
    // 中断：报告保留已经形成的建议；资产与候选从未被本流程修改。
    log.warn('cleanup interrupted', { reportId, error: (error as Error).message });
    return await patchReport(userId, reportId, () => ({
      items,
      uncertain,
      interrupted: true,
      finishedAt: new Date().toISOString(),
    }));
  }
}

/** 命中近重复就推一条 uncertain（返回 true 表示推了）。 */
function compareAndMaybeUncertain(
  left: RecallAbilityAssetRecord,
  right: RecallAbilityAssetRecord,
  uncertain: CleanupUncertainItem[],
): boolean {
  const score = nearDuplicateScore(left.statement, right.statement);
  if (score < NEAR_DUPLICATE_THRESHOLD) return false;
  const older = String(left.updatedAt) <= String(right.updatedAt) ? left : right;
  const newer = older.id === left.id ? right : left;
  uncertain.push({
    assetId: older.id,
    // 对端引用用 id，不落标题全文。
    question: `这条和资产 ${newer.id} 看字面很像（${Math.round(score * 100)}%），要不要合并？`,
    reason: '正文不同但高度重叠：是不是同一个意思需要人来判，系统不擅自合并。',
  });
  return true;
}

/** 不合规问题码 → 报告里的人话。判定口径本体在 `title-policy.recallTitleIssue`
 *  （全模块唯一标准），这里只做展示文案，不另立判定。 */
/** 用户对"拿不准项"的处置：`dismissed`（不管它）/ `deferred`（回头再看）。 */
export async function decideCleanupUncertainItem(
  userId: string,
  reportId: string,
  assetId: string,
  decision: 'dismissed' | 'deferred',
): Promise<CleanupReport> {
  if (!safeId(assetId)) throw new Error('invalid ability asset id');
  const report = await readCleanupReport(userId, reportId);
  if (!report) throw new Error('cleanup report not found');
  if (!report.uncertain.some((entry) => entry.assetId === assetId)) {
    throw new Error('cleanup uncertain item not found');
  }
  return patchReport(userId, reportId, (current) => ({
    uncertain: current.uncertain.map((entry) => (
      entry.assetId === assetId ? { ...entry, decision } : entry
    )),
  }));
}

/** 未处置的拿不准项 → 待确认清单条目（`id` 前缀 `cleanup:` 供处置通道识别）。 */
export function pendingCleanupUncertainItems(
  reports: readonly CleanupReport[],
): Array<{ reportId: string; assetId: string; title?: string; question: string }> {
  return reports.flatMap((report) => report.uncertain
    .filter((entry) => !entry.decision)
    .map((entry) => ({
      reportId: report.id,
      assetId: entry.assetId,
      ...(entry.title ? { title: entry.title } : {}),
      question: entry.question,
    })));
}

/** Persist text-derived ownership before the asset loses its title/body. The
 * caller holds the cognition transition lock through this pass and tombstoning. */
export async function linkCleanupReportsToAsset(userId: string, assetId: string, markers: readonly string[]): Promise<void> {
  await sweepCleanupReportRows(userId, report => {
    const link = (row: CleanupReportItem | CleanupUncertainItem) => {
      const values = row as unknown as Record<string, unknown>;
      const matches = reportRowAssetIds(row).includes(assetId) || ['before', 'after', 'note', 'reason', 'title', 'question']
        .some(key => typeof values[key] === 'string' && markers.some(marker => marker && (values[key] as string).includes(marker)));
      return matches ? { ...row, contentAssetIds: [...new Set([...reportRowAssetIds(row), assetId])].sort() } : row;
    };
    return { ...report, items: report.items.map(link), uncertain: report.uncertain.map(link) } as CleanupReport;
  });
}

/** Failed reads or writes propagate so purge cannot report completion while a
 * retained copy survives. Ownership makes retry independent of erased text. */
export async function sweepPurgedAssetFromCleanupReports(userId: string, assetId: string, markers: readonly string[] = []): Promise<number> {
  return sweepCleanupReportRows(userId, report => {
    const clear = (group: string, row: CleanupReportItem | CleanupUncertainItem) => {
      const values = row as unknown as Record<string, unknown>;
      const matches = reportRowAssetIds(row).includes(assetId) || ['before', 'after', 'note', 'reason', 'title', 'question']
        .some(key => typeof values[key] === 'string' && markers.some(marker => marker && (values[key] as string).includes(marker)));
      return matches ? clearedReportRow(group, { ...row, contentAssetIds: [...new Set([...reportRowAssetIds(row), assetId])].sort() },
        row.contentPurgedAt || new Date().toISOString()) : row;
    };
    return { ...report, items: report.items.map(row => clear('items', row)), uncertain: report.uncertain.map(row => clear('uncertain', row)) } as CleanupReport;
  });
}

async function sweepCleanupReportRows(userId: string, transform: (report: CleanupReport) => CleanupReport): Promise<number> {
  let names: string[];
  try { names = await fs.readdir(reportsDirectory(userId)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  let swept = 0;
  for (const name of names) {
    if (!name.endsWith('.json') || !safeId(name.slice(0, -5))) continue;
    const id = name.slice(0, -5), raw = await readRecallJsonRecord(userId, 'cleanup-reports', id);
    if (!raw || JSON.stringify(transform(asReport(raw))) === JSON.stringify(asReport(raw))) continue;
    await updateRecallJsonRecord(userId, 'cleanup-reports', id, locked => {
      if (!locked) throw new Error('cleanup report not found');
      return transform(asReport(locked));
    });
    swept++;
  }
  return swept;
}

/** 旧专项入口继续可调用，但不再执行模型批量改写。返回明确的只检查报告。 */
export async function runAssetTitleRegenCleanup(userId: string, options: RunCleanupOptions = {}): Promise<CleanupReport> {
  return runAssetCleanup(userId, options);
}

export async function runAssetStatementRegenCleanup(userId: string, options: RunCleanupOptions = {}): Promise<CleanupReport> {
  return runAssetCleanup(userId, options);
}

export async function runCandidateStatementRegenCleanup(userId: string, options: RunCleanupOptions = {}): Promise<CleanupReport> {
  return runAssetCleanup(userId, options);
}

export async function runAssetFullCleanup(userId: string, options: RunCleanupOptions = {}): Promise<CleanupReport> {
  return runAssetCleanup(userId, options);
}
