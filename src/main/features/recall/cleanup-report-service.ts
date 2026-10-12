/**
 * 混乱内容大扫除与整理报告（specs/008 US-403）。
 *
 * 大扫除 = 对资产库做一轮批量整理，产出**逐项可核对、逐项可回滚**的整理报告。
 *
 * 三条硬口径：
 *   ① **只做不改变含义的整理**。改标题的空白/标点、把正文一字不差的同类型资产
 *      并成一条——这些不需要理解语义。凡是需要判断"这两条是不是一个意思""这条
 *      该归到哪类"的，一律进 `uncertain[]` 转待确认，**不擅自处置**。
 *   ② **补标签已接线（specs/012 T025）**：同源组内绝大多数已有同名标签的机械
 *      判定直接写入（`kind='tag_added'`）；够不上判据的含义判断进 `uncertain[]`。
 *      不映射到 `assetType` 或 `familyName`，`skippedSteps` 不再有"待 Epic 2 / 012"。
 *   ③ **`items[]` 与台账一一对应、每项可单独回滚**：每项带 `ledgerRef`（台账行）
 *      与 `rollbackAnchor`（回滚到哪一版），沿用 US-404 已建的锚点机制。
 *   ④ **标题重起轮（四病整改设计 3.3）＝含义生成，与 ① 分列**：
 *      `runAssetTitleRegenCleanup` 是独立的专项轮——只对统一口径
 *      （`title-policy` 的 3.1 判定）不合规的资产让 LLM 重新拟题并直接写入
 *      （`kind='title_regen'`）。它与 ① "只做不改变含义的整理"是**两种语义**：
 *      规则轮零模型、含义不动；重起轮改的正是标题含义。actor 用 'ai'（不用
 *      'user'——规则轮借用户名义的正当性建立在"机械步骤由系统代执行"上，
 *      模型产物不成立；'system' 会撞"自动线必须带评审交接"闸门）。开跑前
 *      模型预检，不过整轮失败上报；写前整库备份；不提供逐项回滚（拍板项 #7）。
 *
 * 中断恢复：报告**先落盘再逐项执行**，每执行完一项就写回报告——中断时已执行项
 * 全部有台账、可逐项回滚，未执行项保持原状，不会产生"改了一半没记账"的半状态。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { recallJsonRecordPath, recallRoot } from './paths';
import { readRecallJsonRecord, updateRecallJsonRecord, writeRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';
import {
  abilityAssetActiveVersion,
  listAbilityAssetAudit,
  listAbilityAssets,
  mergeAbilityAssets,
  updateAbilityAsset,
} from './asset-service';
import type { RecallAbilityAssetRecord } from './candidate-service';
import { recallTitleIssue } from './title-policy';
import { recallStatementIssues } from './statement-policy';
import type { AbilityAssetTitleIssue } from './title-policy';

const log = createLogger('recall.asset-cleanup');

export type CleanupItemKind = 'title_normalized' | 'merged_duplicate' | 'tag_added' | 'title_regen' | 'statement_regen' | 'candidate_statement_regen';
export type CleanupItemStatus = 'applied' | 'skipped' | 'uncertain' | 'failed';

export interface CleanupReportItem {
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

export interface CleanupUncertainItem {
  assetId: string;
  title?: string;
  /** 拿不准的是什么（用户据此决定要不要管）。 */
  question: string;
  reason: string;
  /** 用户处置后置位；未处置时缺省。 */
  decision?: 'dismissed' | 'deferred';
}

