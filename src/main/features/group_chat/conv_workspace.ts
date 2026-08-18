/**
 * Per-conversation workspace subdirectory resolver.
 *
 * Background: every main conversation used to share one root `userWorkSpace/`,
 * which meant repeated agent runs writing the same basename (`requirements.md`)
 * piled up `requirements-2.md / -3.md / ...` via `util/uniquify-path`. The
 * uniquify itself is correct (don't silently overwrite the prior run's
 * artifact), but the workspace clutter is bad UX. Scoping the cwd to a
 * conversation-specific subdir keeps the lineage grouped and the root tidy.
 *
 * Semantics:
 *   - Lazy: subdir is resolved + mkdir'd on the first call from `bus.ts`,
 *     which only fires when there's actual conversation activity. Old convs
 *     that never call this stay at the root workspace (= legacy behaviour).
 *   - Frozen: once chosen and persisted to `state.json::workspace_dir`, the
 *     subdir basename is never re-derived. Renaming the conv title later
 *     does NOT move the directory.
 *   - No sandbox change: the existing path-sandbox (`util/path-sandbox`)
 *     still allows the entire user workspace tree, so cross-conv reads via
 *     absolute path remain possible.
 *
 * Slug rules — see `slugifyConvTitle()` body. Goal: human-readable Finder
 * navigation (CJK preserved, English lowercased, no opaque cid hex).
 *
 * Placeholder fallback: when the title is missing / equals the i18n
 * placeholder (English "New conversation" or its localized form
 * "新对话") / slug-ifies to empty / hits
 * a Windows reserved name, we fall back to `chat-{YYYY-MM-DD}-{N}`. The
 * fallback is also frozen on first use, so a write that fired before the
 * conv got its real auto-generated title locks in the date-based name —
 * that's the accepted cost of lazy resolution.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { isSystemTmpDir } from '../../util/path-sandbox';
import { getWorkspacePath } from '../user_workspace';
import { getConversation } from '../chats';
import { readState, setWorkspaceDirOnce } from './state';
import { PLACEHOLDER_TITLES } from './conv_title';
import { createLogger } from '../../logger';

const log = createLogger('group_chat.conv_workspace');

const MAX_SLUG_LEN = 32;

// Windows reserved device names (case-insensitive). A directory bearing
// any of these names cannot be created on Windows — fall back rather than
// fight the OS.
const WINDOWS_RESERVED: ReadonlySet<string> = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

const ILLEGAL_CHARS_RE = /[\\/:*?"<>|]/g;

/** Pure slug derivation. Returns empty string on placeholder / unusable input;
 *  callers fall back to the date-based name. Exported for unit testing. */
export function slugifyConvTitle(rawTitle: string | undefined | null): string {
  if (!rawTitle) return '';
  let s = rawTitle.trim();
  if (!s) return '';
  if (PLACEHOLDER_TITLES.has(s)) return '';

  // 1. Replace Windows-illegal punctuation with '-' so it shows up as a
  //    separator instead of disappearing.
  s = s.replace(ILLEGAL_CHARS_RE, '-');

  // 2. Collapse any whitespace (incl. newlines / tabs) to single '-'.
  s = s.replace(/\s+/g, '-');

  // 3. Drop control + ASCII punctuation we don't want to keep. Allowlist:
  //      [a-zA-Z0-9_-]  ASCII alnum + underscore + hyphen
  //      \p{L}          any-language Unicode letter (covers CJK, Cyrillic, Arabic, …)
  //      \p{N}          any-language Unicode number
  s = s.replace(/[^\p{L}\p{N}_\-]/gu, '');

  // 4. ASCII letters → lowercase (FS portability). Non-ASCII letters have
  //    no case to lose.
  s = s.replace(/[A-Z]/g, (c) => c.toLowerCase());

  // 5. Collapse runs of '-' and trim leading/trailing '-' or '.'.
  s = s.replace(/-+/g, '-');
  s = s.replace(/^[-.]+|[-.]+$/g, '');

  // 6. Length cap.
  if (s.length > MAX_SLUG_LEN) s = s.slice(0, MAX_SLUG_LEN).replace(/-+$/, '');

  if (!s) return '';
  if (WINDOWS_RESERVED.has(s.toLowerCase())) return '';
  return s;
}

