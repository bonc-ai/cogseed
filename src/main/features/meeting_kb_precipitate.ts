/**
 * 会议产物沉淀编排 —— 把一份会议成果落进知识库，并即刻入队索引。
 *
 * 为什么必须新建（现状调查结论，见 specs/009-meeting-output-archive/research.md R1/R3）：
 *   现有 `kb_task_auto_archive.ts` 的唯一输入是消息 `produced[]`（只由模型调用
 *   `publish_outputs` 写入），而会议四件套全部由 feature 直接落盘或走 `writeContextFile`，
 *   **不经过产物登记** → 现有归档永远收不到它们。这就是用户机器上「8 份会议产物一份未入库」的根因。
 *   所以沉淀的触发与取数都必须在宿主侧新建。
 *
 * 契约（对应 specs/009-meeting-output-archive/contracts/README.md A3）：
 *   - **幂等**：重复沉淀同一份产物不产生重复条目。权威判据是「目标是否已存在」
 *     （`copyContextEntryFromPath` 写前检查并返回 `target_exists`），**不依赖账本**。
 *   - **不覆盖**：目标已存在的条目原样保留，绝不改写（规格 FR-005）。
 *   - **不抛**：任何失败都转成 `PrecipitationOutcome.failed`，绝不向调用方抛异常 ——
 *     沉淀失败不得让会议主流程失败（规格 FR-004）。
 *   - **不迁移**：本模块**不含任何 move/rename/delete 调用**。目标改判只影响后续产物，
 *     既有条目留在原处（规格 FR-011）。这条是结构性保证，不是"记得别写"。
 *
 * 并发收敛（FR-032）：内存 in-flight 集合按 `uid|docKey|artifactKind|target` 去重，
 * 把"环节事件"与"IPC 动作落点"两条触发路径收敛为一次有效沉淀。正确性仍由磁盘存在性兜底，
 * 内存集合只是减少无谓的重复拷贝尝试。
 *
 * uid 作用域说明：既有知识库原语（`createContextDir` / `copyContextEntryFromPath`）
 * 内部用 `getActiveUserId()` 解析个人库根 —— 这与既有 `kb_task_auto_archive` 的做法一致。
 * 空间库原语 `uploadSpaceFile(userId, spaceId, ...)` 显式收 uid。单用户桌面应用的既有约定，
 * 本模块不改变它（改变它属于独立重构，不在本规格范围）。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../logger';
import { maskId } from '../util/log-redact';
import * as contexts from './contexts';
import * as spaceFiles from './project_files';
import { resolveArchiveTarget, type ArchiveTarget } from './meeting_archive_target';
import {
  appendPrecipitationEntry,
  readPrecipitationLedger,
  type PrecipitationLedgerReason,
} from './meeting_artifact_ledger';
import { subscribeMeetingStages } from './meeting_stage_events';
import { subscribeProducedOutputs } from './produced_outputs_bus';
import { readNativeRuntimeSession } from './cogseed_runtime/kernel/session-store';
import { collectRuntimeWrittenPaths } from './cogseed_backend/runtime-written-paths';
import type { MeetingArtifactKind, MeetingStageEvent } from './meeting_stage_events';

const log = createLogger('meeting-kb-precipitate');

/** 触发源 —— 用于验证三层触发（环节事件 / 动作落点 / 终态兜底）各自生效。 */
export type PrecipitationTrigger = 'stage_event' | 'ipc_action' | 'terminal_sweep';

export type SkipReason =
  | 'exists'
  | 'concurrent'
  | 'discarded'
  | 'not_indexable'
  | 'empty'
  | 'no_source'
  | 'source_missing';

export interface PrecipitationOutcome {
  docKey: string;
  target: ArchiveTarget;
  added: string[];
  skipped: Array<{ rel: string; reason: SkipReason }>;
  failed: Array<{ rel: string; error: string }>;
  durationMs: number;
  trigger: PrecipitationTrigger;
}

/** 知识库可索引的扩展名（与 `kb_indexer.kindFor` 同源语义；不支持的类型不写盘）。 */
const INDEXABLE_EXTS: ReadonlySet<string> = new Set<string>([
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
  '.html', '.htm', '.xml', '.toml', '.ini', '.conf',
  '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sh', '.bash', '.zsh', '.ps1', '.cmd', '.bat', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.cc', '.h', '.hpp', '.css', '.scss', '.less',
  '.sql', '.graphql', '.gql',
  '.pdf', '.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm',
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
]);

function isIndexableName(name: string): boolean {
  const base = path.basename(name);
  if (!base || base.startsWith('.') || base === '_INDEX.md') return false;
  return INDEXABLE_EXTS.has(path.extname(base).toLowerCase());
}

/** 产物类别 → 目标文件名后缀（用于「无源文件名」时的兜底命名）。 */
const KIND_SUFFIX: Record<MeetingArtifactKind, string> = {
  transcript: '转写.md',
  corrected_transcript: '转写-纠错.md',
  minutes: '会议纪要.md',
  actions: '任务清单.md',
};

/**
 * 解析该产物的目标文件名。
 *
 * **必须确定性**：同一 `(artifactKind, version)` 恒得同一文件名。
 * 为什么这是硬要求：幂等靠「目标是否已存在」判定（`target_exists`），而目标由本函数产出。
 * 若文件名依赖**源文件路径的 basename**，源文件一改名就会算出新目标 → 幂等失效 →
 * 知识库里堆出多份内容相同的副本。所以这里**刻意不使用源文件名**。
 *
 * 版本标记插在扩展名之前（`纪要_v002.md`），保证 v001/v002 共存而不互相覆盖
 * （规格 FR-005：保留全部历史版本）。
 */
export function artifactFileName(event: MeetingStageEvent): string | null {
  const suffix = KIND_SUFFIX[event.artifactKind];
  if (!suffix) return null;
  const ext = path.extname(suffix) || '.md';
  const stem = suffix.slice(0, suffix.length - ext.length);
  const rawVersion = typeof event.version === 'string' ? event.version.trim() : '';
  // 版本段必须自身安全：只留 [A-Za-z0-9._-]，折叠连续分隔符，防点/横线开头。
  const safeVersion = rawVersion
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+/, '')
    .slice(0, 64);

  const name = safeVersion ? `${stem}_${safeVersion}${ext}` : `${stem}${ext}`;
  if (!isIndexableName(name)) return null;
  return name;
}

// ── 并发收敛 ─────────────────────────────────────────────────────────────

/** in-flight 键 → 说明有一次沉淀正在处理中。挂在 globalThis 以兼容双模块加载形态。 */
const INFLIGHT_KEY = Symbol.for('cogseed.meetingPrecipitation.inflight');

