/**
 * 归档目标判定 —— 「这场会的产物进哪个知识库」。
 *
 * 三级优先级（规格 FR-008/009/010，契约 A2）：
 *   1. **显式指定**（用户在会话里点名某个知识库）—— 最高优先，覆盖默认判定；
 *   2. **会话的空间归属**（`conversation.space_id` 有值）→ 该空间的知识库；
 *   3. **个人库默认**（无归属）。
 *
 * 两条硬纪律：
 *   - **显式目标不可访问时必须失败，不得静默回退**（VR-3）。回退会让用户以为"存进去了"
 *     而实际进了别处 —— 这是比报错更糟的结果。
 *   - **改判不迁移**（FR-011）。本模块只负责"以后进哪"，**不提供任何移动/删除能力**；
 *     既有条目留在原处，由调用方负责告知用户。
 *
 * 与既有实现的关系：现有 `kb_task_auto_archive.ts` 用会话标题生成 slug 落到
 * `contexts/from-tasks/<slug>/`。本模块不复用那个约定 —— 规格 FR-034 要求归集目录
 * 由**稳定标识**派生（会话可改名 → 标题会分裂目录），故改用会议 `docKey`，
 * 归档根也从 `from-tasks` 换成 `meetings`，两者并存互不影响。
 *
 * 存储模型提醒（见 data-model.md 与 specs/001 的现状盘点）：
 *   - **个人知识库 = 全局资料库** —— 同一套存储（`cloud/contexts/`）的不同粒度视图，
 *     物理上就是 `contexts/` 下的**一级目录**（首段即库名，根级为 `''`）。
 *   - **空间知识库 = 独立存储** —— `cloud/spaces/<空间名>/contexts/`，向量库
 *     `local/spaces/<sid>/contexts/.kb/vector.db`。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userContextsDir, spaceContextsDir } from '../paths';
import { createLogger } from '../logger';
import * as contexts from './contexts';
import * as chats from './chats';
import * as spaces from './spaces';

const log = createLogger('meeting-archive-target');

/** 归集根目录名。刻意不使用 `from-tasks`（那是任务产物的既有约定）。 */
export const MEETING_ARCHIVE_ROOT = 'meetings';

/** 与 `contexts.ts` 同源的绝对路径上限约束：单段名加权长度（CJK 计 2）。 */
const MAX_SEGMENT_WEIGHT = 100;
const DOUBLE_WIDTH_CHAR = /[㐀-鿿가-힯぀-ゟ゠-ヿ]/;

function segmentWeight(s: string): number {
  let w = 0;
  for (const ch of s) w += DOUBLE_WIDTH_CHAR.test(ch) ? 2 : 1;
  return w;
}

export type ResultError = { ok: false; error: string; code?: string };
export type Result<T = Record<string, unknown>> = ({ ok: true } & T) | ResultError;

export interface ArchiveTarget {
  /** 个人库（global）或空间库（space）。 */
  scope: 'global' | 'space';
  /** `scope === 'space'` 时必有值。 */
  spaceId?: string;
  /**
   * 知识库内一级目录名（库名）。`''` 表示库根 —— 与 `contexts` 的首段即库名一致。
   * 空间库下本字段恒为 `''`（空间库本身就是独立根）。
   */
  libraryRelPath: string;
  /** 归集根（字面量 `meetings`）。 */
  archiveRootRelPath: string;
  /** 该场会的归集目录：`<archiveRootRelPath>/<docKey>`。 */
  meetingDirRelPath: string;
  /** 判定依据 —— 供 FR-012 的可解释性展示。 */
  resolvedBy: 'explicit' | 'space' | 'personal';
  /** 面向用户的判定说明 i18n key（不是自由文本，避免把用户内容拼进文案）。 */
  explanationKey: string;
}

export interface SelectableLibrary {
  relPath: string;
  label: string;
  scope: 'global' | 'space';
  spaceId?: string;
}

/** i18n key 常量 —— 渲染层负责翻译。 */
export const TARGET_EXPLANATION_KEYS = Object.freeze({
  explicit: 'meeting.precipitation.target.explicit',
  space: 'meeting.precipitation.target.space',
  personal: 'meeting.precipitation.target.personal',
});

/**
 * 校验知识库名（`contexts/` 的一级目录名或 `''`）。
 * 拒绝：路径分隔符、`.`/`..`、NUL、点开头（隐藏）、加权超长。
 */