export interface CleanupReport extends RecallJsonRecord {
  id: string;
  trigger: 'user' | 'inspection';
  scope: { spaceId?: string; assetType?: string };
  /** 轮次（四病整改 3.3）：'rules'＝既有规则轮（含义不变的机械整理）；
   *  'title_regen'＝标题重起轮（LLM 含义生成）。旧报告无此字段＝规则轮。
   *  'full'＝三轮合一的完整整理（2026-09-29 拍板：日常整理/重新起标题/
   *  改写正文合并为一个「整理」，见 runAssetFullCleanup）。 */
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
  /** 本轮明确跳过的步骤。补标签已接线（specs/012 T025），不再因"字段未落地"跳过。 */
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

/**
 * 跑一轮大扫除。**先建报告再逐项执行**，每项落盘后才算执行完——中断时报告如实
 * 反映"做到哪了"，已执行项可逐项回滚。
 */
export async function runAssetCleanup(userId: string, options: RunCleanupOptions = {}): Promise<CleanupReport> {
  const scope = options.scope || {};
  const reportId = `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();
  const all = await listAbilityAssets(userId);
  let pool = all.filter((asset) => asset.status !== 'purged');
  if (scope.spaceId) pool = pool.filter((asset) => asset.spaceId === scope.spaceId);
  if (scope.assetType) pool = pool.filter((asset) => asset.type === scope.assetType);

  // 补标签已接线（specs/012 T025，见下方步骤 ④）：不再有"待 Epic 2 / 012"的
  // 跳过标注——机械可判定的直接写入，含义判断进 uncertain[]。字段保留给将来
  // 真正需要"本轮明确跳过"的步骤。
  const skippedSteps: string[] = [];

  await writeRecallJsonRecord(userId, 'cleanup-reports', reportId, {
    schemaVersion: 1,
    ownerId: userId,
    id: reportId,
    trigger: options.trigger || 'user',
    scope: { ...(scope.spaceId ? { spaceId: scope.spaceId } : {}), ...(scope.assetType ? { assetType: scope.assetType } : {}) },
    round: 'rules',
    items: [],
    uncertain: [],
    skippedSteps,
    createdAt,
    scanned: pool.length,
  } satisfies CleanupReport);

  const items: CleanupReportItem[] = [];
  const uncertain: CleanupUncertainItem[] = [];

  try {
    // ① 命名规范化：只动空白与结尾标点，不碰任何字面含义。
    for (const asset of pool) {
      const normalized = normalizeAssetTitle(asset.title);
      if (!normalized || normalized === asset.title) continue;
      const anchor = abilityAssetActiveVersion(asset);
      try {
        // actor='user'：这一轮是**用户发起**的，机械步骤由系统代执行。用 'system'
        // 会撞"自动线必须带评审交接"的闸门，而给大扫除凭空造一个评审决定会污染
        // appliedReviewDecisionIds（与到期清理那次同一个理由）；台账的 reason 里
        // 写着报告号，谁发起的、哪一轮，一目了然。
        await updateAbilityAsset(userId, asset.id, {
          title: normalized,
          reason: `大扫除：标题规范化（${reportId}）`,
          actor: 'user',
        });
        const ledgerRef = await lastAuditId(userId, asset.id);
        const item: CleanupReportItem = {
          assetId: asset.id,
          kind: 'title_normalized',
          status: 'applied',
          before: asset.title,
          after: normalized,
          reason: '标题只有空白或结尾标点不规范（含义未变）',
          ...(ledgerRef ? { ledgerRef } : {}),
          rollbackAnchor: anchor,
        };
        items.push(item);
        await patchReport(userId, reportId, (report) => ({ items: [...report.items, item] }));
      } catch (error) {
        const failed: CleanupReportItem = {
          assetId: asset.id,
          kind: 'title_normalized',
          status: 'failed',
          before: asset.title,
          after: normalized,
          reason: '标题规范化',
          note: (error as Error).message,
        };
        items.push(failed);
        await patchReport(userId, reportId, (report) => ({ items: [...report.items, failed] }));
        log.warn('cleanup title normalization failed', { assetId: asset.id, error: (error as Error).message });
      }
    }

    // ② 去重合并：**只并正文一字不差的同类型在用资产**（这不需要理解语义）。
    //    顺序：保留较新的那条，把较旧的并进去（source = 较旧）。
    const active = pool.filter((asset) => asset.status === 'active');
    const byStatement = new Map<string, RecallAbilityAssetRecord[]>();
    for (const asset of active) {
      const key = `${asset.type}\u0000${comparableStatement(asset.statement)}`;
      const group = byStatement.get(key) || [];
      group.push(asset);
      byStatement.set(key, group);
    }
    const mergedIds = new Set<string>();
    for (const group of byStatement.values()) {
      if (group.length < 2) continue;
      const ordered = [...group].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
      const target = ordered[0];
      for (const source of ordered.slice(1)) {
        if (mergedIds.has(source.id) || source.id === target.id) continue;
        const anchor = abilityAssetActiveVersion(target);
        try {
          await mergeAbilityAssets(userId, source.id, target.id, {
            actor: 'user',
            reason: `大扫除：正文一字不差的重复资产归并（${reportId}）`,
          });
          const ledgerRef = await lastAuditId(userId, target.id);
          const item: CleanupReportItem = {
            assetId: source.id,
            kind: 'merged_duplicate',
            status: 'applied',
            before: `独立条目（v${anchor}）`,
            after: `并入 ${target.id}`,
            reason: '正文与类型完全相同（一字不差），不需要判断语义',
            ...(ledgerRef ? { ledgerRef } : {}),
            rollbackAnchor: anchor,
            mergedIntoAssetId: target.id,
          };
          items.push(item);
          mergedIds.add(source.id);
          await patchReport(userId, reportId, (report) => ({ items: [...report.items, item] }));
        } catch (error) {
          const failed: CleanupReportItem = {
            assetId: source.id,
            kind: 'merged_duplicate',
            status: 'failed',
            before: '独立条目',
            after: `并入 ${target.id}`,
            reason: '重复资产归并',
            note: (error as Error).message,
          };
          items.push(failed);
          await patchReport(userId, reportId, (report) => ({ items: [...report.items, failed] }));
          log.warn('cleanup merge failed', { sourceAssetId: source.id, error: (error as Error).message });
        }
      }
    }

    // ③ 疑似重复（正文不同但字面高度重叠）：**这是含义判断，交给用户**。
    const candidates = pool.filter((asset) => !mergedIds.has(asset.id)).slice(0, NEAR_DUPLICATE_SCAN_LIMIT);
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const left = candidates[i];
        const right = candidates[j];
        if (left.type !== right.type) continue;
        if (compareAndMaybeUncertain(left, right, uncertain)) {
          const entry = uncertain[uncertain.length - 1];
          await patchReport(userId, reportId, (report) => ({ uncertain: [...report.uncertain, entry] }));
        }
      }
    }

    // ④ 补标签（specs/012 T025，接上 008 时代的跳过）：
    //    · 机械可判定 = 同源组（familyName 相同）内**绝大多数**已有同名标签 →
    //      传播的是既有事实，不需要理解语义，直接写入并进 `items[]`（写路径唯一
    //      走 `updateAbilityAsset` 的 tags 元数据路径：不 bump 版本、台账记
    //      「标签：旧 → 新」、带既有 rollbackAnchor）。
    //    · 够不上判据的一律是含义判断 → `uncertain[]` 转待确认（spec AC5），
    //      资产零改动；但库里还没有任何标签时不问——没有参考系，硬问等于让用户
    //      从零设计分类体系，那是标签管理（specs/012 US-201）的事。
    //    · 不映射到 assetType / familyName（另一套语义），不静默当做过。
    const uncertainAssetIds = new Set(uncertain.map((entry) => entry.assetId));
    const siblingsByFamily = new Map<string, RecallAbilityAssetRecord[]>();
    for (const member of pool) {
      if (!member.familyName) continue;
      const group = siblingsByFamily.get(member.familyName) || [];
      group.push(member);
      siblingsByFamily.set(member.familyName, group);
    }
    const libraryHasTags = all.some((member) => member.tags && member.tags.length);
    for (const asset of pool) {
      if (asset.status !== 'active' || mergedIds.has(asset.id)) continue;
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
        const anchor = abilityAssetActiveVersion(asset);
        const strongest = consensus[0];
        try {
          await updateAbilityAsset(userId, asset.id, {
            tags: names,
            reason: `大扫除：同源组「${asset.familyName}」多数已有同名标签，机械补标（${reportId}）`,
            actor: 'user',
          });
          const ledgerRef = await lastAuditId(userId, asset.id);
          const item: CleanupReportItem = {
            assetId: asset.id,
            kind: 'tag_added',
            status: 'applied',
            before: '（未分类）',
            after: names.join('、'),
            reason: `同源组「${asset.familyName}」内 ${strongest.count}/${siblings.length} 条已有同名标签（机械判定，不涉及语义）`,
            ...(ledgerRef ? { ledgerRef } : {}),
            rollbackAnchor: anchor,
          };
          items.push(item);
          await patchReport(userId, reportId, (report) => ({ items: [...report.items, item] }));
        } catch (error) {
          const failed: CleanupReportItem = {
            assetId: asset.id,
            kind: 'tag_added',
            status: 'failed',
            before: '（未分类）',
            after: names.join('、'),
            reason: '同源组多数标签补标',
            note: (error as Error).message,
          };
          items.push(failed);
          await patchReport(userId, reportId, (report) => ({ items: [...report.items, failed] }));
          log.warn('cleanup tag propagation failed', { assetId: asset.id, error: (error as Error).message });
        }
        continue;
      }
      if (libraryHasTags && !uncertainAssetIds.has(asset.id)) {
        const entry: CleanupUncertainItem = {
          assetId: asset.id,
          ...(asset.title ? { title: asset.title } : {}),
          question: '这条还没有主题标签，该归到哪类？',
          reason: '打什么标签是含义判断：系统只机械传播同源组里的多数标签，这一条够不上判据，不擅自打，交给你决定。',
        };
        uncertain.push(entry);
        uncertainAssetIds.add(asset.id);
        await patchReport(userId, reportId, (report) => ({ uncertain: [...report.uncertain, entry] }));
      }
    }

    return await patchReport(userId, reportId, () => ({ finishedAt: new Date().toISOString(), items, uncertain }));
  } catch (error) {
    // 中断：报告如实反映已执行的部分，已执行项全部有台账、可逐项回滚。
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
    ...(older.title ? { title: older.title } : {}),
    question: `这条和「${String(newer.title || newer.id).slice(0, 40)}」看字面很像（${Math.round(score * 100)}%），要不要合并？`,
    reason: '正文不同但高度重叠：是不是同一个意思需要人来判，系统不擅自合并。',
  });
  return true;
}

/** 不合规问题码 → 报告里的人话。判定口径本体在 `title-policy.recallTitleIssue`
 *  （全模块唯一标准），这里只做展示文案，不另立判定。 */
const TITLE_ISSUE_LABELS: Record<AbilityAssetTitleIssue, string> = {
  empty: '标题为空',
  too_long: '标题超长',
  prefix_overlap: '标题与正文开头重复',
  punctuation_suffix: '标题以标点结尾',
};

/** 标题重起轮的写前整库备份（设计 3.3 / 深探 F10/F13）：把 records/ability-assets
 *  全量复制到 records 目录**之外**（…/recall/backup-title-regen-<时间戳>/）——
 *  落进 records/ 会被 `listAbilityAssets` 的 readdir 当记录读入，污染 collection。
 *  目录名的时间戳取报告 createdAt（同源可对账），冒号/点去掉保文件名友好。
 *
 *  备份只作**恢复参考**：恢复走 `updateAbilityAsset` 正门逐条把标题改回（改前
 *  标题本就冻结在版本快照里、版本区可见），**不做 raw 写回**——绕版本链的
 *  raw 路径有终态/评审/快照分叉三重暗坑（深探 F10）。 */
async function backupAbilityAssetsForRegen(userId: string, createdAt: string, round: 'title_regen' | 'statement_regen'): Promise<string> {
  const records = path.join(recallRoot(userId), 'records', 'ability-assets');
  const backupDir = path.join(recallRoot(userId), `backup-${round}-${createdAt.replace(/[:.]/g, '')}`);
  const names = await fs.readdir(records);
  await fs.mkdir(backupDir, { recursive: true });
  for (const name of names) {
    const from = path.join(records, name);
    if ((await fs.stat(from)).isFile()) await fs.copyFile(from, path.join(backupDir, name));
  }
  return backupDir;
}

/**
 * 专项「标题重起」轮（设计 3.3，深探 F5/F9/F10/F11/F12/F13）。与规则轮
 * （`runAssetCleanup`）**分列**的硬口径（文件头 ④）：
 *
 * - **对象**：只对统一口径（`recallTitleIssue`）不合规的资产跑 LLM 重起
 *   （`suggestAbilityAssetTitle`——capture 同款模型链，自带预检与失败重试）；
 *   purged 墓碑随 pool 排除（不可改，深探 F7），合格资产免动。
 * - **actor='ai'**：模型产物如实记在模型名下。不用 'user'（借用户名义让模型
 *   改动绕过审计口径）；'system' 会撞"自动线必须带评审交接"闸门
 *   （asset-service 的 system asset action requires an automatic review handoff）。
 * - **模型预检**：开跑前 `hasConfiguredModelForUser`（含 OAuth 失效探测）——
 *   模型配置在加密文件里无法离线确证（深探 F11）；不过则**整轮失败上报**
 *   （直接抛错：不落报告、不备份、不写任何资产），绝不静默跳过。
 * - **写入路径**：每条都走 `updateAbilityAsset` 升版正门（禁止任何 raw 直改
 *   绕过版本链，深探 F10）；title 变更的 committed 投影刷新已由 asset-service
 *   收口闸门段统一挂上（设计 3.3 硬前提 / 深探 F6），本层不重复做。
 * - **分批与失败隔离**：逐项串行执行（每项＝一次 LLM 调用＋一次写入，独立
 *   try/catch）——LLM 调用不并发；单项失败/模型拒绝记 `failed`＋note 如实
 *   上报、不中断整轮；revoked/deleted 终态资产不烧模型调用，记 `skipped`＋
 *   note。每执行完一项就写回报告（进度反馈，与规则轮同款中断恢复协议）。
 *   串行写入期间每次 update 触及 3 个 collection（主记录/版本流/台账）的
 *   `cognition:changed` 广播，50ms 合并窗口内各 collection 至多合并为 1 条
 *   ——**渲染层的正确性来源是全量重拉**，后人不要按 recordId 做增量（深探 F13）。
 * - **回滚**：不提供逐项回滚（拍板项 #7：对纯改标题无意义，且恰把烂标题带回
 *   ——深探 F14）；报告项只留 before→after 对照＋版本锚点记录。个别不满意→
 *   资产详情手动编辑（现成入口且过 3.2 闸门）；整体兜底＝写前备份。
 */
export async function runAssetTitleRegenCleanup(
  userId: string,
  options: RunCleanupOptions = {},
): Promise<CleanupReport> {
  // 模型链与预检都走动态 import：规则轮与巡检（nearDuplicateScore）复用本模块
  // 时不必背上 runner 依赖图——candidate-service 起标题链同款先例。
  const { hasConfiguredModelForUser, getConfiguredModelOAuthExpiredMessage } = await import('../auth');
  if (!hasConfiguredModelForUser(userId).configured) {
    throw new Error('标题重起轮未执行：尚未配置可用模型（配置后重试）；不做静默跳过。');
  }
  const oauthExpired = getConfiguredModelOAuthExpiredMessage();
  if (oauthExpired) throw new Error(`标题重起轮未执行：${oauthExpired}`);

  const scope = options.scope || {};
  const reportId = `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();
  const all = await listAbilityAssets(userId);
  let pool = all.filter((asset) => asset.status !== 'purged');
  if (scope.spaceId) pool = pool.filter((asset) => asset.spaceId === scope.spaceId);
  if (scope.assetType) pool = pool.filter((asset) => asset.type === scope.assetType);
  const targets = pool
    .map((asset) => ({ asset, issue: recallTitleIssue(asset.title, asset.statement) }))
    .filter((entry): entry is { asset: RecallAbilityAssetRecord; issue: AbilityAssetTitleIssue } => entry.issue !== undefined);

  // 写前备份先于报告落盘与一切写入（只有真要写才留备份目录，空轮不留垃圾）。
  const backupDir = targets.length ? await backupAbilityAssetsForRegen(userId, createdAt, 'title_regen') : undefined;

  await writeRecallJsonRecord(userId, 'cleanup-reports', reportId, {
    schemaVersion: 1,
    ownerId: userId,
    id: reportId,
    trigger: options.trigger || 'user',
    scope: { ...(scope.spaceId ? { spaceId: scope.spaceId } : {}), ...(scope.assetType ? { assetType: scope.assetType } : {}) },
    round: 'title_regen',
    ...(backupDir ? { backupDir } : {}),
    items: [],
    uncertain: [],
    skippedSteps: [],
    createdAt,
    scanned: pool.length,
  } satisfies CleanupReport);

  const items: CleanupReportItem[] = [];
  try {
    const { suggestAbilityAssetTitle } = await import('./asset-title-suggestion');
    for (const { asset, issue } of targets) {
      // 终态资产（revoked/deleted）不可变更（assertMutableAbilityAsset 口径）：
      // 不烧模型调用，如实记 skipped——与"静默跳过"的区别是报告里有账。
      if (asset.status === 'revoked' || asset.status === 'deleted') {
        const skipped: CleanupReportItem = {
          assetId: asset.id,
          kind: 'title_regen',
          status: 'skipped',
          before: asset.title,
          after: '',
          reason: '标题重起',
          note: `${asset.status === 'revoked' ? '已撤销' : '已删除'}的资产不可修改，跳过重起`,
        };
        items.push(skipped);
        await patchReport(userId, reportId, (report) => ({ items: [...report.items, skipped] }));
        continue;
      }
      const anchor = abilityAssetActiveVersion(asset);
      try {
        const suggestion = await suggestAbilityAssetTitle(userId, {
          statement: asset.statement,
          type: asset.type,
        });
        // 正门写入：升版＋快照＋台账；title 变更的投影刷新由收口闸门段负责。
        await updateAbilityAsset(userId, asset.id, {
          title: suggestion.title,
          reason: `标题重起轮：标题不合规（${TITLE_ISSUE_LABELS[issue]}），模型按正文重新拟题（${reportId}）`,
          actor: 'ai',
        });
        const ledgerRef = await lastAuditId(userId, asset.id);
        const item: CleanupReportItem = {
          assetId: asset.id,
          kind: 'title_regen',
          status: 'applied',
          before: asset.title,
          after: suggestion.title,
          reason: `标题不合规（${TITLE_ISSUE_LABELS[issue]}），由模型按正文重新拟题`,
          ...(ledgerRef ? { ledgerRef } : {}),
          rollbackAnchor: anchor,
        };
        items.push(item);
        await patchReport(userId, reportId, (report) => ({ items: [...report.items, item] }));
      } catch (error) {
        const failed: CleanupReportItem = {
          assetId: asset.id,
          kind: 'title_regen',
          status: 'failed',
          before: asset.title,
          after: '',
          reason: '标题重起',
          note: (error as Error).message,
        };
        items.push(failed);
        await patchReport(userId, reportId, (report) => ({ items: [...report.items, failed] }));
        log.warn('cleanup title regen failed', { assetId: asset.id, error: (error as Error).message });
      }
    }
    return await patchReport(userId, reportId, () => ({ finishedAt: new Date().toISOString(), items }));
  } catch (error) {
    // 中断：报告如实反映已执行的部分（已执行项都有台账与版本锚点）。
    log.warn('cleanup title regen interrupted', { reportId, error: (error as Error).message });
    return await patchReport(userId, reportId, () => ({
      items,
      interrupted: true,
      finishedAt: new Date().toISOString(),
    }));
  }
}

async function lastAuditId(userId: string, assetId: string): Promise<string | undefined> {
  try {
    const rows = await listAbilityAssetAudit(userId, assetId);
    const last = rows[rows.length - 1];
    return typeof last?.id === 'string' ? last.id : undefined;
  } catch {
    return undefined;
  }
}

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

/**
 * 专项「正文改写」轮（2026-09-29 正文一等规范，子安拍板「全自动写入」）。
 * 与标题重起轮同骨架：统一口径圈选（recallStatementIssues）→ 写前整库备份
 * （records 之外）→ LLM 逐条改写（知识点不丢铁律）→ 正门写入（升版＋台账
 * ＋投影刷新由收口闸门段负责）→ 逐项审计与中断如实。actor='ai'。
 */
export async function runAssetStatementRegenCleanup(
  userId: string,
  options: RunCleanupOptions = {},
): Promise<CleanupReport> {
  const { hasConfiguredModelForUser, getConfiguredModelOAuthExpiredMessage } = await import('../auth');
  if (!hasConfiguredModelForUser(userId).configured) {
    throw new Error('正文改写轮未执行：尚未配置可用模型（配置后重试）；不做静默跳过。');
  }
  const oauthExpired = getConfiguredModelOAuthExpiredMessage();
  if (oauthExpired) throw new Error(`正文改写轮未执行：${oauthExpired}`);

  const scope = options.scope || {};
  const reportId = `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();
  const all = await listAbilityAssets(userId);
  let pool = all.filter((asset) => asset.status !== 'purged');
  if (scope.spaceId) pool = pool.filter((asset) => asset.spaceId === scope.spaceId);
  if (scope.assetType) pool = pool.filter((asset) => asset.type === scope.assetType);
  const targets = pool
    .map((asset) => ({ asset, issues: recallStatementIssues({ statement: asset.statement, type: asset.type }) }))
    .filter((entry) => entry.issues.length > 0);

  const backupDir = targets.length ? await backupAbilityAssetsForRegen(userId, createdAt, 'statement_regen') : undefined;

  await writeRecallJsonRecord(userId, 'cleanup-reports', reportId, {
    schemaVersion: 1,
    ownerId: userId,
    id: reportId,
    trigger: options.trigger || 'user',
    scope: { ...(scope.spaceId ? { spaceId: scope.spaceId } : {}), ...(scope.assetType ? { assetType: scope.assetType } : {}) },
    round: 'statement_regen',
    ...(backupDir ? { backupDir } : {}),
    items: [],
    uncertain: [],
    skippedSteps: [],
    createdAt,
    scanned: pool.length,
  } satisfies CleanupReport);

  const items: CleanupReportItem[] = [];
  try {
    const { suggestAbilityAssetStatement } = await import('./asset-statement-rewrite');
    for (const { asset, issues } of targets) {
      if (asset.status === 'revoked' || asset.status === 'deleted') {
        const skipped: CleanupReportItem = {
          assetId: asset.id, kind: 'statement_regen', status: 'skipped',
          before: (asset.statement || '').slice(0, 80), after: '',
          reason: '正文改写', note: `${asset.status === 'revoked' ? '已撤销' : '已删除'}的资产不可修改，跳过改写`,
        };
        items.push(skipped);
        await patchReport(userId, reportId, (report) => ({ items: [...report.items, skipped] }));
        continue;
      }
      const anchor = abilityAssetActiveVersion(asset);
      try {
        const rewrite = await suggestAbilityAssetStatement(userId, {
          statement: asset.statement || '',
          type: asset.type,
          title: asset.title,
        });
        await updateAbilityAsset(userId, asset.id, {
          statement: rewrite.statement,
          reason: `正文改写轮：${issues.join('、')}（${reportId}）`,
          actor: 'ai',
        });
        const ledgerRef = await lastAuditId(userId, asset.id);
        const item: CleanupReportItem = {
          assetId: asset.id, kind: 'statement_regen', status: 'applied',
          before: (asset.statement || '').slice(0, 80),
          after: rewrite.statement.slice(0, 80),
          reason: `正文问题：${issues.join('、')}，模型按规范改写（知识点不丢铁律）`,
          ...(ledgerRef ? { ledgerRef } : {}),
          rollbackAnchor: anchor,
        };
        items.push(item);
        await patchReport(userId, reportId, (report) => ({ items: [...report.items, item] }));
      } catch (error) {
        const failed: CleanupReportItem = {
          assetId: asset.id, kind: 'statement_regen', status: 'failed',
          before: (asset.statement || '').slice(0, 80), after: '',
          reason: '正文改写', note: (error as Error).message,
        };
        items.push(failed);
        await patchReport(userId, reportId, (report) => ({ items: [...report.items, failed] }));
        log.warn('cleanup statement regen failed', { assetId: asset.id, error: (error as Error).message });
      }
    }
    return await patchReport(userId, reportId, () => ({ finishedAt: new Date().toISOString(), items }));
  } catch (error) {
    log.warn('cleanup statement regen interrupted', { reportId, error: (error as Error).message });
    return await patchReport(userId, reportId, () => ({
      items,
      interrupted: true,
      finishedAt: new Date().toISOString(),
    }));
  }
}

/* ───────── 完整整理（三轮合一，2026-09-29 拍板） ─────────
 * 日常整理、重新起标题、改写正文在用户面前合并为**一个「整理」**：一次调用
 * 顺序跑 规则轮 → 标题重起轮 → 正文改写轮，产出一份合并报告（round:'full'）。
 * 分轮报告照常落盘——每轮自己的台账、版本锚点、写前备份原样保留（回滚凭据
 * 不变），只是列表层按 supersededBy 隐藏分轮、只露合并报告：历史不丢，界面
 * 不重复。模型未配置时两个 LLM 轮整轮失败上报（各轮既有硬口径），合并层
 * 接住记入 roundErrors——规则轮成果不陪葬，调用方如实展示，不静默。 */
export async function runAssetFullCleanup(
  userId: string,
  options: RunCleanupOptions = {},
): Promise<CleanupReport> {
  const roundErrors: NonNullable<CleanupReport['roundErrors']> = {};
  const rules = await runAssetCleanup(userId, options);
  let title: CleanupReport | undefined;
  let statement: CleanupReport | undefined;
  // 候选正文改写轮（2026-09-29 根治收口）：full 必含——池里的超长候选正文
  // 只有这一条存量出口（入池闸门只管新生成）；改的是候选不是资产，不属
  // 「睡着时改资产」的范畴。
  let candidateStatement: CleanupReport | undefined;
  try {
    title = await runAssetTitleRegenCleanup(userId, options);
  } catch (error) {
    roundErrors.title_regen = (error as Error).message;
  }
  try {
    statement = await runAssetStatementRegenCleanup(userId, options);
  } catch (error) {
    roundErrors.statement_regen = (error as Error).message;
  }
  try {
    candidateStatement = await runCandidateStatementRegenCleanup(userId, options);
  } catch (error) {
    roundErrors.candidate_statement_regen = (error as Error).message;
  }
  const parts = [rules, title, statement, candidateStatement].filter((report): report is CleanupReport => Boolean(report));
  const mergedId = `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const scope = options.scope || {};
  const backupDirs = [title?.backupDir, statement?.backupDir, candidateStatement?.backupDir].filter((dir): dir is string => Boolean(dir));
  const written = await writeRecallJsonRecord(userId, 'cleanup-reports', mergedId, {
    schemaVersion: 1,
    ownerId: userId,
    id: mergedId,
    trigger: options.trigger || 'user',
    scope: { ...(scope.spaceId ? { spaceId: scope.spaceId } : {}), ...(scope.assetType ? { assetType: scope.assetType } : {}) },
    round: 'full',
    subReportIds: parts.map((report) => report.id),
    ...(backupDirs.length ? { backupDirs } : {}),
    ...(Object.keys(roundErrors).length ? { roundErrors } : {}),
    items: parts.flatMap((report) => report.items),
    uncertain: parts.flatMap((report) => report.uncertain),
    skippedSteps: parts.flatMap((report) => report.skippedSteps),
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    interrupted: parts.some((report) => report.interrupted) || undefined,
    scanned: parts.reduce((total, report) => total + report.scanned, 0),
  });
  // 分轮标记被合并：列表只露合并报告（标记失败不让合并本身失败——下一轮
  // 完整整理仍会把新报告顶到最前）。
  for (const report of parts) {
    try {
      await patchReport(userId, report.id, () => ({ supersededBy: mergedId }));
    } catch (error) {
      log.warn('cleanup full merge supersede failed', { reportId: report.id, error: (error as Error).message });
    }
  }
  return asReport(written);
}

/* ───────── 候选正文改写轮（2026-09-29 存量统一处理批） ─────────
 * 与资产正文轮（runAssetStatementRegenCleanup）同形态：判定同口径
 * （recallStatementIssues——候选读时派生 statementIssues 就是它）、LLM 同
 * 函数（suggestAbilityAssetStatement，judgment↔statement、suggestedType↔type、
 * summary↔title 对位）、写前整池备份、逐条落 cleanup-reports。
 * 硬边界：
 *  - 只动**可操作域**候选（observed/weak_observation/pending_review/deferred）；
 *    终态（confirmed/rejected/ignored/expired/superseded）一律不碰——终态不可
 *    变是状态机红线（09-28 修过 deleted 复活）；
 *  - 标题（summary）与 value 不动——09-28 标题一等化已定稿，value 是独立
 *    字段（为什么有用），超长的是 judgment 正文；
 *  - scope 非枚举的脏数据不机械归一（语义没法机器判），进 uncertain 人工定。 */
export async function runCandidateStatementRegenCleanup(
  userId: string,
  options: RunCleanupOptions = {},
): Promise<CleanupReport> {
  const { hasConfiguredModelForUser, getConfiguredModelOAuthExpiredMessage } = await import('../auth');
  if (!hasConfiguredModelForUser(userId).configured) {
    throw new Error('候选正文改写轮未执行：尚未配置可用模型（配置后重试）；不做静默跳过。');
  }
  const oauthExpired = getConfiguredModelOAuthExpiredMessage();
  if (oauthExpired) throw new Error(`候选正文改写轮未执行：${oauthExpired}`);

  const createdAt = new Date().toISOString();
  const reportId = `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const { listRecallCandidates } = await import('./candidate-service');
  const ACTIONABLE = ['observed', 'weak_observation', 'pending_review', 'deferred'];
  const pool = (await listRecallCandidates(userId))
    .filter((candidate) => ACTIONABLE.includes(String(candidate.status)));
  const SCOPE_ENUM = new Set(['general', 'global', 'report', 'code', 'review', 'product']);
  const targets = pool
    .map((candidate) => ({
      candidate,
      issues: recallStatementIssues({ statement: candidate.judgment, type: candidate.suggestedType }),
      dirtyScope: Boolean(String(candidate.suggestedScope || '').trim()) && !SCOPE_ENUM.has(String(candidate.suggestedScope || '').trim().toLowerCase()),
    }))
    .filter((entry) => entry.issues.length > 0 || entry.dirtyScope);

  const backupDir = targets.length ? await backupCandidatesForRegen(userId, createdAt) : undefined;

  await writeRecallJsonRecord(userId, 'cleanup-reports', reportId, {
    schemaVersion: 1,
    ownerId: userId,
    id: reportId,
    trigger: options.trigger || 'user',
    scope: {},
    round: 'candidate_statement_regen',
    ...(backupDir ? { backupDir } : {}),
    items: [],
    uncertain: [],
    skippedSteps: [],
    createdAt,
    scanned: pool.length,
  } satisfies CleanupReport);

  const { updateRecallCandidate } = await import('./candidate-service');
  const { suggestAbilityAssetStatement } = await import('./asset-statement-rewrite');
  const items: CleanupReportItem[] = [];
  const uncertain: CleanupUncertainItem[] = [];
  try {
    for (const { candidate, issues, dirtyScope } of targets) {
      if (dirtyScope && !issues.length) {
        const flagged: CleanupUncertainItem = {
          assetId: candidate.id,
          question: '候选的适用范围是自由文本，不是标准选项',
          reason: `scope＝「${String(candidate.suggestedScope).slice(0, 40)}」，无法机械归一——请在确认该候选时改为 通用/报告/编程/审查/产品 之一`,
        };
        uncertain.push(flagged);
        await patchReport(userId, reportId, (report) => ({ uncertain: [...report.uncertain, flagged] }));
        continue;
      }
      try {
        const rewrite = await suggestAbilityAssetStatement(userId, {
          statement: candidate.judgment || '',
          type: candidate.suggestedType,
          title: candidate.summary,
        });
        const recheck = recallStatementIssues({ statement: rewrite.statement, type: candidate.suggestedType });
        if (recheck.length) {
          const skipped: CleanupReportItem = {
            assetId: candidate.id, kind: 'candidate_statement_regen', status: 'skipped',
            before: (candidate.judgment || '').slice(0, 80), after: '',
            reason: '候选正文改写', note: `改写结果仍未过规范（${recheck.join('、')}），不落盘，留待人工确认时编辑`,
          };
          items.push(skipped);
          await patchReport(userId, reportId, (report) => ({ items: [...report.items, skipped] }));
          continue;
        }
        await updateRecallCandidate(userId, candidate.id, {
          judgment: rewrite.statement,
          value: candidate.value ?? undefined,
          summary: candidate.summary,
          uncertainty: candidate.uncertainty ?? undefined,
          suggestedType: candidate.suggestedType,
          suggestedScope: candidate.suggestedScope,
          suggestedAction: candidate.suggestedAction,
          sourceRefs: candidate.sourceRefs,
          evidenceRefs: candidate.evidenceRefs,
        });
        const item: CleanupReportItem = {
          assetId: candidate.id, kind: 'candidate_statement_regen', status: 'applied',
          before: (candidate.judgment || '').slice(0, 80),
          after: rewrite.statement.slice(0, 80),
          reason: `候选正文问题：${issues.join('、')}，模型按规范改写（知识点不丢铁律）`,
        };
        items.push(item);
        await patchReport(userId, reportId, (report) => ({ items: [...report.items, item] }));
      } catch (error) {
        const failed: CleanupReportItem = {
          assetId: candidate.id, kind: 'candidate_statement_regen', status: 'failed',
          before: (candidate.judgment || '').slice(0, 80), after: '',
          reason: '候选正文改写', note: (error as Error).message,
        };
        items.push(failed);
        await patchReport(userId, reportId, (report) => ({ items: [...report.items, failed] }));
        log.warn('cleanup candidate statement regen failed', { candidateId: candidate.id, error: (error as Error).message });
      }
    }
    return await patchReport(userId, reportId, () => ({ finishedAt: new Date().toISOString(), items, uncertain }));
  } catch (error) {
    log.warn('cleanup candidate statement regen interrupted', { reportId, error: (error as Error).message });
    return await patchReport(userId, reportId, () => ({
      items,
      uncertain,
      interrupted: true,
      finishedAt: new Date().toISOString(),
    }));
  }
}

/** 候选池整池备份（改写轮写前）：与资产轮同式，目录名区分轮次。 */
async function backupCandidatesForRegen(userId: string, createdAt: string): Promise<string> {
  const records = path.join(recallRoot(userId), 'records', 'candidates');
  const backupDir = path.join(recallRoot(userId), `backup-candidate_statement_regen-${createdAt.replace(/[:.]/g, '')}`);
  const names = await fs.readdir(records);
  await fs.mkdir(backupDir, { recursive: true });
  for (const name of names) {
    const from = path.join(records, name);
    if ((await fs.stat(from)).isFile()) await fs.copyFile(from, path.join(backupDir, name));
  }
  return backupDir;
}
