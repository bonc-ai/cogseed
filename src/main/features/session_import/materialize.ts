/**
 * Session materialization (stage 3).
 *
 * Turns an extraction result into a real CogSeed conversation the user can open
 * from the sidebar and continue chatting in. The raw imported history is NOT
 * copied; instead a single compact "seed" message carries the summary, so the
 * continued conversation starts with a clean, bounded context.
 *
 * What it writes:
 *   1. A new conversation via `createConversation` (kind:'normal'), titled from
 *      the imported session and tagged with an idempotency id so re-running
 *      import on the same source session returns the existing conversation
 *      instead of duplicating it.
 *   2. One `GroupMessage` seed appended to the conversation's main jsonl:
 *        - `text`      → human-facing summary (rendered with an "imported"
 *                        banner by the renderer via `system_kind`-less content)
 *        - `model_text`→ the same brief phrased as durable context so the model
 *                        picks up where the previous agent left off.
 *      `from` is the commander actor so it reads as an assistant-side brief,
 *      not a user turn.
 *
 * Idempotency: the conversation id is derived deterministically from
 * `source + sourceId`, so the same imported session always maps to the same
 * conversation. `createConversation` returns the existing conv unchanged when
 * the id already exists; we then skip re-seeding.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { createConversation, updateConversation } from '../chats';
import { COMMANDER_ID, USER_ID } from '../group_chat/state';
import type { GroupMessage } from '../group_chat/visibility';
import { conversationMessageFile } from '../../util/project-layout';
import { appendJsonlAtomic, genId12, nowIso, safeId } from '../../storage';
import { canonicalizePath, isSystemTmpDir } from '../../util/path-sandbox';
import { createLogger } from '../../logger';
import type { ExtractionResult } from './extractor';

const log = createLogger('session-import:materialize');

export interface MaterializeInput {
  userId: string;
  source: 'claude' | 'codex' | 'workbuddy' | 'opencode';
  sourceId: string;
  /** Original project path, used only to enrich the title. */
  projectPath?: string;
  /** First user message snippet from the picker, used for the title when the
   *  summary is empty. */
  titleHint?: string;
  extraction: ExtractionResult;
}

export interface MaterializeResult {
  conversationId: string;
  created: boolean;
  seeded: boolean;
  degraded: boolean;
  /** Index of the seed message in the conversation message file (0-based), so
   *  a background extraction can rewrite it in place later. -1 when nothing
   *  was seeded (already-imported / unseeded path). */
  seedMsgIndex: number;
  /** Conversation title / project binding — the background extraction task
   *  needs both to rewrite the seed and build the continuation snapshot. */
  title: string;
  projectId: string | null;
}

/** Deterministic, collision-safe conversation id for an imported session, so
 *  repeated imports are idempotent. `safeId` guarantees the id is accepted by
 *  `createConversation`'s explicit-id path. */
function importedConversationId(source: string, sourceId: string): string {
  const hash = createHash('sha256').update(`${source}:${sourceId}`).digest('hex').slice(0, 20);
  const id = `imp-${source}-${hash}`;
  return safeId(id) ? id : `imp-${hash}`;
}

/** Codex injects this block as a synthetic user turn before the real prompt. */
const RECOMMENDED_PLUGINS_PREFIX =
  /^<recommended_plugins>\s*here is a list of plugins that are available but not installed\b/i;

/** Return a usable one-line title, rejecting known runtime-injected content. */
function titleFromText(text: string | undefined): string {
  const trimmed = text?.trim() || '';
  if (!trimmed || RECOMMENDED_PLUGINS_PREFIX.test(trimmed)) return '';
  return trimmed.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 40) || '';
}

/** Build a short title from the summary head or the picker hint. */
/** Human-friendly source name for import banners (never i18n-ed — user content). */
function sourceDisplayName(source: MaterializeInput['source']): string {
  if (source === 'claude') return 'Claude Code';
  if (source === 'codex') return 'Codex';
  if (source === 'workbuddy') return 'WorkBuddy';
  if (source === 'opencode') return 'OpenCode';
  return source;
}