function normalizeLibraryRelPath(raw: string): Result<{ libraryRelPath: string }> {
  if (typeof raw !== 'string') return { ok: false, error: 'library must be a string', code: 'bad_input' };
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return { ok: true, libraryRelPath: '' }; // 库根
  if (trimmed.includes('\\') || trimmed.includes('\x00')) {
    return { ok: false, error: 'invalid library name', code: 'bad_input' };
  }
  const segs = trimmed.split('/');
  // 只接受单段：本规格的"指定知识库"是选一个库，不是选库内子目录。
  if (segs.length !== 1) return { ok: false, error: 'library must be a single segment', code: 'bad_input' };
  const seg = segs[0];
  if (!seg || seg === '.' || seg === '..') return { ok: false, error: 'invalid library name', code: 'bad_input' };
  if (seg.startsWith('.')) return { ok: false, error: 'hidden library is not selectable', code: 'bad_input' };
  if (segmentWeight(seg) > MAX_SEGMENT_WEIGHT) {
    return { ok: false, error: 'library name too long', code: 'bad_input' };
  }
  if (contexts.hasHiddenContextPathSegment(seg)) {
    return { ok: false, error: 'hidden library is not selectable', code: 'bad_input' };
  }
  return { ok: true, libraryRelPath: seg };
}