/** Pick a date-based fallback slug, scanning sibling dirs to find the next
 *  unused suffix (`chat-YYYY-MM-DD-1` → `-2` → ...). Stable across calls
 *  within the same day (next call gets the next free N). */
function pickFallbackSlug(workspaceRoot: string): string {
  const today = new Date();
  const yyyy = today.getFullYear().toString().padStart(4, '0');
  const mm = (today.getMonth() + 1).toString().padStart(2, '0');
  const dd = today.getDate().toString().padStart(2, '0');
  const base = `chat-${yyyy}-${mm}-${dd}`;
  for (let n = 1; n < 10000; n++) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(path.join(workspaceRoot, candidate))) return candidate;
  }
  // 10000 chats produced on a single day is well past pathological — caller
  // sees a unique-but-suffixed name rather than an exception.
  return `${base}-${Date.now()}`;
}

/** Return a slug with collisions resolved by `-2` / `-3` / ... suffixing.
 *  Treats an existing dir of the same name as a collision (likely produced
 *  by a different conv with the same title). */
function uniquifySlug(workspaceRoot: string, slug: string): string {
  if (!fs.existsSync(path.join(workspaceRoot, slug))) return slug;
  for (let n = 2; n < 10000; n++) {
    const candidate = `${slug}-${n}`;
    if (!fs.existsSync(path.join(workspaceRoot, candidate))) return candidate;
  }
  return `${slug}-${Date.now()}`;
}

/**
 * Resolve the absolute working directory for `(uid, cid)`. Lazy + frozen:
 * - if `state.json::workspace_dir` is already set → return `<workspace>/<dir>`
 * - else if the conv has no entry yet (genuinely a legacy conv without a
 *   conversation record, or `state.json` not yet written) → return the
 *   user-level workspace verbatim, do NOT persist anything (legacy behaviour)
 * - else → derive slug from current title, fall back to date-based name on
 *   placeholder, uniquify against sibling dirs, persist the slug choice to
 *   `state.json::workspace_dir`, return the absolute path
 *
 * **Does NOT mkdir** — the directory is materialised lazily by the producing
 * tool (write_file mkdirs parent before write; markdown_to_pdf / image gen
 * follow the same pattern). For tools that need cwd-as-existing-directory
 * (bash via child_process.spawn), the wrapped `bash` tool mkdirs `cwd`
 * defensively before delegating. Skipping the eager mkdir here means a
 * commander turn that only chats (no file output, no bash) leaves zero
 * footprint on disk — which is what users expect when the conversation
 * never produced anything.
 */
/** 会话工作区随空间归属迁移（方案 Y：解绑/换空间/删空间都不丢文件）。
 *  fromSpaceId/toSpaceId：null = userWorkSpace 根；非空 = 空间工作区目录。
 *  依据 state.workspace_dir（相对 slug）计算新旧落点；同盘 rename，跨设备 copy+rm。
 *  幂等：源不存在 / 目标已存在（slug 冲突，别的会话占了）→ 跳过不搬，避免覆盖/串目录。
 *  失败只告警（文件留旧位置，由惰性迁移兜底）。 */