function inflightSet(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  let s = g[INFLIGHT_KEY];
  if (!s) { s = new Set<string>(); g[INFLIGHT_KEY] = s; }
  return s;
}

function inflightKey(uid: string, docKey: string, kind: MeetingArtifactKind, target: ArchiveTarget): string {
  return [uid, docKey, kind, target.scope, target.spaceId || '', target.libraryRelPath, target.meetingDirRelPath].join('|');
}

// ── 主流程 ───────────────────────────────────────────────────────────────

async function recordLedger(
  uid: string,
  event: MeetingStageEvent,
  target: ArchiveTarget,
  targetRel: string,
  result: 'added' | 'skipped' | 'failed',
  trigger: PrecipitationTrigger,
  reason?: PrecipitationLedgerReason,
): Promise<void> {
  await appendPrecipitationEntry(uid, {
    ts: new Date().toISOString(),
    doc_key: event.docKey,
    artifact_kind: event.artifactKind,
    target_scope: target.scope,
    ...(target.spaceId ? { target_space_id: target.spaceId } : {}),
    target_rel: targetRel,
    result,
    ...(reason ? { reason } : {}),
    ...(event.version ? { version: event.version } : {}),
    trigger,
  });
}

function emptyOutcome(
  event: MeetingStageEvent,
  target: ArchiveTarget,
  trigger: PrecipitationTrigger,
  startedAt: number,
): PrecipitationOutcome {
  return {
    docKey: event.docKey,
    target,
    added: [],
    skipped: [],
    failed: [],
    durationMs: Date.now() - startedAt,
    trigger,
  };
}

/**
 * 沉淀一份会议产物。**永不抛异常**。
 *
 * 返回的 `PrecipitationOutcome` 里 `added` / `skipped` / `failed` 三者的并集
 * 即本次考虑的全部候选（data-model INV-4）。
 */
