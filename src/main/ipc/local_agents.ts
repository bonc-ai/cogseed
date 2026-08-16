/**
 * IPC handlers for local CLI agent discovery.
 *
 * Logical channels exposed to the renderer:
 *   - `localAgents.list`             → all known CLI types with availability + version
 *   - `localAgents.detect`           → single-CLI re-probe (bypasses cache)
 *   - `localAgents.listModels`       → static model catalog for a CLI type
 *   - `localAgents.readToolResult`   → read a spilled CLI tool_result file
 *                                       (renderer click-to-expand)
 *   - `bridge.permission_response`   → renderer answer to a `bridge:permission`
 *                                       push event (orkas-bridge connector-call gate)
 *
 * No `run` channel here — the renderer doesn't spawn CLIs directly;
 * dispatch goes through the existing `groupChat` channel and `bus.ts`
 * routes CLI agents into `features/local_agents/runner.ts` (Step 6).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectAll, detectOne, invalidateCache, LOCAL_CLI_TYPES, type LocalCliType, type LocalCliEntry } from '../features/local_agents/registry.js';
import * as bridgePermissions from '../features/local_agents/bridge_permissions.js';
import * as bashPermissions from '../model/core-agent/bash-permissions.js';
import {
  closeInteractiveCliSession,
  listInteractiveCliSessions,
  readInteractiveCliSession,
  sendInteractiveCliInput,
} from '../model/core-agent/interactive-cli-sessions.js';
import {
  startTerminalSession,
  writeTerminalInput,
  resizeTerminal,
  closeTerminalSession,
  listTerminalSessions,
} from '../features/terminal/pty-sessions.js';
import { listModels } from '../features/local_agents/models.js';
import { getActiveUserId } from '../features/users.js';
import { userToolResultsDir } from '../paths.js';
import { createLogger } from '../logger.js';
import { listClaudeSessions } from '../features/local_agents/claude_sessions.js';
import { listWorkbuddySessions } from '../features/local_agents/workbuddy_sessions.js';
import { importClaudeSessions } from '../features/local_agents/import_sessions.js';
import { listClaudeDesktopSessions } from '../features/local_agents/claude_desktop_sessions.js';
import { listAgentTypes, listSessions as listAcpSessions } from '../features/local_agents/acp_sessions.js';
import { importClaudeSession, importClaudeDesktopSession, importWorkbuddySession, prefetchImportSession } from '../features/session_import/asset-router.js';
import { recommendStartingPoint } from '../features/session_import/recommend-start.js';
import { listClaudeSkills, importClaudeSkills, listCodexSkills, importCodexSkills } from '../features/session_import/skill-import.js';
import {
  readClaudeMemory,
  importClaudeMemory,
  readClaudeMemories,
  importClaudeMemories,
  type MemorySourceKey,
} from '../features/session_import/memory-import.js';
import {
  listCodexSessions,
  readCodexMemory,
  importCodexMemory,
  listCodexTasks,
  importCodexTasks,
  importCodexSession,
} from '../features/session_import/codex-import.js';
import { listOpencodeSessions } from '../features/local_agents/opencode_sessions.js';
import { importOpencodeSession } from '../features/session_import/opencode-import.js';
import {
  readOpencodeMemory,
  importOpencodeMemory,
} from '../features/local_agents/opencode_memory.js';
import {
  listOpencodeTodos,
  importOpencodeTodos,
} from '../features/local_agents/opencode_tasks.js';

const log = createLogger('ipc:local_agents');

/** Inline-expand cap. The renderer's <pre> can render a few hundred KB
 *  without freezing, but past that the user wants an editor anyway. We
 *  cap reads here AND tell the renderer via `truncated: true` so it
 *  can suggest opening the file directly. */
const READ_TOOL_RESULT_MAX_BYTES = 256 * 1024;

function isLocalCliType(v: unknown): v is LocalCliType {
  return typeof v === 'string' && (LOCAL_CLI_TYPES as readonly string[]).includes(v);
}