/**
 * 绑定导入会话的原始 Agent 工作区目录（coding_project_dir）。
 * 安全边界：绝对路径 + 目录存在 + realpath 规范化（防符号链接越权）。
 * 排除系统/临时目录（Claude 在无项目目录时 cwd 可能落在 $TMPDIR，绑进去
 * 会让工作区变成一堆系统临时文件）；此类目录不绑定，走默认工作区，由
 * UI 引导用户手动重选真实项目目录。
 * 幂等：coding_project_dir 已设置（之前绑定过或用户手动选过）→ 不覆盖。
 * explicit:true —— 导入绑定视为确定选择，不会被空间化/存量修复逻辑自动
 * 重指（那是针对旧版错误固化的目录，而导入绑定是用户项目的真实目录）。
 */
async function bindImportedProjectDir(
  userId: string,
  conversationId: string,
  projectPath?: string,
): Promise<void> {
  if (!projectPath) return;
  try {
    const { setCodingProjectDir } = await import('../group_chat/state');
    const candidate = String(projectPath).trim();
    const abs = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
    let real = '';
    try {
      const st = (await import('node:fs/promises')).stat(abs);
      if ((await st).isDirectory()) real = canonicalizePath(abs);
    } catch {
      real = '';
    }
    if (real && !isSystemTmpDir(real)) {
      await setCodingProjectDir(userId, conversationId, real, { explicit: true });
      log.info(`import bound coding project_dir cid=${conversationId} dir=${real}`);
    } else if (real) {
      log.info(`import skipped system/tmp project_dir cid=${conversationId} dir=${real}`);
    }
  } catch (dirErr) {
    log.warn('import coding project_dir bind failed', {
      conversationId,
      error: (dirErr as Error)?.message || String(dirErr),
    });
  }
}

function buildTitle(input: MaterializeInput): string {
  const title = titleFromText(input.extraction.sessionSummary) ||
    titleFromText(input.titleHint) ||
    '导入的会话';
  return `⤴ ${title}`;
}

/** Compose the seed message body. Human text gets an "imported / distilled"
 *  banner; model_text carries the same brief as durable pickup context. */
function buildSeed(input: MaterializeInput): { text: string; modelText: string } {
  const summary = input.extraction.sessionSummary.trim();
  const src = sourceDisplayName(input.source);
  // 后台提炼（B+）：materialize 先落占位 seed，提炼完成后由后台任务原地更新。
  const pending = input.extraction.reason === 'extraction_pending';
  const banner = pending
    ? `[从 ${src} 导入 · 正在提炼]`
    : input.extraction.degraded
      ? `[从 ${src} 导入 · 未能自动提炼，以下为原始开头]`
      : `[从 ${src} 导入 · 已提炼]`;
  const text = `${banner}\n\n${summary}`;
  const modelText =
    `以下是用户从 ${src} 导入的一段历史会话的提炼简报。` +
    `请把它当作已发生的上下文，在此基础上继续协助用户，不要重复已完成的工作：\n\n${summary}`;
  return { text, modelText };
}

/**
 * Materialize one imported session into a continuable conversation.
 * Idempotent on `source + sourceId`.
 */
