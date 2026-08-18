/**
 * TaskContinuationSnapshot — 接续快照.
 *
 * Saves the minimal state needed to resume an imported session in a new
 * Session / Agent without re-explaining: goal, stage, constraints, latest
 * Artifact reference and next step. Derived from the imported session's own
 * summary (never fabricated) and stored per-conversation under the group dir.
 *
 * v0.2 §7.3: `TaskContinuationSnapshot` is a non-asset object — it keeps the
 * current task state separate from formal assets (关于我 / 我的能力).
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { conversationLayout, conversationMessageReadFile } from '../util/project-layout.js';
import { createLogger } from '../logger.js';
import type { GroupMessage } from './group_chat/visibility.js';

const log = createLogger('task-continuation');

export interface TaskContinuationSnapshot {
  /** Schema version for forward migration. */
  version: 1;
  /** Conversation this snapshot belongs to. */
  conversationId: string;
  /** When the snapshot was taken. */
  createdAt: string;
  /** Short goal line (derived from the imported session summary). */
  goal: string;
  /** Current stage / how far the work got (derived, honest). */
  stage: string;
  /** Known constraints worth preserving (derived; may be empty). */
  constraints: string[];
  /** Latest artifact reference, if any (path or display name). */
  latestArtifact: string | null;
  /** Recommended next step. */
  nextStep: string;
  /** The raw session summary this snapshot was derived from. */
  sourceSummary: string;
}

export interface BuildSnapshotInput {
  userId: string;
  conversationId: string;
  projectId?: string | null;
  /** Session summary extracted during import (real text, never fabricated). */
  sessionSummary?: string;
  /** Conversation title (used as goal fallback). */
  title?: string;
}

const SNAPSHOT_FILE = 'continuation-snapshot.json';

function snapshotFile(userId: string, cid: string, projectHint?: string | null): string {
  return path.join(conversationLayout(userId, cid, projectHint).groupDir, SNAPSHOT_FILE);
}

/** Read the seed (first commander) message of an imported conversation to
 *  recover the session summary. Mirrors the extraction in chats.insertWelcomeMessage. */
