/**
 * 会议产物沉淀账本 —— append-only JSONL，机器私有派生物。
 *
 * 位置：`<uid>/local/cogseed/transcript/meeting-precipitation.jsonl`
 * （与既有 `meeting-metrics.jsonl` 同域；见 `paths.ts` 的域划分说明：
 * 会议侧「用户可复核的私人资产」进 cloud，「机器私有派生物」进 local。）
 *
 * 职责边界（重要，别误用）：
 *   - **不是**幂等的权威来源。幂等以「目标是否已存在」为准（`copyContextEntryFromPath`
 *     的 `target_exists` / 上传前查重）。账本损坏或丢失**不会**导致重复沉淀。
 *   - 它解决的是另两件事：① 失败原因持久化，以支持「单项重试」；② 让「已跳过」与
 *     「新增」可区分（否则只剩「写不进去」一种信号）。
 *   - 因此读侧允许降级：任何一行解析失败都跳过并计数，绝不让账本问题阻断沉淀主链路。
 *
 * 隐私硬约束（宪章 §III）：本文件**任何字段都不得包含会议正文**。
 * 允许：相对路径、短码（错误分类）、标识（uid/docKey/spaceId）、时间戳、计数。
 * 禁止：转写文本、纪要正文、待办内容、参会人姓名、任何正文片段。
 * `assertNoContentLikeFields` 在写入前做结构性防御，防止后续有人顺手塞进正文。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userMeetingPrecipitationLedgerFile } from '../paths';
import { appendJsonl, readJsonl } from '../storage';
import { createLogger } from '../logger';

const log = createLogger('meeting-precipitation-ledger');

/** 结果分类。`skipped` 必须带 `reason` 才能让用户看出「为什么没进」。 */
export type PrecipitationLedgerResult = 'added' | 'skipped' | 'failed';

/** 跳过 / 失败原因短码。**只能是短码**，不得是正文或自由文本。 */
export type PrecipitationLedgerReason =
  | 'exists'          // 目标已存在（同名同路径）
  | 'concurrent'      // 并发双触发被收敛
  | 'discarded'       // 已被用户丢弃（规格 FR-029 不沉淀）
  | 'not_indexable'   // 扩展名不在知识库可索引白名单内
  | 'empty'           // 空内容（规格 FR-016 不写占位）
  | 'no_source'       // 事件里既没有路径也没有内容
  | 'source_missing'  // 源文件已不存在
  | 'target_unwritable'
  | 'target_unavailable'
  | 'target_verify_failed' // 写入成功但回读字节不一致
  | 'rejected';       // 其他被拒（含越权目标）

export interface PrecipitationLedgerEntry {
  ts: string;
  doc_key: string;
  artifact_kind: string;
  target_scope: 'global' | 'space';
  target_space_id?: string;
  target_rel: string;
  result: PrecipitationLedgerResult;
  reason?: PrecipitationLedgerReason;
  version?: string;
  trigger: string;
}

/** 允许出现在账本里的字段白名单。任何白名单外的键一律拒收 —— 结构性防正文泄漏。 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'ts', 'doc_key', 'artifact_kind', 'target_scope', 'target_space_id',
  'target_rel', 'result', 'reason', 'version', 'trigger',
]);

/** 单个字段值的长度上限。路径/短码/标识都远小于此；正文会立刻撞上限。 */
const MAX_FIELD_CHARS = 512;

export interface LedgerAppendOutcome {
  ok: boolean;
  /** 被拒时的原因（用于日志诊断；不抛给调用方）。 */
  rejection?: 'unknown_key' | 'field_too_long' | 'invalid_shape';
}

/**
 * 结构性防御：拒绝任何白名单外的键、任何超长字段值。
 * 这不是「内容检测」（那不可靠），而是让「顺手塞正文」在结构上直接失败。
 */
function validateEntry(entry: Record<string, unknown>): LedgerAppendOutcome {
  for (const key of Object.keys(entry)) {
    if (!ALLOWED_KEYS.has(key)) return { ok: false, rejection: 'unknown_key' };
  }
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value === 'string' && value.length > MAX_FIELD_CHARS) {
      return { ok: false, rejection: 'field_too_long' };
    }
  }
  if (typeof entry.ts !== 'string' || typeof entry.doc_key !== 'string' || typeof entry.target_rel !== 'string') {
    return { ok: false, rejection: 'invalid_shape' };
  }
  return { ok: true };
}