/** 个人库：该库目录是否已存在（库根恒存在）。 */
function personalLibraryExists(uid: string, libraryRelPath: string): boolean {
  if (!libraryRelPath) return true;
  const abs = path.join(userContextsDir(uid), libraryRelPath);
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/** 空间可用性：空间存在且属于该用户。 */
async function spaceLibraryAvailable(uid: string, spaceId: string): Promise<boolean> {
  try {
    return await spaces.spaceExists(uid, spaceId);
  } catch {
    return false;
  }
}

function buildTarget(
  docKey: string,
  base: Omit<ArchiveTarget, 'archiveRootRelPath' | 'meetingDirRelPath'>,
): ArchiveTarget {
  const archiveRootRelPath = MEETING_ARCHIVE_ROOT;
  return {
    ...base,
    archiveRootRelPath,
    meetingDirRelPath: `${archiveRootRelPath}/${docKey}`,
  };
}

/**
 * 解析归档目标。
 *
 * `explicitLibrary` 语义：
 *   - `undefined`：未指定 → 走默认判定（空间归属 > 个人库）；
 *   - `null`：**显式清除**指定 → 同样走默认判定，但 `resolvedBy` 仍如实反映默认来源
 *     （调用方据 `explicitLibrary === null` 区分"用户清过"与"从没设过"）；
 *   - `string`：指定库名（`''` = 个人库根）。
 *
 * 失败（`ok:false`）的情形：指定库不存在 / 不是目录 / 是隐藏目录 / 空间不可用。
 * **失败时不回退** —— 由调用方把错误呈现给用户（FR-025）。
 */
export async function resolveArchiveTarget(
  uid: string,
  input: {
    docKey: string;
    conversationId?: string;
    explicitLibrary?: string | null;
  },
): Promise<Result<{ target: ArchiveTarget }>> {
  const docKey = typeof input?.docKey === 'string' ? input.docKey.trim() : '';
  if (!docKey) return { ok: false, error: 'docKey required', code: 'bad_input' };
  // docKey 由 docKeyForDocId 派生，已是安全单段；此处只是防御性复核。
  if (docKey.includes('/') || docKey.includes('\\') || docKey.startsWith('.')) {
    return { ok: false, error: 'invalid docKey', code: 'bad_input' };
  }

  // ── 优先级 1：显式指定 ──────────────────────────────────────────────────
  if (typeof input.explicitLibrary === 'string') {
    // 本仓库 tsconfig 关闭了 strictNullChecks，判别联合不会自动窄化
    // （contexts.ts 等处同样用显式断言绕开）。这里显式标注错误分支类型。
    const norm = normalizeLibraryRelPath(input.explicitLibrary);
    if (!norm.ok) {
      const err = norm as ResultError;
      return { ok: false, error: err.error, ...(err.code ? { code: err.code } : {}) };
    }
    const libraryRelPath = (norm as { ok: true; libraryRelPath: string }).libraryRelPath;
    if (!personalLibraryExists(uid, libraryRelPath)) {
      return {
        ok: false,
        error: `library not found: ${libraryRelPath || '(root)'}`,
        code: 'target_unavailable',
      };
    }
    return {
      ok: true,
      target: buildTarget(docKey, {
        scope: 'global',
        libraryRelPath,
        resolvedBy: 'explicit',
        explanationKey: TARGET_EXPLANATION_KEYS.explicit,
      }),
    };
  }

  // ── 优先级 2：会话的空间归属 ────────────────────────────────────────────
  let spaceId = '';
  if (input.conversationId) {
    try {
      const conv = await chats.getConversation(uid, input.conversationId);
      const sid = (conv as { space_id?: string } | null)?.space_id;
      if (typeof sid === 'string' && sid) spaceId = sid;
    } catch (err) {
      // 读会话失败不阻断沉淀：退到个人库默认（这是唯一的回退，且回退方向是"更保守"）。
      log.warn('resolve target: getConversation failed', {
        conversation_id: input.conversationId,
        error: (err as Error)?.message,
      });
    }
  }

  if (spaceId) {
    if (!await spaceLibraryAvailable(uid, spaceId)) {
      return { ok: false, error: `space not available: ${spaceId}`, code: 'target_unavailable' };
    }
    return {
      ok: true,
      target: buildTarget(docKey, {
        scope: 'space',
        spaceId,
        libraryRelPath: '',
        resolvedBy: 'space',
        explanationKey: TARGET_EXPLANATION_KEYS.space,
      }),
    };
  }

  // ── 优先级 3：个人库默认 ────────────────────────────────────────────────
  return {
    ok: true,
    target: buildTarget(docKey, {
      scope: 'global',
      libraryRelPath: '',
      resolvedBy: 'personal',
      explanationKey: TARGET_EXPLANATION_KEYS.personal,
    }),
  };
}

/**
 * 列出当前用户可选的知识库（供 UI 的"指定目标"选择器用）。
 *
 * 语义与 `contexts` 树保持一致：`cloud/contexts/` 下的**一级目录**即个人知识库；
 * 根（`''`）作为一个选项"资料库根"始终可选；空间库来自 `spaces.listSpaces`。
 * 隐藏目录（点开头）与 `meetings` 归集根本身不作为"知识库"列出 —— 后者不是库。
 */
export async function listSelectableLibraries(uid: string): Promise<SelectableLibrary[]> {
  const out: SelectableLibrary[] = [];

  // 个人库：一级目录
  let top: contexts.ContextNode[] = [];
  try {
    top = await contexts.listContextsTreeForUser(uid);
  } catch (err) {
    log.warn('listSelectableLibraries: tree failed', { error: (err as Error)?.message });
  }
  for (const node of top) {
    if (node.type !== 'dir') continue;
    if (!node.name || node.name.startsWith('.')) continue;
    out.push({ relPath: node.path || node.name, label: node.name, scope: 'global' });
  }
  // 库根始终可选（现有自动归档的落点就是根级 from-tasks/，所以根是合法目标）。
  out.push({ relPath: '', label: '资料库根', scope: 'global' });

  // 空间库
  try {
    const list = await spaces.listSpaces(uid);
    for (const sp of list) {
      if (!sp?.space_id) continue;
      out.push({ relPath: '', label: sp.name || sp.space_id, scope: 'space', spaceId: sp.space_id });
    }
  } catch (err) {
    log.warn('listSelectableLibraries: spaces failed', { error: (err as Error)?.message });
  }

  return out;
}

/**
 * 归集目录的绝对路径（供诊断与测试断言）。
 * 个人库：`<uid>/cloud/contexts/<库名>/meetings/<docKey>`
 * 空间库：`<uid>/cloud/spaces/<空间名>/contexts/meetings/<docKey>`
 * 注意：空间目录名跟随**空间名**（见 `paths.ts` 的空间内容目录约定），
 * 故空间分支需要空间对象；本函数按 target 的 scope 分支处理。
 */
export function meetingDirAbsPath(uid: string, target: ArchiveTarget): string | null {
  if (target.scope === 'space') {
    if (!target.spaceId) return null;
    // 空间内容目录名跟随空间名，需异步查空间 —— 此同步函数拿不到，返回 null 由调用方兜底。
    return null;
  }
  return path.join(userContextsDir(uid), target.libraryRelPath, target.meetingDirRelPath);
}

/** 空间分支的绝对路径（异步，需要空间名）。 */
export async function meetingDirAbsPathForSpace(
  uid: string,
  spaceId: string,
  meetingDirRelPath: string,
): Promise<string | null> {
  try {
    const sp = await spaces.getSpace(uid, spaceId);
    if (!sp) return null;
    return path.join(spaceContextsDir(uid, sp.name), meetingDirRelPath);
  } catch {
    return null;
  }
}
