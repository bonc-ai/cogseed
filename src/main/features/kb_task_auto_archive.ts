/**
 * KB task auto-archive — 任务终态自动沉淀（产物 + 引用附件 → 知识库）。
 *
 * 目标（知识库×新建任务打通，P0）：
 *   任务 run 结束（bus 终态 completed）时，把该会话登记过的产物
 *   （消息 produced[] 指向的文件）与引用附件（chat_attachments）自动
 *   归档进知识库 —— 个人会话落 `cloud/contexts/from-tasks/<slug>/`，
 *   空间会话落空间库同款子目录。归档走现有拷贝/上传函数，随后由
 *   kb_indexer / spaceLibraryIndexer 自动 enqueue → 向量化，用户零操作。
 *
 * 幂等与安全：
 *   - 个人库用 copyContextEntryFromPath：target 已存在即返回 target_exists，
 *     天然幂等（同文件不重复写盘）。
 *   - 空间库用 uploadSpaceFile：同名走 uniqueTarget 自动加时间戳避让；
 *     空间库每次终态只触发一次（orchestrator seen/inFlight 去重）。
 *   - 只收 kb 可索引扩展名（个人库不支持的类型直接跳过，不写盘）。
 *   - 附件经 resolveAttachmentAbsPath（路径沙箱）解析，绝不越界。
 *   - 子目录名 sanitize：去路径分隔/点开头/控制字符，截断限长。
 *
 * 启动：main/index.ts 并列于其它 orchestrator 注册 startTaskAutoArchiveOrchestrator。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../logger';
import { maskId } from '../util/log-redact';
import type { TaskTerminalEvent, TaskTerminalListener } from './group_chat/bus';
import { subscribeTaskTerminals } from './group_chat/bus';
import { readMessages } from './group_chat';
import type { GroupMessage } from './group_chat/visibility';
import * as chats from './chats';
import * as contexts from './contexts';
import * as attachments from './chat_attachments';
import * as spaceFiles from './project_files';

const log = createLogger('kb-task-auto-archive');

/** 归档目录在个人库/空间库 contexts 下的根目录。 */
export const ARCHIVE_ROOT = 'from-tasks';
/** 子目录 slug 最大长度（保留余量给文件与扩展名）。 */
const MAX_SLUG_LEN = 40;
/** produced 消息读取上限。 */
const READ_LIMIT = 500;

/** kb_indexer.kindFor 可索引的扩展名集合（个人/空间 contexts 均支持）。
 *  与其保持同源语义：TEXT + pdf/docx/xlsx/pptx + image。html 属 text 会索引，
 *  但整站多文件网页不作为"任务产物"自动收（避免源码噪音）。 */
const INDEXABLE_EXTS = new Set<string>([
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
  '.html', '.htm', '.xml', '.toml', '.ini', '.conf',
  '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sh', '.bash', '.zsh', '.ps1', '.cmd', '.bat', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.cc', '.h', '.hpp', '.css', '.scss', '.less',
  '.sql', '.graphql', '.gql',
  '.pdf', '.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm',
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
]);

export interface TaskAutoArchiveResult {
  /** 归档目录相对路径（个人库 relPath 或空间库 relPath）。 */
  dir: string;
  spaceId?: string;
  archived: string[];
  skipped: string[];
  failed: Array<{ name: string; error: string }>;
}

export interface ArchiveSource {
  /** 绝对源文件路径。 */
  absPath: string;
  /** 建议文件名（basename）。 */
  name: string;
  /** produced 或 attachment。 */
  source: 'produced' | 'attachment';
}

/**
 * 从消息 produced[] 收集"应归档"的候选文件（去重、过滤）。
 * 只返回仍存在、非 process 临时文件、扩展名可被 kb 索引的条目。
 */