export async function migrateConversationWorkspace(
  uid: string,
  cid: string,
  fromSpaceId: string | null,
  toSpaceId: string | null,
): Promise<{ moved: boolean }> {
  let workspaceDir: string | undefined;
  try {
    const st = await readState(uid, cid);
    workspaceDir = st.workspace_dir;
  } catch { /* no state */ }
  if (!workspaceDir) return { moved: false };

  const { spaceWorkspaceDir } = await import('../../paths');
  const from = fromSpaceId
    ? path.join(spaceWorkspaceDir(uid, fromSpaceId), workspaceDir)
    : path.join(getWorkspacePath(uid), workspaceDir);
  const to = toSpaceId
    ? path.join(spaceWorkspaceDir(uid, toSpaceId), workspaceDir)
    : path.join(getWorkspacePath(uid), workspaceDir);
  if (path.resolve(from) === path.resolve(to)) return { moved: false };
  if (!fs.existsSync(from)) return { moved: false };
  if (fs.existsSync(to)) return { moved: false }; // 目标被别的会话占用 → 不覆盖

  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    log.info(`migrated conv workspace uid=${uid} cid=${cid} ${fromSpaceId ?? 'user'}->${toSpaceId ?? 'user'} dir=${workspaceDir}`);
    return { moved: true };
  } catch (err) {
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
      log.info(`migrated conv workspace (copy) uid=${uid} cid=${cid} dir=${workspaceDir}`);
      return { moved: true };
    } catch (err2) {
      log.warn(`migrate conv workspace failed cid=${cid}: ${(err2 as Error).message}`);
      return { moved: false };
    }
  }
}