async function readSeedSummary(userId: string, cid: string, projectHint?: string | null): Promise<string> {
  try {
    const msgFile = conversationMessageReadFile(userId, cid, projectHint);
    const content = await fs.readFile(msgFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (!lines.length) return '';
    const firstMsg = JSON.parse(lines[0]) as GroupMessage;
    if (firstMsg.from === 'commander' && firstMsg.model_text) {
      const match = firstMsg.model_text.match(/请把它当作已发生的上下文.*?：\n\n(.+)/s);
      if (match) return match[1].trim();
    }
    return '';
  } catch {
    return '';
  }
}

/** Very light derivation of goal/stage/next from the summary. Kept honest:
 *  goal = first meaningful line (skipping Claude's resume/context boilerplate);
 *  stage = second meaningful line or a neutral "已导入历史会话";
 *  next = a stable "继续这项工作" hint. Never asserts facts the summary
 *  does not support. Exported for tests. */
export function deriveFromSummary(summary: string, title?: string): Pick<
  TaskContinuationSnapshot,
  'goal' | 'stage' | 'constraints' | 'latestArtifact' | 'nextStep' | 'sourceSummary'
> {
  const lines = String(summary || '').split('\n').map((l) => l.trim()).filter(Boolean);
  // Claude Code resume transcripts open with boilerplate ("This session is
  // being continued…", "Summary:", section headers, markdown list items).
  // Skip it so the goal is the first line that actually describes the work.
  const NOISE_RE =
    /^(this session is being continued|the summary below|summary:|1\. primary request|primary request|from previous session|from previous|1\.|-\s*\*|-\s)/i;
  const meaningful = lines.filter((l) => !NOISE_RE.test(l) && l.length > 3);
  const goal = meaningful[0] || lines[0] || (title ? `继续「${title}」` : '继续这项工作');
  const stage = meaningful[1] || '已导入历史会话，尚未开始新一轮工作';
  const nextStep = '继续这项工作';
  return {
    goal,
    stage,
    constraints: [],
    latestArtifact: null,
    nextStep,
    sourceSummary: String(summary || ''),
  };
}

/** Build (or rebuild) the continuation snapshot for an imported conversation.
 *  Idempotent: if a snapshot already exists it is returned unchanged. */
export async function buildContinuationSnapshot(
  input: BuildSnapshotInput,
): Promise<TaskContinuationSnapshot | null> {
  const file = snapshotFile(input.userId, input.conversationId, input.projectId);
  try {
    const existing = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(existing) as TaskContinuationSnapshot;
    if (parsed && parsed.conversationId === input.conversationId) {
      // Keep an existing snapshot UNLESS its goal is unusable boilerplate
      // (Claude resume header) — then rebuild. Do NOT rebuild just because
      // the nextStep is a placeholder; ensureProjectBrief distills that
      // separately and a rebuild would clobber its output.
      const goalNoise =
        /^(this session is being continued|the summary below|summary:|1\. primary request|primary request|from previous session|from previous|1\.|-\s*\*|-\s)/i.test(
          (parsed.goal || '').trim(),
        );
      if (!goalNoise) return parsed;
      log.info('rebuilding continuation snapshot from noisy goal', {
        conversationId: input.conversationId,
      });
    }
  } catch {
    /* no snapshot yet — build below */
  }

  const summary = (input.sessionSummary ?? '').trim()
    || await readSeedSummary(input.userId, input.conversationId, input.projectId);
  const derived = deriveFromSummary(summary, input.title);

  const snapshot: TaskContinuationSnapshot = {
    version: 1,
    conversationId: input.conversationId,
    createdAt: new Date().toISOString(),
    goal: derived.goal,
    stage: derived.stage,
    constraints: derived.constraints,
    latestArtifact: derived.latestArtifact,
    nextStep: derived.nextStep,
    sourceSummary: derived.sourceSummary,
  };

  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(snapshot, null, 2), 'utf8');
    log.info('continuation snapshot saved', {
      conversationId: input.conversationId,
      projectId: input.projectId ?? null,
      hasSummary: !!derived.sourceSummary,
    });
  } catch (err) {
    log.warn('failed to persist continuation snapshot', {
      conversationId: input.conversationId,
      error: (err as Error)?.message || String(err),
    });
  }

  return snapshot;
}

/** Read an existing continuation snapshot, or null. */
export async function readContinuationSnapshot(
  userId: string,
  conversationId: string,
  projectHint?: string | null,
): Promise<TaskContinuationSnapshot | null> {
  try {
    const raw = await fs.readFile(snapshotFile(userId, conversationId, projectHint), 'utf8');
    const parsed = JSON.parse(raw) as TaskContinuationSnapshot;
    return parsed && parsed.conversationId === conversationId ? parsed : null;
  } catch {
    return null;
  }
}

const NOISE_RE =
  /^(this session is being continued|the summary below|summary:|1\. primary request|primary request|from previous session|from previous|1\.|-\s*\*|-\s)/i;

/** True when a snapshot goal/stage is unusable Claude resume boilerplate, or
 *  when the next-step is the generic placeholder ("继续这项工作") that the
 *  CLI hasn't distilled into a real task yet. */
export function snapshotHasNoiseGoal(snapshot: Pick<TaskContinuationSnapshot, 'goal' | 'nextStep'> | null): boolean {
  if (!snapshot || !snapshot.goal) return true;
  if (NOISE_RE.test(String(snapshot.goal).trim())) return true;
  if (/^继续这项工作$/.test(String(snapshot.nextStep || '').trim())) return true;
  return false;
}