export async function precipitateMeetingArtifact(
  uid: string,
  event: MeetingStageEvent,
  trigger: PrecipitationTrigger,
  options: { explicitLibrary?: string | null } = {},
): Promise<PrecipitationOutcome> {
  const startedAt = Date.now();

  // 先用"解析失败也要能返回 outcome"的姿态把 target 占位出来。
  const fallbackTarget: ArchiveTarget = {
    scope: 'global',
    libraryRelPath: '',
    archiveRootRelPath: 'meetings',
    meetingDirRelPath: `meetings/${event?.docKey || 'unknown'}`,
    resolvedBy: 'personal',
    explanationKey: 'meeting.precipitation.target.personal',
  };

  try {
    if (!event || typeof event !== 'object' || !event.docKey) {
      return emptyOutcome(event, fallbackTarget, trigger, startedAt);
    }

    // 规格 FR-029：已丢弃的待办草稿不是成果，直接忽略（并记账，便于用户看出"没存"的原因）。
    if (event.stage === 'action_discarded') {
      const target = await resolveArchiveTarget(uid, { docKey: event.docKey, conversationId: event.conversationId })
        .then((r) => (r.ok ? r.target : fallbackTarget))
        .catch(() => fallbackTarget);
      const outcome = emptyOutcome(event, target, trigger, startedAt);
      const rel = `${target.meetingDirRelPath}/${artifactFileName(event) || KIND_SUFFIX[event.artifactKind]}`;
      outcome.skipped.push({ rel, reason: 'discarded' });
      await recordLedger(uid, event, target, rel, 'skipped', trigger, 'discarded');
      return outcome;
    }

    const resolved = await resolveArchiveTarget(uid, {
      docKey: event.docKey,
      ...(event.conversationId ? { conversationId: event.conversationId } : {}),
      ...(options.explicitLibrary !== undefined ? { explicitLibrary: options.explicitLibrary } : {}),
    });
    if (!resolved.ok) {
      const err = resolved as { ok: false; error: string };
      const outcome = emptyOutcome(event, fallbackTarget, trigger, startedAt);
      outcome.failed.push({ rel: event.docKey, error: err.error });
      log.warn('precipitation target unresolved', { doc_key: event.docKey, error: err.error });
      return outcome;
    }
    const target = resolved.target;

    // 取数：路径优先，其次内容
    let body: Buffer | null = null;
    let fileName: string | null = null;
    if (event.sourceAbsPath) {
      fileName = artifactFileName(event);
      if (!fileName) {
        const outcome = emptyOutcome(event, target, trigger, startedAt);
        outcome.skipped.push({ rel: event.sourceAbsPath, reason: 'not_indexable' });
        return outcome;
      }
      try {
        const st = fs.statSync(event.sourceAbsPath);
        if (!st.isFile() || st.size === 0) {
          const outcome = emptyOutcome(event, target, trigger, startedAt);
          outcome.skipped.push({ rel: fileName, reason: st.isFile() ? 'empty' : 'source_missing' });
          await recordLedger(uid, event, target, `${target.meetingDirRelPath}/${fileName}`, 'skipped', trigger, st.isFile() ? 'empty' : 'source_missing');
          return outcome;
        }
        body = fs.readFileSync(event.sourceAbsPath);
      } catch {
        const outcome = emptyOutcome(event, target, trigger, startedAt);
        outcome.skipped.push({ rel: fileName, reason: 'source_missing' });
        await recordLedger(uid, event, target, `${target.meetingDirRelPath}/${fileName}`, 'skipped', trigger, 'source_missing');
        return outcome;
      }
    } else if (typeof event.sourceText === 'string') {
      fileName = artifactFileName(event);
      if (!fileName) {
        const outcome = emptyOutcome(event, target, trigger, startedAt);
        outcome.skipped.push({ rel: 'inline', reason: 'not_indexable' });
        return outcome;
      }
      // 规格 FR-016：空内容不写占位条目。
      if (!event.sourceText.trim()) {
        const outcome = emptyOutcome(event, target, trigger, startedAt);
        outcome.skipped.push({ rel: fileName, reason: 'empty' });
        return outcome;
      }
      body = Buffer.from(event.sourceText, 'utf8');
    } else {
      const outcome = emptyOutcome(event, target, trigger, startedAt);
      outcome.skipped.push({ rel: event.docKey, reason: 'no_source' });
      await recordLedger(uid, event, target, `${target.meetingDirRelPath}/-`, 'skipped', trigger, 'no_source');
      return outcome;
    }

    const targetRel = `${target.meetingDirRelPath}/${fileName}`;

    // 并发收敛：同一产物同一目标正在处理中 → 直接算跳过（正确性仍由磁盘兜底）。
    const key = inflightKey(uid, event.docKey, event.artifactKind, target);
    const inflight = inflightSet();
    if (inflight.has(key)) {
      const outcome = emptyOutcome(event, target, trigger, startedAt);
      outcome.skipped.push({ rel: targetRel, reason: 'concurrent' });
      await recordLedger(uid, event, target, targetRel, 'skipped', trigger, 'concurrent');
      return outcome;
    }
    inflight.add(key);
    try {
      const outcome = emptyOutcome(event, target, trigger, startedAt);

      // 空间库分支：显式 uid；先查存在性以保住幂等（uploadSpaceFile 重名会加时间戳后缀产副本）。
      if (target.scope === 'space' && target.spaceId) {
        let exists = false;
        try {
          const list = await spaceFiles.listSpaceFiles(uid, target.spaceId);
          exists = Array.isArray(list) && list.some((f) => f?.relPath === targetRel);
        } catch { /* 查不到就当不存在，由上传结果决定 */ }
        if (exists) {
          outcome.skipped.push({ rel: targetRel, reason: 'exists' });
          await recordLedger(uid, event, target, targetRel, 'skipped', trigger, 'exists');
          return outcome;
        }
        const up = await spaceFiles.uploadSpaceFile(uid, target.spaceId, targetRel, body);
        if (up.ok) {
          outcome.added.push(targetRel);
          await recordLedger(uid, event, target, targetRel, 'added', trigger);
        } else {
          const errText = (up as { error?: string }).error || 'unknown';
          outcome.failed.push({ rel: targetRel, error: errText });
          await recordLedger(uid, event, target, targetRel, 'failed', trigger, 'target_unwritable');
        }
        outcome.durationMs = Date.now() - startedAt;
        return outcome;
      }

      // 个人库分支：先建归集目录，再拷文件（copy 写前查存在性 → 天然幂等）。
      const mk = contexts.createContextDir(target.meetingDirRelPath);
      if (!mk.ok) {
        const errText = ((mk as { error?: string }).error) || 'unknown';
        outcome.failed.push({ rel: target.meetingDirRelPath, error: errText });
        await recordLedger(uid, event, target, targetRel, 'failed', trigger, 'target_unwritable');
        outcome.durationMs = Date.now() - startedAt;
        return outcome;
      }

      // 内容写入：走 writeContextFileForUser（文本）或临时文件 + copy（二进制安全的既有原语）。
      const write = writeIntoPersonalLibrary(uid, targetRel, body);
      if (write.ok) {
        if (!verifyPersonalEntry(uid, targetRel, body)) {
          outcome.failed.push({ rel: targetRel, error: 'target_verify_failed' });
          await recordLedger(uid, event, target, targetRel, 'failed', trigger, 'target_verify_failed');
        } else {
          outcome.added.push(targetRel);
          await recordLedger(uid, event, target, targetRel, 'added', trigger);
        }
      } else if ((write as { reason?: string }).reason === 'exists') {
        // A confirmed revision often keeps the same filename. Skipping the
        // whole write left the knowledge base on the pre-confirmation copy
        // (observed: 15:00 draft stayed while the 15:10 confirmed version was
        // rejected as `exists`). Compare bytes: identical → genuine idempotent
        // skip; different → land it as the next free version, never overwrite.
        const existingBytes = readPersonalEntryBytes(uid, targetRel);
        if (existingBytes && existingBytes.equals(body)) {
          outcome.skipped.push({ rel: targetRel, reason: 'exists' });
          await recordLedger(uid, event, target, targetRel, 'skipped', trigger, 'exists');
        } else {
          const versionRel = nextFreeVersionRel(uid, targetRel);
          if (!versionRel) {
            outcome.failed.push({ rel: targetRel, error: 'no free version slot' });
            await recordLedger(uid, event, target, targetRel, 'failed', trigger, 'target_unwritable');
          } else {
            const versionWrite = writeIntoPersonalLibrary(uid, versionRel, body);
            if (versionWrite.ok) {
              if (!verifyPersonalEntry(uid, versionRel, body)) {
                outcome.failed.push({ rel: versionRel, error: 'target_verify_failed' });
                await recordLedger(uid, event, target, versionRel, 'failed', trigger, 'target_verify_failed');
              } else {
                outcome.added.push(versionRel);
                await recordLedger(uid, event, target, versionRel, 'added', trigger);
              }
            } else if ('reason' in versionWrite && versionWrite.reason === 'exists') {
              outcome.skipped.push({ rel: versionRel, reason: 'exists' });
              await recordLedger(uid, event, target, versionRel, 'skipped', trigger, 'exists');
            } else {
              outcome.failed.push({ rel: targetRel, error: 'error' in versionWrite ? versionWrite.error : 'unknown' });
              await recordLedger(uid, event, target, targetRel, 'failed', trigger, 'target_unwritable');
            }
          }
        }
      } else {
        outcome.failed.push({ rel: targetRel, error: (write as { error?: string }).error || 'unknown' });
        await recordLedger(uid, event, target, targetRel, 'failed', trigger, 'target_unwritable');
      }
      outcome.durationMs = Date.now() - startedAt;
      return outcome;
    } finally {
      inflight.delete(key);
    }
  } catch (err) {
    // 兜底：任何意外都不得传播到会议主流程（FR-004）。
    log.warn('precipitation unexpected failure', {
      doc_key: event?.docKey,
      artifact_kind: event?.artifactKind,
      error: (err as Error)?.message,
    });
    const outcome = emptyOutcome(event, fallbackTarget, trigger, startedAt);
    outcome.failed.push({ rel: event?.docKey || 'unknown', error: (err as Error)?.message || 'unknown' });
    return outcome;
  }
}

type WriteResult = { ok: true } | { ok: false; reason: 'exists' | 'other'; error: string };

/** 知识库文本类扩展名（与 contexts 的 TEXT_EXTS 同源语义；二进制类走另一条路）。 */
const TEXT_EXTS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
  '.html', '.htm', '.xml', '.toml', '.ini', '.conf',
  '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sh', '.bash', '.zsh', '.ps1', '.cmd', '.bat', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.cc', '.h', '.hpp', '.css', '.scss', '.less',
  '.sql', '.graphql', '.gql',
]);

/** 把知识库写入错误归类为「已存在」或「其他失败」。
 *  必须同时识别两类文案：① 目标路径已存在；② 同库已存在同样字节（内容去重闸门返回
 *  `errors.kb_duplicate_sha1`，中英文分别是「文件已存在」/「File already exists」）。
 *  两者对用户都是「这份没重复存」，属跳过而非失败（规格 FR-019：不得静默丢弃意图，
 *  所以仍要在结果里报出来，只是归类为 skipped）。 */
