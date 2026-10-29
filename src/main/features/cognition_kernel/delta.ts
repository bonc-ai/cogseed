/**
 * cognition_kernel/delta — 变更集契约。
 *
 * 口径：**任何改动都表现为一个 Delta**；区别只在"是否自动确认"——
 *   用户手改 = 自动确认的 Delta（保留直接生效体验）
 *   系统提议 = status:'proposed'，等用户点头（收件箱里的那一条）
 *
 * 变更记录包含目标、前后正文、来源证据、版本与回滚指针，并用来源分类、
 * 幂等键和状态区分提议、提交及重复写入。
 *
 * 纯函数、无 I/O：本文件不落盘、不改任何存储；提交由 store.ts 负责。
 */

import { createHash } from 'node:crypto';

import type {
  CognitionDelta,
  ContentHome,
  DeltaEvidenceRef,
  DeltaOp,
  DeltaOrigin,
  DeltaStatus,
  DeltaTarget,
} from './types';

export const DELTA_ID_PREFIX = 'delta-';
export const MAX_DELTA_TEXT = 2000;

const HOMES: ReadonlySet<string> = new Set<ContentHome>([
  'cognition',
  'personal_fact',
  'rule',
  'template',
  'method',
  'task_local',
  'experience',
]);
const OPS: ReadonlySet<string> = new Set<DeltaOp>(['add', 'update', 'remove', 'set']);
const ORIGINS: ReadonlySet<string> = new Set<DeltaOrigin>([
  'gap',
  'kstar',
  'correction',
  'user',
  'import',
  'projection',
]);
const STATUSES: ReadonlySet<string> = new Set<DeltaStatus>(['proposed', 'applied', 'rejected', 'rolled_back']);

/** 内置六家（缺省已知集）；文档级注册表的家经 knownHomes 放行（自定义家）。 */
export const BUILTIN_HOMES: ReadonlySet<string> = HOMES;

function sha256Hex(input: string, length = 24): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

/** 同一"槽位"（来源+家+对象+字段）恒同键 → 池内只留最新一条。 */
export function deltaIdempotencyKey(input: {
  origin: DeltaOrigin;
  home: ContentHome;
  objectId?: string;
  groupId?: string;
  fieldName?: string;
}): string {
  const slot = [input.origin, input.home, input.objectId ?? '', input.groupId ?? '', input.fieldName ?? ''].join('|');
  return DELTA_ID_PREFIX + sha256Hex(slot);
}

/** 内容指纹：判"同一条内容被重复提议"。 */
export function deltaFingerprint(text: string): string {
  return sha256Hex(String(text ?? '').replace(/\s+/g, ' ').trim(), 32);
}

export interface BuildDeltaInput {
  op: DeltaOp;
  target: DeltaTarget;
  origin: DeltaOrigin;
  after?: string | null;
  before?: string | null;
  evidenceRefs?: readonly DeltaEvidenceRef[];
  /** 注入时钟，便于测试；缺省为当前时间。 */
  now?: string;
  /** 已落地时的内容版本号；未落地缺省。 */
  version?: number;
  rollbackOf?: string;
  /** 系统提议缺省 'proposed'；用户手改传 'applied'。 */
  status?: DeltaStatus;
}

export function buildDelta(input: BuildDeltaInput): CognitionDelta {
  const createdAt = input.now ?? new Date().toISOString();
  const idempotencyKey = deltaIdempotencyKey({
    origin: input.origin,
    home: input.target.home,
    ...(input.target.objectId ? { objectId: input.target.objectId } : {}),
    ...(input.target.groupId ? { groupId: input.target.groupId } : {}),
    ...(input.target.fieldName ? { fieldName: input.target.fieldName } : {}),
  });
  const status: DeltaStatus = input.status ?? (input.origin === 'user' ? 'applied' : 'proposed');
  const seed = [idempotencyKey, input.op, String(input.after ?? ''), createdAt].join('|');
  const deltaId = 'd-' + sha256Hex(seed, 16);
  return {
    deltaId,
    op: input.op,
    target: { ...input.target },
    ...(input.before !== undefined ? { before: input.before } : {}),
    ...(input.after !== undefined ? { after: input.after } : {}),
    origin: input.origin,
    evidenceRefs: [...(input.evidenceRefs?.length ? input.evidenceRefs : input.origin === 'user' ? [{ kind: 'user_input' as const, id: deltaId, title: String(input.after ?? input.before ?? '').slice(0, 200) }] : [])],
    idempotencyKey,
    status,
    ...(input.version !== undefined ? { version: input.version } : {}),
    ...(input.rollbackOf ? { rollbackOf: input.rollbackOf } : {}),
    createdAt,
  };
}

export type DeltaValidation = { ok: true; delta: CognitionDelta } | { ok: false; reason: string };

function isTextOrNull(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

/** 落地器入口守卫：形状不合法一律拒绝，不做"尽力而为"的修补。
 * knownHomes：家注册表全集（内置六家 + 自定义家）；缺省只认内置六家。 */
export function validateDelta(value: unknown, knownHomes: ReadonlySet<string> = HOMES): DeltaValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'delta 必须是对象' };
  const delta = value as Partial<CognitionDelta>;

  if (typeof delta.deltaId !== 'string' || !delta.deltaId.trim()) return { ok: false, reason: '缺 deltaId' };
  if (typeof delta.op !== 'string' || !OPS.has(delta.op)) return { ok: false, reason: 'op 非法' };
  if (typeof delta.origin !== 'string' || !ORIGINS.has(delta.origin)) return { ok: false, reason: 'origin 非法' };
  if (typeof delta.status !== 'string' || !STATUSES.has(delta.status)) return { ok: false, reason: 'status 非法' };
  const target = delta.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return { ok: false, reason: '缺 target' };
  if (typeof target.home !== 'string' || !knownHomes.has(target.home)) {
    return { ok: false, reason: 'target.home 非法' };
  }
  if (typeof delta.idempotencyKey !== 'string' || !delta.idempotencyKey.startsWith(DELTA_ID_PREFIX)) {
    return { ok: false, reason: '幂等键缺失或前缀错误' };
  }
  if (!Array.isArray(delta.evidenceRefs)) return { ok: false, reason: '缺 evidenceRefs' };
  if (delta.evidenceRefs.some(ref => !ref || !['session', 'message', 'asset', 'task_run', 'meeting', 'file', 'user_input', 'candidate'].includes(ref.kind)
    || typeof ref.id !== 'string' || !ref.id.trim() || ref.id.length > 200
    || ref.title !== undefined && (typeof ref.title !== 'string' || ref.title.length > 200))) return { ok: false, reason: 'invalid evidence reference' };
  if (!isTextOrNull(delta.before) || !isTextOrNull(delta.after)) return { ok: false, reason: 'before/after 必须是文本或空' };
  if (String(delta.after ?? '').length > MAX_DELTA_TEXT) return { ok: false, reason: 'after 超过 2000 字' };
  if (delta.op !== 'remove' && !String(delta.after ?? '').trim()) return { ok: false, reason: '非删除操作必须有 after 内容' };
  return { ok: true, delta: delta as CognitionDelta };
}