/**
 * Ensure the conversation's snapshot carries a REAL short project brief.
 * When the derived goal is unusable boilerplate (noisy import summary), drive
 * one CLI turn to distill a 1-2 line project understanding from the session
 * summary, then persist it back into the snapshot. Returns the updated
 * snapshot (or the existing one when nothing needed changing / CLI failed).
 * This is the one-time cost that makes the handoff template's first part
 * meaningful without the user configuring a CogSeed model.
 */
export async function ensureProjectBrief(
  userId: string,
  conversationId: string,
  projectHint?: string | null,
): Promise<TaskContinuationSnapshot | null> {
  const snapshot = await readContinuationSnapshot(userId, conversationId, projectHint);
  if (!snapshot) return snapshot;
  // Distill when the goal is boilerplate OR the next-step is still the
  // placeholder; once distilled both are real so later handoffs reuse it.
  if (!snapshotHasNoiseGoal(snapshot)) return snapshot;

  const summary = (snapshot.sourceSummary || '').trim();
  if (!summary) return snapshot;

  try {
    const { run: runCliAgent } = await import('./local_agents/runner');
    const { pickBestCliForFallback } = await import('./local_agents/fallback-picker');
    // 与聊天降级同规则：优先 Claude Code → 已登录 CLI → 任意可用；
    // 跳过本地代理确认不可达的 CLI（避免派发给未登录/代理没开的 CLI）。
    const chosen = await pickBestCliForFallback({ prefer: 'claude' });
    if (!chosen) return snapshot;

    const prompt =
      `根据下面的会话摘要，用中文输出三行：一句话的项目目标、一句话的当前进展、` +
      `和一句话的下一个最该做的任务（不要泛泛而谈，要具体到该项目）。` +
      `严格按以下格式输出，不要多余内容：\n` +
      `目标：<一句话>\n进展：<一句话>\n下一步：<一句话>\n\n摘要：\n${summary.slice(0, 4000)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90_000);
    let goal = '';
    let stage = '';
    let nextStep = '';
    try {
      const result = await runCliAgent({
        uid: userId,
        cid: conversationId,
        agentId: 'project-brief-distiller',
        agentName: 'Project Brief Distiller',
        cli: chosen.type,
        prompt,
        cwd: os.tmpdir(),
        signal: controller.signal,
        skipDispatchCheck: true,
        onEvent: () => {},
      });
      if (result.status === 'completed' && typeof result.output === 'string') {
        const out = result.output.trim();
        const goalMatch = /^目标[：:]\s*(.+)$/m.exec(out);
        const stageMatch = /^进展[：:]\s*(.+)$/m.exec(out);
        const nextMatch = /^下一步[：:]\s*(.+)$/m.exec(out);
        goal = (goalMatch && goalMatch[1]) ? goalMatch[1].trim() : '';
        stage = (stageMatch && stageMatch[1]) ? stageMatch[1].trim() : '';
        nextStep = (nextMatch && nextMatch[1]) ? nextMatch[1].trim() : '';
        // Lenient fallback: if the CLI didn't follow the 目标/进展 format,
        // use the first non-empty line as the goal (the prompt is explicit
        // about one sentence each, so any prose line is a fair distillation).
        if (!goal) {
          const firstLine = out.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
          goal = firstLine.slice(0, 120);
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }

    if (!goal) return snapshot;

    // Ensure nextStep is a real task (never the placeholder). Fall back to the
    // distilled progress line or the goal itself — all real content, so the
    // snapshot stops re-triggering distillation on later handoffs.
    const realNext = (nextStep && !/^继续这项工作$/.test(nextStep.trim()))
      ? nextStep.trim()
      : (stage || goal);
    const updated: TaskContinuationSnapshot = {
      ...snapshot,
      goal,
      stage: stage || snapshot.stage,
      nextStep: realNext,
      constraints: snapshot.constraints,
    };
    try {
      await fs.mkdir(path.dirname(snapshotFile(userId, conversationId, projectHint)), { recursive: true });
      await fs.writeFile(snapshotFile(userId, conversationId, projectHint), JSON.stringify(updated, null, 2), 'utf8');
      log.info('project brief distilled via CLI', { conversationId, goalChars: goal.length });
    } catch (err) {
      log.warn('failed to persist project brief', {
        conversationId,
        error: (err as Error)?.message || String(err),
      });
    }
    return updated;
  } catch (err) {
    log.warn('project brief distillation failed', {
      conversationId,
      error: (err as Error)?.message || String(err),
    });
    return snapshot;
  }
}

/** 一条接续快照 + 它挂在哪个会话上。
 *
 *  快照本身只记 `conversationId`，但「非资产分流」页要回答的是"这条任务状态
 *  属于哪次工作"——只给一个 cid 用户认不出来，所以列表口把会话标题和归属
 *  一起带出来。 */
export interface TaskContinuationSnapshotRef {
  conversationId: string;
  conversationTitle: string;
  projectId: string | null;
  spaceId: string | null;
  snapshot: TaskContinuationSnapshot;
  /**
   * 快照是否可用。`false` 表示 goal 还是导入样板噪音、或 nextStep 还是占位符
   * ——`ensureProjectBrief` 还没把它蒸馏成真正的任务理解。
   *
   * 不过滤掉而是打标：一条没蒸馏成功的快照仍然是既成事实，藏掉它会让用户以为
   * 这次导入压根没生成接续状态。
   */
  usable: boolean;
}

export interface ListContinuationSnapshotsResult {
  items: TaskContinuationSnapshotRef[];
  /** 全量条数。`items` 可能被 `limit` 截断，这个数字永远是真值——
   *  界面要能说清"还有多少条没显示"，而不是把截断后的长度当成总数。 */
  total: number;
}

/**
 * 列出当前用户全部接续快照，按快照生成时间倒序。
 *
 * **为什么要扫会话列表**：快照落在每个会话自己的 groupDir 下
 * （`continuation-snapshot.json`），没有聚合索引。刻意不建索引——快照是非资产
 * 对象，生命周期跟着会话走，多一份索引就多一处会和会话删除失步的状态。
 *
 * 会话列表本身带 TTL 缓存（`chats.listConversations`），快照文件都是几百字节的
 * JSON，绝大多数会话直接 ENOENT，所以全扫的代价可以接受。`chats` 反向动态
 * import 了本模块，这里也用动态 import 避免静态循环。
 */
export async function listContinuationSnapshots(
  userId: string,
  options: { limit?: number } = {},
): Promise<ListContinuationSnapshotsResult> {
  const { listConversations } = await import('./chats');
  let conversations: Array<{ conversation_id: string; title?: string; project_id?: string; space_id?: string }>;
  try {
    conversations = await listConversations(userId);
  } catch (err) {
    log.warn('continuation snapshot listing could not read conversations', {
      error: (err as Error)?.message || String(err),
    });
    return { items: [], total: 0 };
  }
  const refs = await Promise.all(conversations.map(async (conversation) => {
    const snapshot = await readContinuationSnapshot(
      userId,
      conversation.conversation_id,
      conversation.project_id ?? null,
    );
    if (!snapshot) return null;
    return {
      conversationId: conversation.conversation_id,
      conversationTitle: String(conversation.title || conversation.conversation_id),
      projectId: conversation.project_id || null,
      spaceId: conversation.space_id || null,
      snapshot,
      usable: !snapshotHasNoiseGoal(snapshot),
    } satisfies TaskContinuationSnapshotRef;
  }));
  const items = refs
    .filter((ref): ref is TaskContinuationSnapshotRef => ref !== null)
    .sort((left, right) => String(right.snapshot.createdAt || '').localeCompare(String(left.snapshot.createdAt || '')));
  const limit = Number.isInteger(options.limit) && (options.limit as number) > 0
    ? Math.min(options.limit as number, 200)
    : undefined;
  return { items: limit ? items.slice(0, limit) : items, total: items.length };
}