// Set of CLI types we have a working dispatch backend for. Detection
// is independent (registry probes PATH + --version regardless), but
// the create-modal / detail-page selectors shouldn't let users pick a
// CLI we can't actually dispatch through. As of today every detected
// CLI has a backend — left as a guard for future additions where the
// dispatch path lags detection.
const DISPATCHABLE: ReadonlySet<LocalCliType> = new Set<LocalCliType>(
  ['claude', 'codex', 'openclaw', 'opencode', 'hermes', 'workbuddy'],
);

function maskUnsupported(entries: LocalCliEntry[]): LocalCliEntry[] {
  return entries.map(e => {
    if (DISPATCHABLE.has(e.type)) return e;
    return {
      ...e,
      available: false,
      error: e.error ?? 'version_unknown',
      errorDetail: 'backend not yet implemented in Orkas',
    };
  });
}

export const invokeHandlers = {
  /**
   * List all known CLI types. Default uses the 60s cache; pass
   * `{ force: true }` to invalidate first (settings page refresh button,
   * for instance, would want a fresh probe).
   */
  'localAgents.list': async ({ force = false }: { force?: boolean } = {}) => {
    const entries = await detectAll({ force: !!force });
    return { entries: maskUnsupported(entries) };
  },

  /**
   * Probe each CLI's OWN model endpoint (from its config files) so the
   * onboarding UI can honestly tell the user "this CLI routes through a
   * local proxy (e.g. CC Switch) — keep it running, or switch to a direct
   * endpoint". The app never depends on the proxy; this is informational.
   */
  'localAgents.cliEndpointInfo': async () => {
    const { readCliModelEndpoint } = await import('../features/local_agents/active_config.js');
    const endpoints: Record<string, { baseUrl: string; isLocalProxy: boolean } | null> = {};
    for (const cli of ['claude', 'codex', 'opencode', 'workbuddy'] as const) {
      endpoints[cli] = readCliModelEndpoint(cli);
    }
    return { ok: true, endpoints };
  },

  /**
   * Detect installed DESKTOP apps (not CLIs) that the commander fallback
   * cannot drive: Claude Desktop, Codex desktop, Cursor. Purely a file
   * existence check under /Applications — honest "installed but no local
   * execution interface" signal for the fallback guidance UI.
   */
  'localAgents.detectDesktopApps': async () => {
    const apps = new Set<string>();
    for (const name of ['Claude.app', 'Codex.app', 'Cursor.app']) {
      try {
        const p = path.join('/Applications', name);
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) apps.add(name.replace('.app', ''));
      } catch { /* skip */ }
    }
    return { apps: Array.from(apps) };
  },

  /**
   * Re-probe a single CLI without the cache. Used at execute-time by
   * the runner to make sure a recently-uninstalled binary doesn't slip
   * through, and by the create-modal to refresh after the user changes
   * the relevant `ORKAS_<TYPE>_PATH` env var.
   */
  'localAgents.detect': async ({ type }: { type?: unknown }) => {
    if (!isLocalCliType(type)) throw new Error('invalid CLI type');
    invalidateCache();
    const entry = await detectOne(type);
    return { entry: maskUnsupported([entry])[0] };
  },

  /**
   * Static model catalog for a CLI. Empty array signals the UI to
   * render a free-text input (openclaw / opencode / hermes for now).
   */
  'localAgents.listModels': async ({ type }: { type?: unknown }) => {
    if (!isLocalCliType(type)) throw new Error('invalid CLI type');
    return { models: listModels(type) };
  },

  /**
   * List Claude Code session history from `~/.claude/projects/`.
   * Returns summaries (first message, timestamp, project path) for
   * the onboarding "import sessions" step. Best-effort: missing dir
   * or malformed files return empty array rather than failing.
   */
  'localAgents.listClaudeSessions': async () => {
    const sessions = await listClaudeSessions();
    return { sessions };
  },

  /**
   * Import picked Claude Code sessions as read-only conversations in the
   * user's chat list (cid = claude sessionId → idempotent re-import).
   * Returns per-session outcome; a single failure doesn't abort the batch.
   */
  'localAgents.importClaudeSessions': async ({ sessions }: { sessions?: Array<{ sessionId: string; filePath: string; firstMessage?: string; projectPath?: string }> } = {}, ctx) => {
    const list = Array.isArray(sessions) ? sessions.filter((s) => s && s.sessionId && s.filePath) : [];
    if (!list.length) return { ok: false, error: 'no sessions provided', imported: 0, skipped: 0, errors: [] };
    const result = await importClaudeSessions(ctx.userId, list);
    return result;
  },

  /**
   * List Claude **Desktop** local-agent-mode sessions. Distinct from
   * `listClaudeSessions`, which reads the CLI's jsonl history: this reads the
   * desktop app's per-workspace metadata, so entries carry only the opening
   * message (see `claude_desktop_sessions.ts`). `error: 'permission_denied'`
   * is passed through so the UI can prompt for access instead of showing an
   * empty list.
   */
  'localAgents.listClaudeDesktopSessions': async () => {
    const res = await listClaudeDesktopSessions();
    return res.ok
      ? { ok: true, sessions: res.sessions }
      : { ok: false, error: res.error, sessions: [] };
  },

  /**
   * List ACP transcript sessions from `~/.cogseed/acp-transcripts/`.
   * Returns agent types and sessions for each type. Used in onboarding
   * to detect sessions from ACP-speaking agents (Hermes, Claude Desktop, etc).
   */
  'localAgents.listAcpSessions': async () => {
    try {
      const agentTypes = await listAgentTypes();
      const sessionsByType: Record<string, any[]> = {};
      for (const agentType of agentTypes) {
        sessionsByType[agentType] = await listAcpSessions(agentType);
      }
      return { ok: true, agentTypes, sessionsByType };
    } catch (err) {
      log.warn('failed to list ACP sessions', { error: String(err) });
      return { ok: false, agentTypes: [], sessionsByType: {} };
    }
  },

  /**
   * Import one Claude Code session for the active user: read the transcript,
   * compress it into a summary seed, materialize a continuable conversation
   * (appears in the sidebar), and route extracted cognitions into the Recall
   * candidate pool. `filePath` must be one returned by `listClaudeSessions`;
   * the reader re-validates containment under `~/.claude/projects`.
   *
   * Returns `{ ok, conversationId, cognitions, degraded, reason }`. `degraded`
   * means the model couldn't produce usable structured output — the session
   * is still materialized (honestly labeled), just with no cognitions routed.
   */
  'sessionImport.importClaudeSession': async (
    { filePath, titleHint }: { filePath?: unknown; titleHint?: unknown } = {},
  ) => {
    if (typeof filePath !== 'string' || !filePath) throw new Error('filePath required');
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    return importClaudeSession({
      userId,
      filePath,
      titleHint: typeof titleHint === 'string' ? titleHint : undefined,
    });
  },

  /**
   * Warm the read+extract cache for the recommended session so a later
   * "继续项目" click skips the slow distillation model call. Fire-and-forget
   * from the renderer the moment the recommendation card resolves — read-only,
   * best-effort, and creates nothing user-visible. Only `claude`/`workbuddy`
   * have a slow extract worth prefetching; other sources are a no-op here.
   *
   * A failed/degraded prefetch never blocks the eventual import — it just
   * won't be sped up, so this returns `{ ok:false, reason }` rather than throwing.
   */
  'sessionImport.prefetchRecommended': async (
    { source, filePath }: { source?: unknown; filePath?: unknown } = {},
  ) => {
    if (source !== 'claude' && source !== 'workbuddy') {
      return { ok: false, reason: 'source_not_prefetchable' };
    }
    if (typeof filePath !== 'string' || !filePath) throw new Error('filePath required');
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    return prefetchImportSession({ userId, source, filePath });
  },

  /**
   * Import one Claude **Desktop** session by `sessionId` (from
   * `localAgents.listClaudeDesktopSessions`). Desktop sessions carry only the
   * opening message, so the materialized conversation is seeded from that one
   * turn rather than a full transcript.
   */
  'sessionImport.importClaudeDesktopSession': async (
    { sessionId }: { sessionId?: unknown } = {},
  ) => {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId required');
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    return importClaudeDesktopSession({ userId, sessionId });
  },

  /**
   * List importable Claude Code skills from `~/.claude/skills/` (metadata
   * only). Empty array = Claude unused or no skills. Read-only.
   */
  'sessionImport.listClaudeSkills': async () => {
    const skills = await listClaudeSkills();
    return { skills };
  },

  /**
   * Import a batch of Claude Code skills (by directory name) into the user's
   * skill library. Each `dirName` must be one returned by
   * `listClaudeSkills`. Best-effort per skill; already-present skills report
   * `already_exists` rather than duplicating. Returns per-skill results plus
   * ok/fail counts.
   */
  'sessionImport.importClaudeSkills': async ({ dirNames }: { dirNames?: unknown } = {}) => {
    if (!Array.isArray(dirNames) || dirNames.some((d) => typeof d !== 'string')) {
      throw new Error('dirNames must be a string array');
    }
    return importClaudeSkills(dirNames as string[]);
  },

  /**
   * List Codex skills (READ-ONLY).
   * Returns [] when `~/.codex/skills/.system` is absent.
   */
  'sessionImport.listCodexSkills': async () => {
    const skills = await listCodexSkills();
    return { skills };
  },

  /**
   * Import a batch of Codex skills (by directory name) into the user's
   * skill library. Each `dirName` must be one returned by
   * `listCodexSkills`. Best-effort per skill; already-present skills report
   * `already_exists` rather than duplicating. Returns per-skill results plus
   * ok/fail counts.
   */
  'sessionImport.importCodexSkills': async ({ dirNames }: { dirNames?: unknown } = {}) => {
    if (!Array.isArray(dirNames) || dirNames.some((d) => typeof d !== 'string')) {
      throw new Error('dirNames must be a string array');
    }
    return importCodexSkills(dirNames as string[]);
  },

  /**
   * Preview the user-level Claude memory (`~/.claude/CLAUDE.md`), READ-ONLY.
   * Returns an honest `present:false` state when there is no CLAUDE.md.
   */
  'sessionImport.readClaudeMemory': async () => {
    return readClaudeMemory();
  },

  /**
   * Import the user-level CLAUDE.md into the shared memory tier (MEMORY.md).
   * Per-entry idempotent; every write goes through the memory injection scan
   * and char-limit guard.
   */
  'sessionImport.importClaudeMemory': async () => {
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    return importClaudeMemory(userId);
  },

  /**
   * Preview ALL Claude Code memory sources (READ-ONLY):
   *   - instructions (`~/.claude/CLAUDE.md`)
   *   - rules        (`~/.claude/rules/*.md`)
   *   - automem      (`~/.claude/MEMORY.md`)
   *   - project-mem  (`~/.claude/projects/<project>/memory/*.md`)
   *   - history      (`~/.claude/history.jsonl`, best-effort personal facts)
   *   - workspace-project (`<workspace>/CLAUDE.md` or `<workspace>/.claude/CLAUDE.md`)
   *   - workspace-local   (`<workspace>/CLAUDE.local.md`)
   * Absent sources come back with present:false + a reason, never omitted.
   */
  'sessionImport.readClaudeMemories': async () => {
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    const { getWorkspacePath } = await import('../features/user_workspace');
    const workspaceDir = getWorkspacePath(userId);
    return readClaudeMemories(undefined, workspaceDir);
  },

  /**
   * Import selected Claude Code memory sources into the shared memory tier
   * (MEMORY.md). Per-entry idempotent; every write runs the injection scan and
   * char-limit guard. `sourceKeys` defaults to all seven when omitted.
   */
  'sessionImport.importClaudeMemories': async (
    { sourceKeys }: { sourceKeys?: MemorySourceKey[] } = {},
  ) => {
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    const { getWorkspacePath } = await import('../features/user_workspace');
    const workspaceDir = getWorkspacePath(userId);
    return importClaudeMemories(userId, sourceKeys, undefined, workspaceDir);
  },

  /**
   * List Codex sessions from `~/.codex/sessions/`. Returns metadata only
   * (first message, timestamp, cwd). Best-effort: missing dir returns [].
   */
  'sessionImport.listCodexSessions': async () => {
    const sessions = await listCodexSessions();
    return { sessions };
  },

  /**
   * Preview Codex config.toml for importable preferences (READ-ONLY).
   * Returns structured facts about model provider, default model, reasoning
   * effort, and trusted projects.
   */
  'sessionImport.readCodexMemory': async () => {
    return readCodexMemory();
  },

  /**
   * List Codex scheduled tasks from the `automations` table (READ-ONLY).
   * Empty array = no tasks defined yet (a valid state, not an error).
   */
  'sessionImport.listCodexTasks': async () => {
    const tasks = await listCodexTasks();
    return { tasks };
  },

  /**
   * Import selected Codex scheduled tasks into the in-app auto-task module.
   * `taskIds` omitted = import all listed tasks. Idempotent (existing
   * title+content pairs are skipped); unmappable recurrences are reported,
   * never silently coerced. Returns per-task results with counts.
   */
  'sessionImport.importCodexTasks': async ({ taskIds }: { taskIds?: unknown } = {}) => {
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    const ids = Array.isArray(taskIds)
      ? taskIds.filter((x): x is string => typeof x === 'string')
      : undefined;
    return importCodexTasks(userId, ids);
  },

  /**
   * Import Codex config.toml preferences into the shared memory tier
   * (MEMORY.md). Per-entry idempotent; every write goes through the memory
   * injection scan and char-limit guard.
   */
  'sessionImport.importCodexMemory': async () => {
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    return importCodexMemory(userId);
  },

  /**
   * Import a single Codex session into a CogSeed conversation.
   * Simpler than Claude import: no extraction/cognition routing, just
   * materialize the conversation. `filePath` must be a valid JSONL path
   * from `listCodexSessions`. Returns `{ ok, conversationId, reason }`.
   */
  'sessionImport.importCodexSession': async (
    { filePath, titleHint }: { filePath?: unknown; titleHint?: unknown } = {},
  ) => {
    if (typeof filePath !== 'string' || !filePath) throw new Error('filePath required');
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    return importCodexSession(
      userId,
      filePath,
      typeof titleHint === 'string' ? titleHint : undefined,
    );
  },

  /**
   * List WorkBuddy (Tencent) sessions from `~/.workbuddy/projects/`. Returns
   * metadata only (first user query, timestamp, project path). READ-ONLY,
   * best-effort: missing dir returns []. The real prompt is extracted from
   * the `<user_query>` wrapper so the picker shows the question, not the
   * system-reminder blob.
   */
  'sessionImport.listWorkbuddySessions': async () => {
    const sessions = await listWorkbuddySessions();
    return { sessions };
  },

  /**
   * Onboarding "从哪里开始" recommendation. Ranks the user's REAL prior
   * sessions across every detected agent and, for the best one, suggests a
   * matching role template via local keyword match. Read-only; never
   * fabricates — returns `{ top: null }` when nothing readable exists so the
   * UI can honestly fall back to "选择其他 session" / "从空白开始".
   */
  'sessionImport.recommendStartingPoint': async () => {
    const userId = getActiveUserId();
    return recommendStartingPoint(undefined, userId || undefined);
  },

  /**
   * Import one WorkBuddy session into a CogSeed conversation: read the
   * transcript, normalize WorkBuddy's top-level role/content jsonl, extract
   * cognitions, materialize a continuable conversation, and route the
   * extracted assets into the Recall candidate pool. Same pipeline as the
   * Claude import — this is how a WorkBuddy session becomes owned cognitive
   * assets. `filePath` must be one returned by `listWorkbuddySessions`; the
   * reader re-validates containment under `~/.workbuddy/projects`.
   */
  'sessionImport.importWorkbuddySession': async (
    { filePath, titleHint, projectPath }: { filePath?: unknown; titleHint?: unknown; projectPath?: unknown } = {},
  ) => {
    if (typeof filePath !== 'string' || !filePath) throw new Error('filePath required');
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    return importWorkbuddySession({
      userId,
      filePath,
      titleHint: typeof titleHint === 'string' ? titleHint : undefined,
      projectPath: typeof projectPath === 'string' ? projectPath : undefined,
    });
  },

  /**
   * List OpenCode sessions from `~/.local/share/opencode/opencode.db`.
   * Returns session metadata (title, timestamps, message count, model, tokens).
   * READ-ONLY. Best-effort: missing DB returns empty result.
   */
  'sessionImport.listOpencodeSessions': async () => {
    const result = listOpencodeSessions();
    if ('error' in result) {
      return { ok: false, sessions: [], error: result.error };
    }
    return { ok: true, sessions: result.sessions, totalCount: result.totalCount };
  },

  /**
   * Import an OpenCode session into a continuable conversation. Reads the
   * session's text parts from the OpenCode SQLite DB (READ-ONLY) and
   * materializes it like the other CLI sources.
   */
  'sessionImport.importOpencodeSession': async (
    { sessionId, titleHint }: { sessionId?: unknown; titleHint?: unknown } = {},
  ) => {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId required');
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    return importOpencodeSession(
      userId,
      sessionId,
      typeof titleHint === 'string' ? titleHint : undefined,
    );
  },

  /**
   * Preview OpenCode config preferences (opencode.json/.jsonc) — READ-ONLY.
   * Empty config is an honest `present:false` + `reason:'empty'` state.
   */
  'sessionImport.readOpencodeMemory': async () => {
    return readOpencodeMemory();
  },

  /**
   * Import OpenCode config preferences into the shared memory tier.
   * Per-entry idempotent via the memory guard.
   */
  'sessionImport.importOpencodeMemory': async () => {
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    return importOpencodeMemory(userId);
  },

  /**
   * List OpenCode todos (in-session task checklist) — READ-ONLY.
   * OpenCode has no scheduled-task store; todo is a checklist, and imports
   * are one-time tasks. Empty array = no todos.
   */
  'sessionImport.listOpencodeTodos': async () => {
    const todos = await listOpencodeTodos();
    return { todos };
  },

  /**
   * Import selected OpenCode todos as one-time tasks in the auto-task module.
   * `todoIds` omitted = import all. Idempotent per (title, content).
   */
  'sessionImport.importOpencodeTodos': async ({ todoIds }: { todoIds?: unknown } = {}) => {
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    const ids = Array.isArray(todoIds)
      ? todoIds.filter((x): x is string => typeof x === 'string')
      : undefined;
    return importOpencodeTodos(userId, ids);
  },

  /**
   * Insert a welcome message into an imported conversation. Called by the
   * renderer when the user opens an imported conversation for the first time.
   * Returns `{ ok, error? }`.
   */
  'chats.insertWelcomeMessage': async (
    { conversationId }: { conversationId?: unknown } = {},
  ) => {
    if (typeof conversationId !== 'string' || !conversationId) {
      throw new Error('conversationId required');
    }
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    const { insertWelcomeMessage } = await import('../features/chats');
    return insertWelcomeMessage(userId, conversationId);
  },

  /**
   * Read the resume welcome panel for an imported conversation (v1.6 three-part
   * template). Does not append a message and does not consume `needs_welcome`;
   * the renderer shows the panel and only sends the guide sentence on confirm.
   */
  'chats.getWelcomePanel': async (
    { conversationId }: { conversationId?: unknown } = {},
  ) => {
    if (typeof conversationId !== 'string' || !conversationId) {
      throw new Error('conversationId required');
    }
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    const { getWelcomePanel } = await import('../features/chats');
    return getWelcomePanel(userId, conversationId);
  },

  /**
   * Mark an imported conversation's welcome as seen (clears `needs_welcome`)
   * without appending any message. Called after「带着这些继续」is confirmed.
   */
  'chats.markWelcomeSeen': async (
    { conversationId }: { conversationId?: unknown } = {},
  ) => {
    if (typeof conversationId !== 'string' || !conversationId) {
      throw new Error('conversationId required');
    }
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    const { markWelcomeSeen } = await import('../features/chats');
    return markWelcomeSeen(userId, conversationId);
  },

  /**
   * Template-based handoff reply for an imported conversation. When the user
   * sends a handoff/continue prompt ("继续这项工作", "现在做到哪里…"), we answer
   * directly from real CogSeed data — instant, no CLI turn. Appends the
   * three-part template as a commander reply and returns the text.
   */
  'chats.handoffWelcomeReply': async (
    { conversationId, text }: { conversationId?: unknown; text?: unknown } = {},
  ) => {
    if (typeof conversationId !== 'string' || !conversationId) {
      throw new Error('conversationId required');
    }
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    const { handoffWelcomeReply } = await import('../features/chats');
    return handoffWelcomeReply(userId, conversationId, typeof text === 'string' ? text : undefined);
  },

  /**
   * 打开导入会话时自动开始接续（真实消息流）：系统替用户发送第一条引导句
   * 「继续这项工作。先告诉我现在做到哪里…」，随后 commander 回复三段式
   * （项目介绍 / 工作空间能力 / Action Plan）。两条消息落盘并清除 needs_welcome。
   */
  'chats.beginWelcome': async ({ conversationId }: { conversationId?: unknown } = {}) => {
    if (typeof conversationId !== 'string' || !conversationId) {
      throw new Error('conversationId required');
    }
    const userId = getActiveUserId();
    if (!userId) throw new Error('no active user');
    const { beginWelcome } = await import('../features/chats');
    return beginWelcome(userId, conversationId);
  },

  /**
   * Read a spilled CLI tool_result file. The renderer's click-to-expand
   * UI calls this with the `outputPath` it received on a `tool-event
   * phase:'result'` event.
   *
   * Hard constraints:
   *   - Path MUST resolve under the active uid's
   *     `<uid>/local/tool-results/` directory. Symlink-traversal is
   *     blocked by realpath-comparing against the canonical root, so a
   *     compromised CLI can't trick the renderer into reading
   *     arbitrary files.
   *   - Read is byte-capped (256 KB inline); larger files truncate
   *     and set `truncated: true`. The shell.openPath path for "open
   *     in editor" is a separate IPC, not added in this round.
   *
   * Returns `{ok:true, content, truncated}` or `{ok:false, error}`;
   * never throws across the IPC boundary so a UI bug can't crash the
   * renderer.
   */
  /** Renderer answer to a `bridge:permission` push event. Unknown /
   *  already-timed-out request ids return handled:false (the dialog was
   *  stale); validation is shape-only — the verdict semantics live in
   *  features/local_agents/bridge_permissions.ts. */
  'bridge.permission_response': async (
    payload: { request_id?: unknown; allow?: unknown; always?: unknown },
  ) => {
    if (typeof payload?.request_id !== 'string' || !payload.request_id) throw new Error('invalid request_id');
    if (typeof payload?.allow !== 'boolean') throw new Error('invalid allow flag');
    const handled = bridgePermissions.respond(payload.request_id, payload.allow, payload?.always === true);
    return { handled };
  },

  /** Renderer answer to a `bash:permission` push event (sensitive approval modes).
   *  `decision` ∈ allow_once | allow_run | deny. Unknown / timed-out ids
   *  return handled:false (stale dialog). Verdict semantics live in
   *  model/core-agent/bash-permissions.ts. */
  'bash.permission_response': async (
    payload: { request_id?: unknown; decision?: unknown },
  ) => {
    if (typeof payload?.request_id !== 'string' || !payload.request_id) throw new Error('invalid request_id');
    const d = payload.decision;
    if (d !== 'allow_once' && d !== 'allow_run' && d !== 'deny') throw new Error('invalid decision');
    const handled = bashPermissions.respond(payload.request_id, d);
    return { handled };
  },

  'interactiveCli.list': async (_payload: unknown, ctx: { userId: string }) => {
    return { sessions: listInteractiveCliSessions(ctx.userId) };
  },

  'interactiveCli.read': async (
    payload: { session_id?: unknown },
    ctx: { userId: string },
  ) => {
    if (typeof payload?.session_id !== 'string' || !payload.session_id) throw new Error('invalid session_id');
    return { session: readInteractiveCliSession(ctx.userId, payload.session_id) };
  },

  'interactiveCli.send': async (
    payload: { session_id?: unknown; input?: unknown; add_newline?: unknown; sensitive?: unknown },
    ctx: { userId: string },
  ) => {
    if (typeof payload?.session_id !== 'string' || !payload.session_id) throw new Error('invalid session_id');
    const text = typeof payload.input === 'string' ? payload.input : '';
    const session = sendInteractiveCliInput(ctx.userId, payload.session_id, text, {
      addNewline: payload.add_newline !== false,
      sensitive: payload.sensitive === true,
    });
    return { session };
  },

  'interactiveCli.close': async (
    payload: { session_id?: unknown },
    ctx: { userId: string },
  ) => {
    if (typeof payload?.session_id !== 'string' || !payload.session_id) throw new Error('invalid session_id');
    return { session: closeInteractiveCliSession(ctx.userId, payload.session_id) };
  },

  // ── Integrated terminal (real PTY via node-pty) ──────────────────────────
  // The renderer opens/writes/resizes/closes a real shell session. Output is
  // streamed back over the `terminal.stream` stream channel (see ipc/index.ts).
  'terminal.create': async (
    payload: { cwd?: unknown; cols?: unknown; rows?: unknown },
    ctx: { userId: string },
  ) => {
    const session = startTerminalSession({
      uid: ctx.userId,
      cwd: typeof payload?.cwd === 'string' ? payload.cwd : undefined,
      cols: typeof payload?.cols === 'number' ? payload.cols : undefined,
      rows: typeof payload?.rows === 'number' ? payload.rows : undefined,
    });
    return { session };
  },

  'terminal.write': async (
    payload: { session_id?: unknown; data?: unknown },
    ctx: { userId: string },
  ) => {
    if (typeof payload?.session_id !== 'string' || !payload.session_id) throw new Error('invalid session_id');
    writeTerminalInput(ctx.userId, payload.session_id, typeof payload.data === 'string' ? payload.data : '');
    return { ok: true as const };
  },

  'terminal.resize': async (
    payload: { session_id?: unknown; cols?: unknown; rows?: unknown },
    ctx: { userId: string },
  ) => {
    if (typeof payload?.session_id !== 'string' || !payload.session_id) throw new Error('invalid session_id');
    const cols = typeof payload.cols === 'number' ? payload.cols : 80;
    const rows = typeof payload.rows === 'number' ? payload.rows : 24;
    return { session: resizeTerminal(ctx.userId, payload.session_id, cols, rows) };
  },

  'terminal.close': async (
    payload: { session_id?: unknown },
    ctx: { userId: string },
  ) => {
    if (typeof payload?.session_id !== 'string' || !payload.session_id) throw new Error('invalid session_id');
    return { session: closeTerminalSession(ctx.userId, payload.session_id) };
  },

  'terminal.list': async (_payload: unknown, ctx: { userId: string }) => {
    return { sessions: listTerminalSessions(ctx.userId) };
  },

  'localAgents.readToolResult': async ({ path: filePath }: { path?: unknown }) => {
    if (typeof filePath !== 'string' || !filePath) {
      return { ok: false as const, error: 'invalid path' };
    }
    const uid = (() => {
      try { return getActiveUserId(); }
      catch { return ''; }
    })();
    if (!uid) return { ok: false as const, error: 'no active user' };
    const rootDir = userToolResultsDir(uid);
    // Resolve both sides via realpath when they exist, then compare.
    // The renderer-supplied path may legitimately not exist anymore
    // (sweep ran, tool-result evicted) — handle ENOENT cleanly.
    let resolved: string;
    try {
      resolved = fs.realpathSync(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: false as const, error: 'file no longer exists' };
      return { ok: false as const, error: `cannot resolve path: ${(err as Error).message}` };
    }
    let rootResolved: string;
    try { rootResolved = fs.realpathSync(rootDir); }
    catch { return { ok: false as const, error: 'tool-results dir not found' }; }
    const rel = path.relative(rootResolved, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      log.warn('readToolResult rejected out-of-scope path', { filePath, uid });
      return { ok: false as const, error: 'path is outside tool-results scope' };
    }
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return { ok: false as const, error: 'not a regular file' };
      const total = stat.size;
      if (total <= READ_TOOL_RESULT_MAX_BYTES) {
        const content = fs.readFileSync(resolved, 'utf8');
        return { ok: true as const, content, truncated: false };
      }
      // Oversized — read head only. Buffer-level slice avoids loading
      // the whole file into memory.
      const fd = fs.openSync(resolved, 'r');
      try {
        const buf = Buffer.alloc(READ_TOOL_RESULT_MAX_BYTES);
        fs.readSync(fd, buf, 0, READ_TOOL_RESULT_MAX_BYTES, 0);
        return { ok: true as const, content: buf.toString('utf8'), truncated: true };
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  },
};