/**
 * 追加一条沉淀记录。
 *
 * 契约：**永不抛异常**。账本写失败不能影响沉淀结果本身（沉淀已经落盘到知识库了），
 * 只记一条日志。返回 `ok:false` 供调用方在诊断时使用。
 */
export async function appendPrecipitationEntry(
  uid: string,
  entry: PrecipitationLedgerEntry,
): Promise<LedgerAppendOutcome> {
  const check = validateEntry(entry as unknown as Record<string, unknown>);
  if (!check.ok) {
    log.warn('precipitation ledger entry rejected', {
      rejection: check.rejection,
      doc_key: entry?.doc_key,
      artifact_kind: entry?.artifact_kind,
    });
    return check;
  }
  try {
    await appendJsonl(userMeetingPrecipitationLedgerFile(uid), entry);
    return { ok: true };
  } catch (err) {
    log.warn('precipitation ledger append failed', {
      doc_key: entry.doc_key,
      error: (err as Error)?.message,
    });
    return { ok: false };
  }
}

export interface LedgerReadOutcome {
  entries: PrecipitationLedgerEntry[];
  /** 解析失败被跳过的行数（降级证据，供诊断）。 */
  malformed: number;
}

/**
 * 读取账本。按时间顺序返回（append 顺序）。
 *
 * 降级策略：逐行解析，坏行跳过并计数 —— 单行损坏不得让整个账本不可读。
 * `limit` 语义沿用 `readJsonl`（取末尾 N 条）。
 */
export async function readPrecipitationLedger(uid: string, limit = 500): Promise<LedgerReadOutcome> {
  const file = userMeetingPrecipitationLedgerFile(uid);
  let raw: unknown[];
  try {
    raw = await readJsonl<unknown>(file, limit);
  } catch (err) {
    log.warn('precipitation ledger read failed', { error: (err as Error)?.message });
    return { entries: [], malformed: 0 };
  }

  const entries: PrecipitationLedgerEntry[] = [];
  let malformed = 0;
  for (const row of raw) {
    if (!row || typeof row !== 'object') { malformed += 1; continue; }
    const e = row as Partial<PrecipitationLedgerEntry>;
    if (typeof e.doc_key !== 'string' || typeof e.target_rel !== 'string' || typeof e.result !== 'string') {
      malformed += 1;
      continue;
    }
    entries.push(e as PrecipitationLedgerEntry);
  }
  return { entries, malformed };
}

export interface RetryablePrecipitation {
  docKey: string;
  artifactKind: string;
  targetRel: string;
  error: string;
  at: string;
}

/**
 * 列出可重试的失败项（规格 FR-020 / 契约 A3 `listRetryablePrecipitations`）。
 *
 * 折叠语义（data-model E4）：以 `(doc_key, artifact_kind, target_rel)` 为单位看**最后一条**记录；
 * 仅当最后一条是 `failed` 时才算可重试。若后续已有 `added`/`skipped`，
 * 说明该失败已被解决，**不再列给用户** —— 否则用户会看到一堆早已修好的陈年失败项。
 */
export async function listRetryablePrecipitations(
  uid: string,
  docKey?: string,
): Promise<RetryablePrecipitation[]> {
  const { entries } = await readPrecipitationLedger(uid, 2000);
  const latest = new Map<string, PrecipitationLedgerEntry>();
  for (const e of entries) {
    if (docKey && e.doc_key !== docKey) continue;
    const key = `${e.doc_key}\u0000${e.artifact_kind}\u0000${e.target_rel}`;
    latest.set(key, e); // append 顺序 → 后写覆盖前写
  }
  const out: RetryablePrecipitation[] = [];
  for (const e of latest.values()) {
    if (e.result !== 'failed') continue;
    out.push({
      docKey: e.doc_key,
      artifactKind: e.artifact_kind,
      targetRel: e.target_rel,
      error: e.reason || 'unknown',
      at: e.ts,
    });
  }
  out.sort((a, b) => b.at.localeCompare(a.at));
  return out;
}

/** 账本文件绝对路径（供诊断与测试断言；调用方不应直接读写）。 */
export function precipitationLedgerPath(uid: string): string {
  return userMeetingPrecipitationLedgerFile(uid);
}

/** 账本是否存在（不抛）。 */
export function precipitationLedgerExists(uid: string): boolean {
  try {
    return fs.existsSync(precipitationLedgerPath(uid));
  } catch {
    return false;
  }
}

/** 账本所在目录（供清理与诊断）。 */
export function precipitationLedgerDir(uid: string): string {
  return path.dirname(precipitationLedgerPath(uid));
}