export function collectProducedSources(messages: GroupMessage[]): ArchiveSource[] {
  const seen = new Set<string>();
  const out: ArchiveSource[] = [];
  for (const msg of messages || []) {
    for (const produced of Array.isArray(msg.produced) ? msg.produced : []) {
      if (typeof produced !== 'string' || !produced) continue;
      const absPath = path.resolve(produced);
      const name = path.basename(absPath);
      if (!name || name.startsWith('.') || name === '_INDEX.md') continue;
      const ext = path.extname(name).toLowerCase();
      if (!INDEXABLE_EXTS.has(ext)) continue;
      if (seen.has(absPath)) continue;
      let st: fs.Stats;
      try { st = fs.statSync(absPath); } catch { continue; }
      if (!st.isFile() || st.size === 0) continue;
      seen.add(absPath);
      out.push({ absPath, name, source: 'produced' });
    }
  }
  return out;
}

/** 由 userId/cid 解析会话附件为可归档候选（含过滤）。 */
export function resolveAttachmentSources(
  userId: string,
  cid: string,
  attachmentsInfo: attachments.AttachmentInfo[],
): ArchiveSource[] {
  const out: ArchiveSource[] = [];
  for (const info of attachmentsInfo || []) {
    const name = info.name;
    if (!name || name.startsWith('.') || name === '_INDEX.md') continue;
    const ext = path.extname(name).toLowerCase();
    if (!INDEXABLE_EXTS.has(ext)) continue;
    const res = attachments.resolveAttachmentAbsPath(userId, cid, name);
    if (res.ok) out.push({ absPath: res.absPath, name: info.name, source: 'attachment' });
  }
  return out;
}

/** 生成安全子目录名：基于会话标题或回退 cid。 */
export function slugForConversation(title: string | undefined, cid: string): string {
  const raw = (title && title.trim()) || `task-${cid}`;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-]+/, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/[.\-]+$/, '');
  return cleaned || `task-${cid}`;
}

/**
 * 把一批候选文件归档进知识库的 from-tasks/<slug> 子目录。
 * 个人会话 → contexts.createContextDir + copyContextEntryFromPath（幂等）。
 * 空间会话 → spaceFiles.uploadSpaceFile（自动建父目录 + uniqueTarget）。
 */
/** 从失败 Result 里取 error 文案（ok:false 分支有 error，宽松兼容各 Result 变体）。 */
function errText(r: { ok: boolean; error?: string }): string {
  if (r.ok) return 'unknown';
  return r.error || 'unknown';
}

export async function archiveSourcesToLibrary(
  userId: string,
  cid: string,
  slug: string,
  sources: ArchiveSource[],
): Promise<TaskAutoArchiveResult> {
  const dir = `${ARCHIVE_ROOT}/${slug}`;
  let spaceId: string | undefined;
  let conv: chats.Conversation | null = null;
  try { conv = await chats.getConversation(userId, cid); } catch { /* best-effort */ }
  spaceId = conv?.space_id || undefined;

  const result: TaskAutoArchiveResult = { dir, spaceId, archived: [], skipped: [], failed: [] };

  if (!spaceId) {
    const mk = contexts.createContextDir(dir);
    if (!mk.ok) return { ...result, failed: [{ name: dir, error: errText(mk) }] };
  }

  for (const src of sources) {
    const rel = `${dir}/${src.name}`;
    if (spaceId) {
      let buf: Buffer;
      try { buf = fs.readFileSync(src.absPath); }
      catch (err) { result.failed.push({ name: src.name, error: (err as Error).message }); continue; }
      const up = await spaceFiles.uploadSpaceFile(userId, spaceId, rel, buf);
      if (up.ok) result.archived.push(up.info.relPath);
      else result.failed.push({ name: src.name, error: errText(up) });
      continue;
    }
    const cp = contexts.copyContextEntryFromPath(src.absPath, rel);
    if (cp.ok) {
      result.archived.push(rel);
    } else if (errText(cp) === 'target_exists') {
      result.skipped.push(rel);
    } else {
      result.failed.push({ name: src.name, error: errText(cp) });
    }
  }
  return result;
}