function classifyWriteError(errText: string): WriteResult {
  if (errText === 'target_exists') return { ok: false, reason: 'exists', error: errText };
  if (/duplicate|already exists|文件已存在/i.test(errText)) {
    return { ok: false, reason: 'exists', error: errText };
  }
  return { ok: false, reason: 'other', error: errText };
}

/**
 * 写进个人库。
 *
 * **不要在这里做「目标是否存在」的预检**：本仓库 `contexts.resolveContextEntryAbsPath`
 * 走的是 `mustExist: true` 的语义，用它给一个**尚不存在**的目标算路径会直接抛
 * `not found: <relpath>` —— 我踩过这个坑。存在性判定统一交给下面两个既有原语：
 *   - 文本：`writeContextFileForUser`（自带同库内容去重闸门 + 索引入队）；
 *   - 二进制：`copyContextEntryFromPath`（`fs.cpSync` 带 `errorOnExist:true, force:false`，
 *     天然不覆盖，已存在时返回 `target_exists`）。
 * 两者都复用既有统一入口，不自造写入路径（宪章 §II）。
 */
/** Read an existing personal-library entry as bytes, or null when absent. */
function readPersonalEntryBytes(uid: string, rel: string): Buffer | null {
  try {
    const abs = path.join(contexts.libraryRootAbsForUser(uid), ...rel.split('/'));
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}

/** Post-write read-back: a successful primitive is not proof the bytes landed. */
function verifyPersonalEntry(uid: string, rel: string, body: Buffer): boolean {
  const written = readPersonalEntryBytes(uid, rel);
  return Boolean(written && written.equals(body));
}

/** `纪要.md` → `纪要_v002.md`; `纪要_v001.md` → `纪要_v002.md`. */
function versionedRel(rel: string, version: number): string {
  const ext = path.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  const match = stem.match(/^(.*)_v(\d{1,3})$/);
  const base = match ? match[1] : stem;
  return `${base}_v${String(version).padStart(3, '0')}${ext}`;
}

/** First free version slot after the existing target (bounded, never overwrites). */
function nextFreeVersionRel(uid: string, rel: string): string | null {
  const ext = path.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  const match = stem.match(/^(.*)_v(\d{1,3})$/);
  const first = match ? Number(match[2]) + 1 : 2;
  for (let version = Math.max(2, first); version <= Math.max(2, first) + 20; version += 1) {
    const candidate = versionedRel(rel, version);
    const abs = path.join(contexts.libraryRootAbsForUser(uid), ...candidate.split('/'));
    if (!fs.existsSync(abs)) return candidate;
  }
  return null;
}

function writeIntoPersonalLibrary(uid: string, targetRel: string, body: Buffer): WriteResult {
  const ext = path.extname(targetRel).toLowerCase();

  // 存在性预检（幂等与「不覆盖历史版本」都靠它）。
  // 为什么用 `path.join(root, rel)` 自己拼而不是 `resolveContextEntryAbsPath`：
  // 后者是 `mustExist: true` 语义，对**尚不存在**的目标会抛 `not found`（踩过）。
  // 这里的相对路径安全性由上游保证：归集目录经 `createContextDir` 校验过，
  // 文件名由 `artifactFileName` 确定性派生（无分隔符、非点开头）。
  const targetAbs = path.join(contexts.libraryRootAbsForUser(uid), ...targetRel.split('/'));
  if (fs.existsSync(targetAbs)) return { ok: false, reason: 'exists', error: 'target_exists' };

  if (TEXT_EXTS.has(ext)) {
    const res = contexts.writeContextFileForUser(uid, targetRel, body.toString('utf8'));
    if (res.ok) return { ok: true };
    return classifyWriteError(((res as { error?: string }).error) || 'unknown');
  }

  // 二进制类：先落到临时目录，再交给既有拷贝原语（它负责路径校验、原子性与幂等）。
  const libRoot = contexts.libraryRootAbsForUser(uid);
  const tmpDir = path.join(libRoot, `.cogseed-precipitate-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  const tmpFile = path.join(tmpDir, path.basename(targetRel));
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tmpFile, body);
    const cp = contexts.copyContextEntryFromPath(tmpFile, targetRel);
    if (cp.ok) return { ok: true };
    return classifyWriteError(((cp as { error?: string }).error) || 'unknown');
  } catch (err) {
    return { ok: false, reason: 'other', error: (err as Error)?.message || 'unknown' };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * 终态兜底：扫该会话可归集的会议产物并补齐（契约 A3）。
 *
 * 覆盖 `completed` 与 `cancelled`（规格 FR-033）—— 刻意不复用现有
 * 「非 completed 直接返回空」的行为，那会让取消会话的成果丢失。
 *
 * 当前实现边界：会议四件套由 feature 直接落盘，**没有**统一的"本会话产出清单"可扫，
 * 所以兜底依赖调用方传入候选事件（由会话消息的 `produced[]` 映射得到）。
 * 这是诚实的现状：兜底能补上"阶段沉淀失败"的项，但补不上"从未产出事件"的项 ——
 * 后者需要会议域提供产出清单，属后续增强（已在 tasks.md T034 记录边界）。
 */
export interface SweepReport {
  /** 本次兜底实际处理的候选数（已去重）。 */
  considered: number;
  /** 因该 docKey 已全部成功沉淀过而整段跳过，未重复触碰磁盘的候选数。 */
  skippedAlreadyComplete: number;
  added: string[];
  skipped: Array<{ rel: string; reason: SkipReason }>;
  failed: Array<{ rel: string; error: string }>;
  /** 逐份明细，供诊断与逐份重试定位。 */
  items: PrecipitationOutcome[];
}

/** 候选去重键：同一场会的同一类别同一版本只处理一次。 */
function candidateKey(ev: MeetingStageEvent): string {
  return [ev.docKey, ev.artifactKind, ev.version || '', ev.sourceAbsPath || ''].join('\u0000');
}

/**
 * 终态兜底：会话结束时复核该会话**应有**的会议产物，补齐阶段过程漏掉的部分。
 *
 * 为什么需要它（规格 FR-013 / FR-033）：环节事件可能因为进程崩溃、订阅者异常、
 * 或"写入成功但事件发出前进程退出"而丢失；终态是最后一道网。用户明确认可了
 * "阶段入库 + 会话结束再复核一遍"这个组合（规格 §待澄清问题 Q1/Q4 的裁定）。
 *
 * 三条设计取舍：
 *   1. **覆盖 cancelled** —— 刻意不复用现有任务归档"非 completed 直接返回空"的行为，
 *      那会让取消会话的成果丢失（FR-033）。
 *   2. **幂等靠磁盘、不靠内存** —— 已成功的项由「目标是否已存在」判定，重复跑不产生副本；
 *      账本只用来**避免整段重复触碰磁盘**（省 I/O），不作为正确性依据。
 *   3. **空内容不写占位**（FR-016）—— 由 `precipitateMeetingArtifact` 内部保证，
 *      这里只负责把候选如实传下去。
 *
 * 已知边界（如实声明，不假装）：本函数依赖调用方提供候选事件。会议四件套目前由 feature
 * 直接落盘，没有统一的"本会话产出清单"可扫，因此**只能补上"曾经发过事件但未成功沉淀"的项**，
 * 补不上"从未产生过事件"的项。后者需要会议域提供产出清单，属后续增强。
 */
export async function sweepConversationMeetingArtifacts(
  uid: string,
  conversationId: string,
  candidates: MeetingStageEvent[],
): Promise<SweepReport> {
  const report: SweepReport = {
    considered: 0,
    skippedAlreadyComplete: 0,
    added: [],
    skipped: [],
    failed: [],
    items: [],
  };

  // 去重：同一场会的同一类别同一版本只处理一次。
  const unique = new Map<string, MeetingStageEvent>();
  for (const ev of candidates || []) {
    if (!ev || typeof ev !== 'object' || !ev.docKey) continue;
    const key = candidateKey(ev);
    if (!unique.has(key)) unique.set(key, ev);
  }

  // 账本一次读完，用于"整段已齐备"的快速路径（省掉无意义的磁盘触碰）。
  const addedFromLedger = new Set<string>();
  try {
    const { entries } = await readPrecipitationLedger(uid, 5000);
    for (const e of entries) {
      if (e.result === 'added' && e.artifact_kind && e.version) {
        addedFromLedger.add(`${e.doc_key}\u0000${e.artifact_kind}\u0000${e.version}`);
      }
    }
  } catch {
    // 账本读不到不影响正确性 —— 幂等最终由磁盘判定。
  }

  for (const [key, ev] of unique) {
    report.considered += 1;
    const ledgerKey = `${ev.docKey}\u0000${ev.artifactKind}\u0000${ev.version || ''}`;
    if (ev.version && addedFromLedger.has(ledgerKey)) {
      // 已成功沉淀过 → 不重复触碰磁盘；但**不计入 added**，避免给用户"又存了"的错觉。
      report.skippedAlreadyComplete += 1;
      continue;
    }
    try {
      const outcome = await precipitateMeetingArtifact(uid, ev, 'terminal_sweep');
      report.items.push(outcome);
      report.added.push(...outcome.added);
      report.skipped.push(...outcome.skipped);
      report.failed.push(...outcome.failed);
    } catch (err) {
      // precipitate 自身保证不抛；此处是双保险，且**不中断**其余候选。
      log.warn('terminal sweep item failed', {
        conversation_id: conversationId,
        doc_key: ev.docKey,
        artifact_kind: ev.artifactKind,
        error: (err as Error)?.message,
      });
      report.failed.push({ rel: ev.docKey, error: (err as Error)?.message || 'unknown' });
    }
    void key;
  }

  log.info('meeting precipitation terminal sweep', {
    user: maskId(uid),
    conversation_id: conversationId,
    considered: report.considered,
    already_complete: report.skippedAlreadyComplete,
    added: report.added.length,
    skipped: report.skipped.length,
    failed: report.failed.length,
  });

  return report;
}


// ── Orchestrator（生产接线入口）───────────────────────────────────────────

/** 沉淀结果的观察者。生产接线时用它把结果推给渲染层做会话内提示（规格 FR-003）；
 *  不传则只记日志 —— 保持本模块对 UI 零依赖（便于单测）。 */
export type PrecipitationReporter = (uid: string, outcome: PrecipitationOutcome) => void;

export interface MeetingPrecipitationRuntime {
  /** 覆盖事件订阅（单测用）。缺省订阅真实环节事件。 */
  subscribe?: (listener: (event: MeetingStageEvent) => void) => () => void;
  /** 覆盖沉淀实现（单测用）。 */
  precipitate?: (uid: string, event: MeetingStageEvent, trigger: PrecipitationTrigger) => Promise<PrecipitationOutcome>;
  /** 结果观察者（生产接线推送给 UI）。 */
  report?: PrecipitationReporter;
  /** 兜底重试一次仍失败的项会被回调到这里，由终态兜底登记（见 startMeetingTerminalSweep）。 */
  onFailure?: (uid: string, event: MeetingStageEvent) => void;
}

/**
 * 启动会议产物沉淀 orchestrator。
 *
 * 与既有 `startTaskAutoArchiveOrchestrator`（`kb_task_auto_archive.ts:239`）同构，
 * 三处关键差异都是本规格的硬要求：
 *   1. **触发源是环节事件**，不是任务终态 —— 会议四件套不经过产物登记，终态归档收不到（research R1）；
 *   2. **逐份沉淀 + 逐份记账**，不批处理 —— 任一环节完成即可入库（规格 FR-001 的"实时"）；
 *   3. **失败重试一次后如实记 failed**，不再重放；账本保留失败原因供单项重试（FR-020）。
 *
 * 幂等由两层保证：本函数的 `seen` 只做**进程内**防重放；跨重启的正确性靠
 * 「目标是否已存在」判定（见模块头注释）。这里刻意不把内存去重当正确性依据。
 */
export function startMeetingPrecipitationOrchestrator(
  runtime: MeetingPrecipitationRuntime = {},
): () => void {
  const subscribe = runtime.subscribe
    || ((listener: (event: MeetingStageEvent) => void) => subscribeMeetingStages(listener));
  const run = runtime.precipitate || precipitateMeetingArtifact;
  const report = runtime.report;

  /** 进程内防重放：键含 stage + 产物 + 目标无关信息，重复事件只处理一次。
   *  **必须在同步阶段就写入** —— 若等到异步处理完再写，同一 tick 内重放的同一事件
   *  会两次都通过检查（我第一版就是这么错的，被单测钉出来）。 */
  const seen = new Set<string>();

  function eventKey(event: MeetingStageEvent): string {
    return [event.uid, event.docKey, event.artifactKind, event.stage, event.version || '', event.at].join('|');
  }

  const handle = async (event: MeetingStageEvent, key: string, attempt: number): Promise<void> => {
    try {
      const outcome = await run(event.uid, event, 'stage_event');
      const touched = outcome.added.length + outcome.failed.length;
      if (touched || outcome.skipped.length) {
        log.info('meeting artifact precipitation', {
          user: maskId(event.uid),
          doc_key: event.docKey,
          artifact_kind: event.artifactKind,
          stage: event.stage,
          target_scope: outcome.target.scope,
          added: outcome.added.length,
          skipped: outcome.skipped.length,
          failed: outcome.failed.length,
          duration_ms: outcome.durationMs,
        });
      }
      try { report?.(event.uid, outcome); } catch (err) {
        // 反馈失败绝不能影响沉淀结果。
        log.warn('precipitation reporter threw', { error: (err as Error)?.message });
      }
    } catch (err) {
      // precipitate 自身保证不抛；这里是双保险，避免监听者异常冒泡到会议主流程。
      if (attempt < 1) {
        setTimeout(() => { void handle(event, key, attempt + 1); }, 0);
        return;
      }
      // 彻底失败 → 释放占用，并交给终态兜底登记（若有接线）。
      seen.delete(key);
      try { runtime.onFailure?.(event.uid, event); } catch (e) {
        log.warn('precipitation onFailure hook threw', { error: (e as Error)?.message });
      }
      log.warn('meeting artifact precipitation failed', {
        user: maskId(event.uid),
        doc_key: event.docKey,
        artifact_kind: event.artifactKind,
        error: (err as Error)?.message,
      });
    }
  };

  const listener = (event: MeetingStageEvent): void => {
    const key = eventKey(event);
    if (seen.has(key)) return;
    seen.add(key); // 同步占位：同一 tick 内的重放立刻被挡住
    // 关键：**不同步执行**。emitMeetingStage 是同步派发，若在此 await 会把沉淀耗时
    // 压进会议主流程（违反 FR-004 / SC-006）。丢到下一个 tick 异步跑。
    void Promise.resolve().then(() => handle(event, key, 0));
  };

  const unsubscribe = subscribe(listener);
  return () => {
    unsubscribe();
    seen.clear();
  };
}

// ── 终态兜底（接任务终态事件）────────────────────────────────────────────

/**
 * 「事件已发出但沉淀失败」的登记表（模块级，供两个 orchestrator 共享）。
 *
 * 为什么是模块级而不是闭包：登记发生在**实时 orchestrator** 里，消费发生在
 * **终态兜底 orchestrator** 里 —— 两者是各自独立的闭包，只有模块级状态能连通。
 * 挂在 globalThis 上以兼容本仓库"同模块可能被 ESM/CJS 各加载一次"的既有陷阱
 * （`meeting_stage_events` 与 `group_chat/bus` 都用了同样的手法）。
 */
const FAILED_KEY = Symbol.for('cogseed.meetingPrecipitation.failed');
const MAX_FAILED_ENTRIES = 500;

function failedRegistry(): Map<string, { uid: string; event: MeetingStageEvent }> {
  const g = globalThis as unknown as Record<symbol, Map<string, { uid: string; event: MeetingStageEvent }> | undefined>;
  let m = g[FAILED_KEY];
  if (!m) { m = new Map(); g[FAILED_KEY] = m; }
  return m;
}

/** 事件键：两处必须同源，抽出来避免写法漂移。 */
export function precipitationEventKey(event: MeetingStageEvent): string {
  return [event.uid, event.docKey, event.artifactKind, event.stage, event.version || '', event.at].join('|');
}

/** 登记一个待兜底的失败项（有界：超出上限时丢最旧的，避免无限增长）。 */
export function rememberPrecipitationFailure(uid: string, event: MeetingStageEvent): void {
  const reg = failedRegistry();
  reg.delete(precipitationEventKey(event)); // 重新插入以刷新插入序
  reg.set(precipitationEventKey(event), { uid, event });
  while (reg.size > MAX_FAILED_ENTRIES) {
    const oldest = reg.keys().next();
    if (oldest.done) break;
    reg.delete(oldest.value);
  }
}

/** 当前待兜底项数（供测试与诊断）。 */
export function pendingPrecipitationFailures(): number {
  return failedRegistry().size;
}

/** 清空登记表（供测试与「用户手动清理」）。 */
export function clearPrecipitationFailures(): void {
  failedRegistry().clear();
}

export interface TerminalSweepRuntime extends MeetingPrecipitationRuntime {
  /** 覆盖终态订阅（单测用）。生产接线方传入 `subscribeTaskTerminals`。 */
  subscribeTerminals?: (
    listener: (event: { user_id: string; conversation_id: string; status: string }) => void,
  ) => () => void;
}

/**
 * 启动终态兜底：任务达到终态时，重试此前**事件已发出但沉淀失败**的会议产物。
 *
 * ⚠️ 能力边界（如实声明，**别误读成"能扫出所有漏项"**）：
 *   会议产物没有"本会话产出清单"可扫 —— `MeetingDocRef` 里**没有 conversationId**，
 *   会话与会议文档之间不存在映射（现状调查已确认）。靠文件名反推映射是脆弱的，
 *   本实现**刻意不做**。因此本函数覆盖的是**确定性可达**的那一类漏项：
 *   事件确实发出过、但沉淀因磁盘/权限/瞬时故障失败的项。
 *   它**补不上**"事件从未发出"（如进程在写入与发事件之间被杀）——那需要会议域
 *   记录 conversation↔docKey 映射，属后续增强（tasks T035 边界已标注）。
 *
 * 覆盖 `completed` 与 `cancelled`（规格 FR-033）：取消不等于放弃已产出的成果。
 * 与实时 orchestrator 共用磁盘幂等判定，重复不产生副本。
 */
export function startMeetingTerminalSweep(runtime: TerminalSweepRuntime = {}): () => void {
  const run = runtime.precipitate || precipitateMeetingArtifact;

  const terminalListener = (ev: { user_id: string; conversation_id: string; status: string }): void => {
    if (ev.status !== 'completed' && ev.status !== 'cancelled') return;
    const reg = failedRegistry();
    if (!reg.size) return;

    // 快照后立刻清空：并发终态不得重复处理同一批（正确性仍由磁盘幂等兜底）。
    const batch = [...reg.values()];
    reg.clear();

    void (async () => {
      let retried = 0;
      let recovered = 0;
      for (const { uid, event } of batch) {
        try {
          const outcome = await run(uid, event, 'terminal_sweep');
          retried += 1;
          recovered += outcome.added.length;
        } catch (err) {
          // 仍失败 → 放回登记表，等下一次终态再试。
          rememberPrecipitationFailure(uid, event);
          log.warn('meeting terminal sweep retry failed', {
            user: maskId(uid),
            doc_key: event.docKey,
            artifact_kind: event.artifactKind,
            error: (err as Error)?.message,
          });
        }
      }
      log.info('meeting terminal sweep done', {
        conversation_id: ev.conversation_id,
        status: ev.status,
        retried,
        recovered,
        still_failed: failedRegistry().size,
      });
    })();
  };

  // 无生产订阅时退化为空订阅（接线方显式传入 subscribeTaskTerminals 才生效）。
  // 刻意不在此处 import group_chat/bus —— 会议域至今零依赖它，避免引入加载顺序陷阱。
  const subscribeTerminals = runtime.subscribeTerminals ?? ((): (() => void) => () => {});
  const unsubscribe = subscribeTerminals(terminalListener);
  return () => {
    unsubscribe();
  };
}

// ── 产物登记观察者（观察期：只记录，不写入）────────────────────────────────

/** 观察期内被"看见"的产物登记（进程内、有界），供诊断与控制台核对。 */
const OBSERVED_KEY = Symbol.for('cogseed.meetingPrecipitation.observedOutputs');
const MAX_OBSERVED = 200;

export interface ObservedProducedOutput {
  at: string;
  uid: string;
  conversationId: string;
  basename: string;
  /** 是否像一份会议产物（按文件名判定，仅用于诊断分组，**不做业务决策**）。 */
  looksLikeMeetingArtifact: boolean;
}

function observedOutputs(): ObservedProducedOutput[] {
  const g = globalThis as unknown as Record<symbol, ObservedProducedOutput[] | undefined>;
  let a = g[OBSERVED_KEY];
  if (!a) { a = []; g[OBSERVED_KEY] = a; }
  return a;
}

/** 诊断用：读取已观察到的产物登记。 */
export function listObservedProducedOutputs(): readonly ObservedProducedOutput[] {
  return observedOutputs();
}

/** 诊断用：清空观察记录。 */
export function clearObservedProducedOutputs(): void {
  observedOutputs().length = 0;
}

/** 文件名是否像会议产物。**只用于诊断分组**：不参与幂等、不参与目标判定。 */
export function looksLikeMeetingArtifactName(name: string): boolean {
  return /会议|纪要|转写|待办|任务清单|actions?|minutes?|transcript/i.test(name);
}

/** 产物类别关键词 → 会议产物类别。命中尾部才认，避免把"会议纪要模板"之类误判。 */
/**
 * Type suffixes, longest/most-specific first. Legacy runs used `转写_纠错稿`
 * and `原始转写`; treating those as unknown defaulted them to `minutes`, which
 * created a second archive directory (`...-转写-纠错稿/会议纪要.md`) and put the
 * corrected transcript under a minutes filename. Recognize the aliases and
 * strip the whole suffix so the meeting key stays identical to the other three
 * artifacts.
 */
const KIND_PATTERNS: ReadonlyArray<{ pattern: RegExp; kind: MeetingArtifactKind }> = Object.freeze([
  { pattern: /(?:^|_)(?:转写[-_]?纠错稿?|纠错稿?)$/u, kind: 'corrected_transcript' },
  { pattern: /(?:^|_)(?:原始转写|转写)$/u, kind: 'transcript' },
  { pattern: /(?:^|_)(?:会议纪要|纪要)$/u, kind: 'minutes' },
  { pattern: /(?:^|_)(?:任务清单|待办)$/u, kind: 'actions' },
]);

export interface DerivedArtifactIdentity {
  /** 会议归集标识：同一场会的各版本归一到同一个值。 */
  meetingKey: string;
  /** 产物类别。 */
  kind: MeetingArtifactKind;
  /** 版本段（如 v002）；无则空串。 */
  version: string;
}

/**
 * 从产物文件名派生「会议归集标识 + 类别 + 版本」。
 *
 * 为什么按文件名派生（而不是查会议文档库）：实测确认 `MeetingDocRef` 里**没有**
 * conversationId，会话与会议文档之间不存在映射；而智能会议Agent 的命名规则是
 * 明确的（`日期_会议名_来源标识_类型_vNNN.md`，见其工作流），所以文件名是**可靠且现成**的键。
 *
 * 归一化的目的：v001/v002/v003 是**同一场会的三份纪要**，必须落进同一个归集目录，
 * 否则每存一版就新建一个目录，库会碎掉。用真实文件名验证过：
 *   `2026-10-14_中扬的个人会议室_在线会议_会议纪要_v001.md` ┐
 *   `..._v002.md`                                          ├→ 同一个 meetingKey
 *   `..._v003.md`                                          ┘
 *
 * 纯函数、无 IO —— 便于用真实文件名做单测。
 */
export function deriveArtifactIdentity(absPath: string): DerivedArtifactIdentity {
  const basename = path.basename(absPath);
  const stem = basename.replace(/\.[^.]+$/, '');

  // 版本段只认文件名末尾（v1 / v01 / v001）；中段出现 v1 不当作版本。
  const versionMatch = /_v(\d{1,3})$/i.exec(stem);
  const version = versionMatch ? `v${versionMatch[1]}` : '';
  const core = versionMatch ? stem.slice(0, versionMatch.index) : stem;

  // 类别只认**尾部**关键词，并剥掉整个后缀（含 `转写_纠错稿` 这类两段式）。
  let kind: MeetingArtifactKind = 'minutes';
  let named = core;
  for (const { pattern, kind: candidate } of KIND_PATTERNS) {
    if (!pattern.test(core)) continue;
    kind = candidate;
    named = core.replace(pattern, '');
    break;
  }

  const meetingKey = (named || stem || 'meeting')
    .replace(/_/g, '-')
    .replace(/[^\p{L}\p{N}.-]/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+/, '')
    .slice(0, 80) || 'meeting';

  return { meetingKey, kind, version };
}

/** True only when the filename declares a meeting artifact kind. Arbitrary
 * skill outputs (report.md, findings.json, preflight logs…) must not be
 * archived as meeting minutes just because they were published in a meeting
 * conversation. */
export function isMeetingArtifactName(absPath: string): boolean {
  const stem = path.basename(absPath).replace(/\.[^.]+$/, '');
  const versionMatch = /_v(\d{1,3})$/i.exec(stem);
  const core = versionMatch ? stem.slice(0, versionMatch.index) : stem;
  return KIND_PATTERNS.some(({ pattern }) => pattern.test(core));
}

/** One published path → the stage event the precipitation engine expects. */
export function publishedPathToStageEvent(
  uid: string,
  conversationId: string | undefined,
  absPath: string,
): MeetingStageEvent | null {
  if (!isIndexableName(path.basename(absPath))) return null;
  if (!isMeetingArtifactName(absPath)) return null;
  const { meetingKey, kind, version } = deriveArtifactIdentity(absPath);
  return {
    stage: 'cleaned_copy_saved',
    uid,
    docKey: meetingKey,
    docId: absPath,
    ...(conversationId ? { conversationId } : {}),
    artifactKind: kind,
    sourceAbsPath: absPath,
    // publish_outputs validates "written by this Agent session", so the file
    // exists and is complete by the time it is declared.
    confirmed: false,
    ...(version ? { version } : {}),
    at: new Date().toISOString(),
  };
}

export interface PublishedPrecipitationResult {
  absPath: string;
  basename: string;
  artifactKind: MeetingArtifactKind;
  meetingKey: string;
  /** True when the extension is outside the KB index whitelist. */
  notIndexable?: boolean;
  target?: ArchiveTarget;
  added: string[];
  skipped: Array<{ rel: string; reason: SkipReason }>;
  failed: Array<{ rel: string; error: string }>;
}

/**
 * Precipitate an explicit set of published outputs and return a per-file
 * outcome. This is the single implementation shared by:
 *   - the observer path (`publish_outputs` from the core-agent runtime), which
 *     fires and forgets; and
 *   - the native Runtime host tool, which awaits it so the Agent can report
 *     exactly what reached the knowledge base (added / skipped / failed).
 *
 * Never throws: a failure is a per-file result, not a broken meeting flow.
 */
export async function precipitatePublishedOutputs(
  uid: string,
  conversationId: string | undefined,
  absPaths: readonly string[],
): Promise<PublishedPrecipitationResult[]> {
  const results: PublishedPrecipitationResult[] = [];
  for (const absPath of absPaths) {
    const basename = path.basename(absPath);
    const { meetingKey, kind } = deriveArtifactIdentity(absPath);
    const event = publishedPathToStageEvent(uid, conversationId, absPath);
    if (!event) {
      results.push({ absPath, basename, artifactKind: kind, meetingKey, notIndexable: true, added: [], skipped: [], failed: [] });
      continue;
    }
    try {
      const outcome = await precipitateMeetingArtifact(uid, event, 'ipc_action');
      results.push({
        absPath,
        basename,
        artifactKind: kind,
        meetingKey,
        target: outcome.target,
        added: outcome.added,
        skipped: outcome.skipped,
        failed: outcome.failed,
      });
      // 有失败就登记，等任务终态兜底再试一次。
      if (outcome.failed.length) rememberPrecipitationFailure(uid, event);
    } catch (err) {
      // precipitate 自身保证不抛；这里是双保险。
      results.push({
        absPath,
        basename,
        artifactKind: kind,
        meetingKey,
        added: [],
        skipped: [],
        failed: [{ rel: basename, error: (err as Error)?.message || 'unknown' }],
      });
    }
  }
  return results;
}

export interface RuntimeCorrectionSweepReport {
  considered: number;
  added: string[];
  skipped: Array<{ rel: string; reason: SkipReason }>;
  failed: Array<{ rel: string; error: string }>;
  skippedReason?: 'not_meeting_correction_session';
}

/**
 * Terminal safety net for the native Runtime: when a meeting correction run
 * ends, archive the transcript and corrected transcript from the session's
 * own write records. This closes the "model wrote the files but never declared
 * them" gap without trusting model prose, and without archiving unconfirmed
 * minutes/actions.
 *
 * Idempotent: precipitation skips an identical existing target.
 */
export async function sweepRuntimeCorrectionArtifacts(
  uid: string,
  runtimeSessionId: string,
  conversationId?: string,
): Promise<RuntimeCorrectionSweepReport> {
  const report: RuntimeCorrectionSweepReport = { considered: 0, added: [], skipped: [], failed: [] };
  try {
    const session = await readNativeRuntimeSession(uid, runtimeSessionId);
    const isMeetingCorrectionSession = session.records.some((record) => (
      record.type === 'turn'
      && record.tool?.name === 'transcript_glossary_apply'
      && !record.tool.result.isError
    ));
    if (!isMeetingCorrectionSession) {
      report.skippedReason = 'not_meeting_correction_session';
      return report;
    }
    const paths = new Set<string>();
    // Includes host-written correction artifacts (`scan` rawOutputPath,
    // `apply` corrected_path), not just model `write_file` calls. Identity is
    // shared with precipitation so legacy names (`转写_纠错稿`) are recognized
    // instead of being skipped or misfiled.
    for (const abs of collectRuntimeWrittenPaths(session.records)) {
      if (!path.isAbsolute(abs)) continue;
      const { kind } = deriveArtifactIdentity(abs);
      if (kind === 'transcript' || kind === 'corrected_transcript') paths.add(abs);
    }
    report.considered = paths.size;
    if (!paths.size) return report;
    const outcomes = await precipitatePublishedOutputs(uid, conversationId, [...paths]);
    for (const outcome of outcomes) {
      report.added.push(...outcome.added);
      report.skipped.push(...outcome.skipped);
      report.failed.push(...outcome.failed);
    }
    return report;
  } catch (error) {
    // The safety net must never break task completion. A missing session is
    // absence (non-native kind or already swept), not a failure.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn('runtime correction sweep failed', { error: (error as Error)?.message });
    }
    return report;
  }
}

/**
 * 启动产物登记 → 知识库沉淀（观察者路径）。
 *
 * **这是主路径**：`publish_outputs` 是模型声明"本轮产出了哪些文件"的唯一入口，
 * 与具体 Agent/技能实现无关。Native Runtime 的宿主工具复用同一实现并等待结果，
 * 这样 Agent 能如实报告"哪一份进了库、哪一份没进"。
 *
 * 契约：
 *   - **永不抛**：观察者异常绝不能影响会话主链路（广播层已吞，此处再吞一层）。
 *   - **异步**：不阻塞登记调用方。
 *   - **幂等**：同一文件重复发布 → 目标已存在 → 记 skipped（不产副本）。
 *   - **多版本共存**：v001/v002/v003 → 文件名不同 → 各自成文件，互不覆盖（FR-005）。
 *   - **失败可兜底**：失败项登记进 failedRegistry，等任务终态重试。
 */
export function startProducedOutputsPrecipitation(): () => void {
  return subscribeProducedOutputs((event) => {
    const paths = [...event.acceptedAbsPaths];
    if (!paths.length) return;
    // 丢到下一个 tick：登记调用方在会话主链路上，不能在这里等磁盘。
    void Promise.resolve().then(async () => {
      const results = await precipitatePublishedOutputs(event.uid, event.conversationId, paths);
      for (const result of results) {
        if (result.notIndexable) {
          log.info('produced output skipped (not indexable)', {
            user: maskId(event.uid), basename: result.basename,
          });
          continue;
        }
        log.info('produced output precipitated', {
          user: maskId(event.uid),
          conversation_id: event.conversationId,
          basename: result.basename,
          meeting_key: result.meetingKey,
          artifact_kind: result.artifactKind,
          added: result.added.length,
          skipped: result.skipped.length,
          failed: result.failed.length,
        });
      }
    });
  });
}