export async function materializeSession(input: MaterializeInput): Promise<MaterializeResult> {
  const cid = importedConversationId(input.source, input.sourceId);

  const conv = await createConversation(input.userId, {
    kind: 'normal',
    conversationId: cid,
    title: buildTitle(input),
    imported: true,
    needs_welcome: true,
    reviveDeleted: true,
  });

  // Re-importing a conversation that was previously deleted leaves its Recall
  // source marked `removed`, which silently disables terminal capture (the
  // no-model CLI fallback conversation never produces recall candidates).
  // Restore the source to `active` so the capture pipeline picks it up again.
  try {
    const { resumeCognitionSource } = await import('../recall/source-control');
    await resumeCognitionSource(input.userId, {
      kind: 'conversation',
      id: conv.conversation_id,
      subtype: 'session',
      scope: 'conversation',
      taxonomyVersion: 2,
      title: conv.title,
    } as import('../recall/source-service').CognitionSourceRef);
  } catch (sourceErr) {
    log.warn('failed to restore recall source for re-imported conversation', {
      conversationId: conv.conversation_id,
      error: (sourceErr as Error)?.message || String(sourceErr),
    });
  }

  // If the conversation already had content (a prior import), don't re-seed.
  const msgFile = conversationMessageFile(input.userId, conv.conversation_id, conv.project_id ?? null);
  let alreadySeeded = false;
  try {
    const fs = await import('node:fs/promises');
    const existing = await fs.readFile(msgFile, 'utf8');
    alreadySeeded = existing.trim().length > 0;
  } catch {
    alreadySeeded = false;
  }

  if (alreadySeeded) {
    log.info(`skip re-seed cid=${conv.conversation_id} source=${input.source}:${input.sourceId}`);
    // 重复导入：不重新播种，但若此前从未绑定过原始工作区（旧版导入会话），
    // 仍补绑定——用户重新导入旧会话即可自动挂上原始项目目录。
    await bindImportedProjectDir(input.userId, conv.conversation_id, input.projectPath);
    return {
      conversationId: conv.conversation_id,
      created: false,
      seeded: false,
      degraded: !!input.extraction.degraded,
      seedMsgIndex: -1,
      title: conv.title,
      projectId: conv.project_id ?? null,
    };
  }

  const { text, modelText } = buildSeed(input);
  const seed: GroupMessage = {
    id: genId12(),
    ts: nowIso(),
    from: COMMANDER_ID,
    to: [USER_ID],
    text,
    model_text: modelText,
    // Seed 消息是导入会话的上下文占位：给模型读（model_text），但对用户隐藏
    // 显示（接续准备面板替代）。前端据此跳过气泡渲染。
    imported_seed: true,
  };
  const append = await appendJsonlAtomic<GroupMessage>(msgFile, seed);
  const seedMsgIndex = append.msgIndex;

  // Build a TaskContinuationSnapshot so the imported session can be resumed
  // without re-explaining: goal / stage / next are derived from the real
  // extracted summary (never fabricated). Best-effort — failure must not
  // block the import itself. When extraction is deferred to the background
  // (B+), skip this — the background task rebuilds it with the real summary.
  if (input.extraction.reason !== 'extraction_pending') {
    try {
      const { buildContinuationSnapshot } = await import('../task_continuation');
      await buildContinuationSnapshot({
        userId: input.userId,
        conversationId: conv.conversation_id,
        projectId: conv.project_id ?? null,
        sessionSummary: input.extraction.sessionSummary,
        title: conv.title,
      });
    } catch (snapErr) {
      log.warn('failed to build continuation snapshot', {
        conversationId: conv.conversation_id,
        error: (snapErr as Error)?.message || String(snapErr),
      });
    }
  }

  // Touch updated_at so the conversation sorts to the top of the sidebar list.
  await updateConversation(input.userId, conv.conversation_id, { updated_at: nowIso() }, conv.project_id ?? null);

  // 绑定原始 Agent 工作区目录：导入会话的 projectPath（原始 cwd）若在本机
  // 真实存在（目录），固化为会话的 coding_project_dir——此后 Agent 工具与
  // 文件列表都以此目录为准（真实显示原项目文件，Agent 在原目录里干活）。
  // 不存在/非目录 → 不绑定，会话走默认 slug 工作区，由 UI 引导重新选择。
  await bindImportedProjectDir(input.userId, conv.conversation_id, input.projectPath);

  log.info(
    `materialized cid=${conv.conversation_id} source=${input.source}:${input.sourceId} degraded=${!!input.extraction.degraded}`,
  );

  return {
    conversationId: conv.conversation_id,
    created: true,
    seeded: true,
    degraded: !!input.extraction.degraded,
    seedMsgIndex,
    title: conv.title,
    projectId: conv.project_id ?? null,
  };
}