/** 读取会话消息（供 orchestrator 注入可测的默认实现）。 */
export async function defaultMessageReader(
  userId: string,
  conversationId: string,
  limit = READ_LIMIT,
): Promise<GroupMessage[]> {
  return readMessages(userId, conversationId, limit);
}

export interface TaskAutoArchiveInput {
  userId: string;
  conversationId: string;
  runId: string;
  status: TaskTerminalEvent['status'];
}

/**
 * 单次归档执行：终态（completed）时收集该会话 produced + 附件并入库。
 * 供 orchestrator 调用；单测可直接调用本函数。
 */
export async function archiveTaskConversationArtifacts(
  input: TaskAutoArchiveInput,
): Promise<TaskAutoArchiveResult | null> {
  if (input.status !== 'completed') return null;
  let conv: chats.Conversation | null = null;
  try { conv = await chats.getConversation(input.userId, input.conversationId); }
  catch { conv = null; }
  const messages = await defaultMessageReader(input.userId, input.conversationId);
  const attach = attachments.listAttachments(input.userId, input.conversationId);
  const sources = [
    ...collectProducedSources(messages),
    ...resolveAttachmentSources(input.userId, input.conversationId, attach),
  ];
  if (sources.length === 0) return null;

  const slug = slugForConversation(conv?.title, input.conversationId);
  return archiveSourcesToLibrary(input.userId, input.conversationId, slug, sources);
}

type TerminalSubscribe = (listener: TaskTerminalListener) => () => void;

export interface TaskAutoArchiveRuntime {
  subscribe?: TerminalSubscribe;
  archive?: (input: TaskAutoArchiveInput) => Promise<TaskAutoArchiveResult | null>;
}

/**
 * Orchestrator：订阅任务终态，completed 时自动归档（seen/inFlight 去重，
 * 失败重试一次）。仿 startGroupKstarClosure / startRecallCaptureOrchestrator。
 */
export function startTaskAutoArchiveOrchestrator(
  runtime: TaskAutoArchiveRuntime = {},
): () => void {
  const subscribe = runtime.subscribe || subscribeTaskTerminals;
  const archive = runtime.archive || archiveTaskConversationArtifacts;
  const seen = new Set<string>();
  const inFlight = new Set<string>();

  const listener: TaskTerminalListener = (event: TaskTerminalEvent) => {
    if (event.status !== 'completed') return;
    const key = `${event.user_id}:${event.run_id}`;
    if (seen.has(key) || inFlight.has(key)) return;
    const runArchive = async (attempt: number): Promise<void> => {
      inFlight.add(key);
      try {
        const result = await archive({
          userId: event.user_id,
          conversationId: event.conversation_id,
          runId: event.run_id,
          status: event.status,
        });
        if (result && (result.archived.length || result.failed.length)) {
          log.info('task auto archive', {
            user: maskId(event.user_id),
            conversationId: event.conversation_id,
            runId: event.run_id,
            dir: result.dir,
            archived: result.archived.length,
            skipped: result.skipped.length,
            failed: result.failed.length,
            spaceId: result.spaceId,
          });
        }
        inFlight.delete(key);
        seen.add(key);
      } catch (err) {
        inFlight.delete(key);
        if (attempt < 1 && !seen.has(key)) {
          setTimeout(() => { void runArchive(attempt + 1); }, 0);
          return;
        }
        log.warn('task auto archive failed', {
          user: maskId(event.user_id),
          conversationId: event.conversation_id,
          runId: event.run_id,
          errorCode: 'task_auto_archive_failed',
        });
      }
    };
    void runArchive(0);
  };

  const unsubscribe = subscribe(listener);
  return () => {
    unsubscribe();
    seen.clear();
    inFlight.clear();
  };
}