export async function getConversationWorkspacePath(uid: string, cid: string): Promise<string> {
  // Resolve the conv's project/space membership ONCE so workspace resolution
  // picks up the scoped selection. 空间化重构：空间会话（space_id 有值）的工作目录
  // 进各自空间目录（spaces/<sid>/workspace/），未绑空间会话保持 userWorkSpace 根。
  let projectId: string | undefined;
  let spaceId: string | undefined;
  let title = '';
  try {
    const conv = await getConversation(uid, cid);
    if (conv) {
      title = conv.title || '';
      const pid = (conv as any).project_id;
      if (typeof pid === 'string' && pid) projectId = pid;
      const sid = (conv as any).space_id;
      if (typeof sid === 'string' && sid) spaceId = sid;
    } else {
      // Legacy convs (created before this feature shipped) keep using the root
      // workspace verbatim — we detect them by absence of a conversation record:
      // if the conv index has nothing for cid, the bus is operating on a phantom
      // and we don't want to spawn a directory off it. In practice every active
      // bus path runs after `chats.createConversation`, so this branch is rare.
      log.warn(`no conv record for cid=${cid} — falling back to root workspace`);
      return getWorkspacePath(uid);
    }
  } catch (err) {
    log.warn(`getConversation failed cid=${cid}: ${(err as Error).message} — falling back to root`);
    return getWorkspacePath(uid);
  }

  // 空间会话 → 空间工作区根（产物按空间分开存放）
  let root: string;
  if (spaceId) {
    const { spaceWorkspaceDir } = await import('../../paths');
    root = spaceWorkspaceDir(uid, spaceId);
  } else {
    root = getWorkspacePath(uid, projectId);
  }

  // 导入会话 / 详情页自定义：coding_project_dir（绝对路径，原始 Agent 项目
  // 目录）优先——Agent 工具与文件列表都以它为准。目录已不存在时防御性
  // 回退到会话工作区（工具不在缺失目录跑）；系统/临时目录（旧版误绑定
  // $TMPDIR 等）同样回退，避免把系统临时文件当工作区。文件列表单独读
  // coding_project_dir 向用户如实显示「已被移动或删除」并引导重新选择。
  try {
    const st0 = await readState(uid, cid);
    if (st0.coding_project_dir_explicit === true
      && st0.coding_project_dir
      && path.isAbsolute(st0.coding_project_dir)) {
      try {
        if (fs.statSync(st0.coding_project_dir).isDirectory()
          && !isSystemTmpDir(st0.coding_project_dir)) {
          return st0.coding_project_dir;
        }
      } catch {
        // dir gone — fall through to the default workspace for execution
      }
      log.warn(`coding_project_dir missing or system/tmp cid=${cid} dir=${st0.coding_project_dir} — using default workspace for execution`);
    }
  } catch {
    // state unreadable — proceed with the default workspace path below
  }

  // Fast path: state already has a workspace_dir baked in.
  const cur = await readState(uid, cid);
  if (cur.workspace_dir) {
    const target = path.join(root, cur.workspace_dir);
    // 惰性迁移：空间会话旧工作区在 userWorkSpace/<dir>（迁移前根），搬到空间目录。
    // 幂等：新路径存在即跳过；同盘 rename，跨设备 copy+rm；失败只告警不阻断。
    // 防串保护：历史目录可能被多个会话共用（旧 slug 冲突，如两会话同标题共用「你好」）——
    // 若 legacy 目录含「非本会话 produced 记录」的文件，说明是共享目录，只搬本会话
    // produced 文件（不搬整个目录，避免把别的会话产物搬错空间）。
    if (spaceId && !fs.existsSync(target)) {
      const legacy = path.join(getWorkspacePath(uid), cur.workspace_dir);
      if (fs.existsSync(legacy)) {
        const moveEntry = (from: string, to: string): void => {
          try {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.renameSync(from, to);
          } catch {
            try { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); } catch { /* best effort */ }
          }
        };
        // 收集本会话 produced 记录的文件名（确定归属）
        const producedNames = new Set<string>();
        try {
          const { getMessages } = await import('../chats');
          const messages = await getMessages(uid, cid, 1000);
          for (const m of messages) {
            for (const p of m.produced || []) {
              if (typeof p === 'string' && p) producedNames.add(path.basename(p));
            }
          }
        } catch { /* 读消息失败 → 走整目录迁移 */ }
        const isShared = producedNames.size > 0
          && fs.readdirSync(legacy).some((name) => !name.startsWith('.') && !producedNames.has(name));
        if (isShared) {
          // 共享目录：只搬本会话 produced 文件
          let moved = 0;
          for (const name of producedNames) {
            const from = path.join(legacy, name);
            if (fs.existsSync(from)) { moveEntry(from, path.join(target, name)); moved += 1; }
          }
          log.info(`migrated shared space conv workspace (produced-only) uid=${uid} sid=${spaceId} cid=${cid} dir=${cur.workspace_dir} moved=${moved}`);
        } else {
          try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.renameSync(legacy, target);
            log.info(`migrated space conv workspace uid=${uid} sid=${spaceId} cid=${cid} dir=${cur.workspace_dir} -> space root`);
          } catch (err) {
            try {
              fs.mkdirSync(path.dirname(target), { recursive: true });
              fs.cpSync(legacy, target, { recursive: true });
              fs.rmSync(legacy, { recursive: true, force: true });
              log.info(`migrated space conv workspace (copy) uid=${uid} sid=${spaceId} cid=${cid} dir=${cur.workspace_dir}`);
            } catch (err2) {
              log.warn(`migrate space conv workspace failed cid=${cid}: ${(err2 as Error).message}`);
            }
          }
        }
      }
    }
    return target;
  }

  let slug = slugifyConvTitle(title);
  if (!slug) slug = pickFallbackSlug(root);
  else slug = uniquifySlug(root, slug);

  // Persist the choice. setWorkspaceDirOnce is idempotent: if a concurrent
  // call beat us to it, our slug is dropped and we re-read the winner. The
  // directory is NOT created here — see the function-level comment above.
  const persisted = await setWorkspaceDirOnce(uid, cid, slug);
  const finalSlug = persisted.workspace_dir || slug;
  // Don't log the raw title — it's user-authored content (can include
  // chat topic / names). The slug (after slugifyConvTitle) is the
  // diagnostic signal we need.
  log.info(`cid=${cid} workspace_dir=${finalSlug} title_len=${title.length} (lazy-mkdir)`);
  return path.join(root, finalSlug);
}
