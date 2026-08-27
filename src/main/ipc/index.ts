/**
 * IPC wiring — replaces `bridge/routes.py` for the Electron era.
 *
 * Two channel families:
 *   - `cogseed.invoke` (request/response): renderer → main with a logical
 *     channel name + payload; main returns `{ ok, ...result }` or
 *     `{ ok: false, error }`.
 *   - `cogseed.streamStart` (server-push events): renderer registers a
 *     unique `requestId`, main pushes each event via `webContents.send`
 *     on channel `stream:<requestId>`, terminated by `{ type: 'done' }`.
 *     `cogseed.streamCancel` aborts an in-flight stream.
 *
 * Handler tables below are the full router — add a new logical channel by
 * dropping it into `invokeHandlers` or `streamHandlers`.
 */

import { app, ipcMain, dialog, BrowserWindow, type WebContents } from 'electron';

import * as users from '../features/users';
import * as chats from '../features/chats';
import * as conversationAside from '../features/conversation_aside';
import * as modelClient from '../model/client';
import * as spaces from '../features/spaces';
import * as spacesArtifacts from '../features/spaces_artifacts';
import * as spaceImport from '../features/space_import';
import * as spaceFiles from '../features/project_files';
import * as spaceLibraryIndexer from '../features/project_library_indexer';
import * as groupChat from '../features/group_chat';
import * as companionRepro from '../features/companion_repro';
import * as p3394 from '../features/p3394';
import { P3394IpcChannel } from '../features/p3394_bridge/ipc-channel';
import * as executionRecords from '../features/execution-records';
import * as executionLog from '../features/execution_log';
import * as workbench from '../features/workbench';
import * as cognition from '../features/cognition';
import * as recallCandidates from '../features/recall/candidate-service';
import { withRecallCandidateCapabilities } from '../features/recall/candidate-capabilities';
import * as recallAssets from '../features/recall/asset-service';
import * as recallProfileSync from '../features/recall/personal-profile-sync';
import * as recallSkillDrafts from '../features/recall/skill-draft-service';
import * as recallWorkspaceRefs from '../features/recall/workspace-refs';
import * as recallProjection from '../features/recall/context-projection';
import * as recallProjectionCard from '../features/recall/projection-card';
import * as recallProjectionMessage from '../features/recall/projection-message';
import * as recallTimeline from '../features/recall/timeline-service';
import * as kstarProjectionDecision from '../features/kstar/projection-decision-service';
import { readKstarTaskLifecycle } from '../features/kstar/lifecycle-adapter';
import * as kstarTaskClosure from '../features/kstar/task-closure';
import * as kstarReviewService from '../features/kstar/review-service';
import * as recallProofs from '../features/recall/proof-service';
import * as recallTree from '../features/recall/tree-service';
import * as formalAssets from '../features/recall/formal-assets';
import * as recallUsage from '../features/recall/usage-service';
import * as recallUsageFeedback from '../features/recall/usage-feedback-service';
import * as effectivenessFeedback from '../features/recall/effectiveness-feedback';
import * as recallSources from '../features/recall/source-catalog';
import * as recallCaptures from '../features/recall/capture-service';
import * as recallCaptureSettings from '../features/recall/capture-settings';
import * as recallViews from '../features/recall/recall-view-service';
import * as recallTeaching from '../features/recall/teaching-service';
import * as personalOntologyGroups from '../features/personal_ontology_groups';
import * as personalOntologyTemplateFiles from '../features/personal_ontology_template_files';
import type { GroupEvent } from '../features/group_chat/bus';
import { setGroupChatMessageBroadcaster } from '../features/group_chat/bus';
import * as agents from '../features/agents';
import * as autoTasks from '../features/auto_tasks';
import { isAgentEnabled } from '../features/component_enabled';
import * as skills from '../features/skills';
import * as skillReverify from '../features/skill_reverify';
import * as skillTrust from '../features/skill_trust';
import * as marketplace from '../features/marketplace';
import * as notificationPermissions from '../features/notification_permissions';
import * as marketplaceBiz from '../features/marketplace_biz';
import * as marketplaceCache from '../features/marketplace_cache';
import * as marketplaceReconcile from '../features/marketplace_reconcile';
import * as cacheClearable from '../features/cache_clearable';
import * as contexts from '../features/contexts';
import * as libraryTransfer from '../features/library_transfer';
import * as kbVector from '../features/kb_vector';
import * as kbIndexer from '../features/kb_indexer';
import { terminalEvents } from '../features/terminal/pty-sessions';
import * as chatAttachments from '../features/chat_attachments';
import * as conversationCopyMerge from '../features/conversation_copy_merge';
import * as chatArtifacts from '../features/chat_artifacts';
import * as conversationFiles from '../features/conversation_files';
import * as recycleBin from '../features/recycle_bin';
import * as search from '../features/search';
import * as auth from '../features/auth';
import * as customProviders from '../features/custom_providers';
import * as modelAuthorizationDiscovery from '../features/model_authorization_discovery';
import { probeCcSwitch } from '../features/ccswitch_import';
import * as imageAuth from '../features/image_auth';
import * as searchAuth from '../features/search_auth';
import * as ttsAuth from '../features/tts_auth';
import * as permissions from '../features/permissions';
import * as appConfig from '../features/config';
import * as onboardingState from '../features/onboarding_state';
import * as cliFallback from '../features/cli_fallback';
import * as tourState from '../features/tour_state';
import * as cognitionExtraction from '../features/cognition_extraction';
import { detectAll, type LocalCliType } from '../features/local_agents/registry';
import * as avatars from '../features/avatars';
import * as commanderProfile from '../features/commander_profile';
import * as commanderRuntimeStats from '../features/commander_runtime_stats';
import * as commanderBackend from '../features/commander_backend';
import * as chatExecutionCapability from '../features/chat_execution_capability';
import * as cogseedBackend from '../features/cogseed_backend';
import * as stt from '../features/stt/stt-service';
import { getRendererTables, isLang, isUiLang, t } from '../i18n';
import { isPathAllowed } from '../util/path-sandbox';
import * as userWorkspace from '../features/user_workspace';
import { invokeHandlers as localAgentsHandlers } from './local_agents';
import { p3394ExternalHandlers } from './p3394_external';
import {
  invokeHandlers as expenseWorkbenchHandlers,

} from './expense_workbench';
import { invokeHandlers as qualityHandlers } from './quality';
import { invokeHandlers as connectorsHandlers } from './connectors';
import { invokeHandlers as messagingHandlers } from './messaging';
import * as messagingBindings from '../features/messaging/bindings';
import * as messagingRegistry from '../features/messaging/registry';
import { annotateChannelConversations } from '../features/messaging/channel-annotation';
import { invokeHandlers as personalContextHandlers } from './personal-context';
import { invokeHandlers as touchpointHandlers } from './touchpoints';
import { invokeHandlers as desktopWorkbenchHandlers } from './desktop-workbench';
import { invokeHandlers as hubAccountHandlers } from './hub-account';
import { invokeHandlers as memoryHandlers } from './memory';
import { invokeHandlers as cognitionHandlers } from './cognition';
import { invokeHandlers as updatesHandlers } from './updates';
import { readJsonl, safeId } from '../storage';
import { createLogger, logFromRenderer } from '../logger';
import {
  markConfirmationVisible as markDeleteConfirmationVisible,
  resolveConfirmation as resolveDeleteConfirmation,
} from '../model/core-agent/delete-file-confirm';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { shell } from 'electron';
import { DEFAULT_USER_WORKSPACE, WS_ROOT, projectFilesDir, userMarketplaceSkillDir, userSkillsDir } from '../paths';
import {
  chatAttachmentDirForConversation,
  chatAttachmentRelPath,
  conversationMessageReadFile,
  findAutoTaskLocation,
  globalAutoTaskLocation,
} from '../util/project-layout';
import { readState as readGroupChatState } from '../features/group_chat/state';
import { logErrorRef } from '../util/log-redact';
import { chatMediaLocalPathFromUrl } from '../util/chat-media-url';
import { macosTccSensitivePath } from '../util/macos-tcc';
import { normalizeAppError } from '../util/app-error';
import {
  isTrustedIpcSender,
  parseInvokeEnvelope,
  parseStreamEnvelope,
  parseStreamRequestId,
} from './security';

const log = createLogger('ipc');

function markPreferencesDirty(): void {}

function conversationProjectHint(args: Record<string, any>): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(args, 'project_id')) return undefined;
  const raw = args.project_id;
  if (raw === '' || raw === null) return null;
  if (typeof raw !== 'string' || !safeId(raw)) throw new Error('invalid project id');
  return raw;
}

async function recordDeletedConversationSource(
  userId: string,
  conversation: chats.Conversation,
): Promise<void> {
  await recallSources.removeCognitionSourceRef(userId, {
    kind: 'conversation',
    subtype: 'session',
    scope: 'conversation',
    id: conversation.conversation_id,
    title: conversation.title,
    sourceVersion: conversation.updated_at,
  }, false);
}

interface IpcContext {
  userId: string;
  user: { user_id: string; created_at: string };
  sender: WebContents;
}

type InvokeHandler = (payload: any, ctx: IpcContext) => Promise<any>;

function boundedText(value: unknown, field: string, max: number, required = true): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new Error(`${field} required`);
  if (text.length > max) throw new Error(`${field} too long`);
  return text;
}

function boundedModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('selectedModels must be array');
  return value.slice(0, 100).map((model) => boundedText(model, 'model', 200)).filter(Boolean);
}

function boundedCustomProviderModel(value: unknown, field: string): {
  id: string;
  contextWindow: number;
  maxTokens: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} required`);
  const raw = value as { id?: unknown; contextWindow?: unknown; maxTokens?: unknown };
  const id = boundedText(raw.id, `${field}.id`, 200);
  const boundedInteger = (candidate: unknown, name: string, max: number): number => {
    if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0 || (candidate as number) > max) {
      throw new Error(`${name} must be a positive safe integer at most ${max}`);
    }
    return candidate as number;
  };
  const contextWindow = boundedInteger(raw.contextWindow, `${field}.contextWindow`, 16_777_216);
  const maxTokens = boundedInteger(raw.maxTokens, `${field}.maxTokens`, 1_048_576);
  if (maxTokens > contextWindow) throw new Error(`${field}.maxTokens must not exceed contextWindow`);
  return { id, contextWindow, maxTokens };
}
type StreamHandler = (
  payload: any,
  ctx: IpcContext,
  signal: AbortSignal,
) => AsyncGenerator<any, void, unknown>;

function _activeUserIdForPicker(): string {
  try { return users.getActiveUserId(); } catch { return ''; }
}

function _usableDialogDefaultPath(candidate: string | undefined): string | undefined {
  if (!candidate || !path.isAbsolute(candidate)) return undefined;
  const abs = path.resolve(candidate);
  if (macosTccSensitivePath(abs, { recursive: true })) return undefined;
  try { return fs.statSync(abs).isDirectory() ? abs : undefined; }
  catch { return undefined; }
}

function _safeDialogDefaultPath(preferred?: string): string | undefined {
  const uid = _activeUserIdForPicker();
  const candidates: Array<string | undefined> = [preferred];
  if (uid) {
    try { candidates.push(userWorkspace.getWorkspacePath(uid)); } catch { /* ignore */ }
  }
  candidates.push(DEFAULT_USER_WORKSPACE, WS_ROOT);
  for (const candidate of candidates) {
    const usable = _usableDialogDefaultPath(candidate);
    if (usable) return usable;
  }
  return undefined;
}

const CHAT_PICK_EXTENSIONS = [...chatAttachments.ALLOWED_EXTENSIONS]
  .map((ext) => ext.replace(/^\./, ''))
  .sort();
const CONTEXT_PICK_EXTENSIONS = [
  'md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'log',
  'html', 'htm', 'xml', 'toml', 'ini', 'conf',
  'py', 'pyi', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'sh', 'bash', 'zsh', 'ps1', 'cmd', 'bat', 'rb', 'go', 'rs', 'java', 'kt',
  'c', 'cpp', 'cc', 'h', 'hpp', 'css', 'scss', 'less',
  'sql', 'graphql', 'gql',
  'pdf', 'docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm',
  'png', 'jpg', 'jpeg', 'webp', 'gif',
];
const PROJECT_PICK_EXTENSIONS = [
  ...CONTEXT_PICK_EXTENSIONS,
  'mp4', 'webm', 'mov', 'm4v', 'ogv',
];

async function _pickLocalFiles(
  title: string,
  extensions: string[],
  multiSelections = true,
  seedWorkspaceOnFirstOpen = false,
): Promise<string[]> {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const ext = Array.from(new Set(extensions.map((x) => String(x || '').replace(/^\./, '').toLowerCase()).filter(Boolean)));
  const opts: Electron.OpenDialogOptions = {
    title,
    properties: multiSelections ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: ext.length ? [{ name: 'Supported files', extensions: ext }] : undefined,
  };
  let preferred: string | undefined;
  if (seedWorkspaceOnFirstOpen) {
    const uid = _activeUserIdForPicker();
    preferred = uid ? userWorkspace.consumePickerFirstOpenDefault(uid) : undefined;
  }
  opts.defaultPath = _safeDialogDefaultPath(preferred);
  const res = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths?.length) return [];
  return res.filePaths;
}

function _targetInDir(targetDir: unknown, baseName: string): string {
  const dir = typeof targetDir === 'string' ? targetDir.trim().replace(/^\/+|\/+$/g, '') : '';
  return dir ? `${dir}/${baseName}` : baseName;
}

interface LocalFileImportEntry {
  path: string;
  name: string;
  size?: number;
}

async function _importLocalFileEntries(payload: any, ctx: IpcContext): Promise<{ files: any[] }> {
  const scope = payload?.scope;
  const entries = Array.isArray(payload?.entries)
    ? payload.entries.slice(0, 200).filter((entry: unknown): entry is LocalFileImportEntry => {
      if (!entry || typeof entry !== 'object') return false;
      const item = entry as Partial<LocalFileImportEntry>;
      return typeof item.path === 'string'
        && path.isAbsolute(item.path)
        && typeof item.name === 'string'
        && !!item.name.trim();
    })
    : [];
  if (!entries.length) return { files: [] };

  const results = [];
  if (scope === 'contexts') {
    for (const entry of entries) {
      const name = path.basename(entry.name);
      const target = _targetInDir(payload?.targetDir, name);
      const ext = path.extname(name).toLowerCase();
      if (contexts.hasHiddenContextPathSegment(target)) {
        results.push({ ok: false, name, target, bytes: entry.size || 0, ext, reason: 'hidden' });
        continue;
      }
      if (!contexts.isSupportedContextFileName(target)) {
        results.push({ ok: false, name, target, bytes: entry.size || 0, ext, reason: 'ext' });
        continue;
      }
      const result = await contexts.importContextFileFromPath(target, entry.path);
      results.push({ name, target, bytes: entry.size || 0, ext, ...result });
    }
    return { files: results };
  }

  if (scope === 'space') {
    const spaceId = payload?.spaceId;
    if (!safeId(spaceId) || !await spaces.spaceExists(ctx.userId, spaceId)) {
      throw new Error('invalid spaceId');
    }
    for (const entry of entries) {
      const name = path.basename(entry.name);
      const targetName = _targetInDir(payload?.targetDir, name);
      const result = await spaceFiles.importSpaceFileFromPath(
        ctx.userId,
        spaceId,
        targetName,
        entry.path,
      );
      results.push({ name, targetName, ...result });
    }
    return { files: results };
  }
  throw new Error('invalid import scope');
}

// Resolve the workspace scope hint a renderer payload carries. cid is
// authoritative (conv.project_id is the truth, so a cid uniquely picks a
// project); projectId is the fallback for commander-tab clicks where no cid
// exists yet. Returns `undefined` for default scope.
async function _resolveWorkspaceScope(
  userId: string,
  payload: any,
): Promise<string | undefined> {
  if (payload && typeof payload.cid === 'string' && payload.cid && safeId(payload.cid)) {
    return await userWorkspace.resolveProjectIdForCid(userId, payload.cid);
  }
  if (payload && typeof payload.projectId === 'string' && payload.projectId && safeId(payload.projectId)) {
    return payload.projectId;
  }
  return undefined;
}

// Resolve the cid-scoped attachment dir from a renderer payload, when present.
// The file-tools' allowed-paths scope is "active workspace ∪ this cid's
// attachment dir" (CLAUDE.md §5); reveal + preview must honour the same
// union so a user can preview an attachment they uploaded, not just files
// the LLM wrote into the workspace.
function _attachmentScopeForPayload(userId: string, payload: any): string | null {
  if (!payload || typeof payload.cid !== 'string' || !payload.cid) return null;
  if (!safeId(payload.cid)) return null;
  return path.resolve(chatAttachmentDirForConversation(userId, payload.cid));
}

// Project-file scope for sandbox checks. Takes the already-resolved projectId
// (computed by `_resolveWorkspaceScope`, which is cid-authoritative) rather
// than reading payload.projectId directly — this enforces that a caller
// passing `{cid, projectId}` where conv-cid.project_id !== projectId cannot
// reach a foreign project's files (the cid wins, the claimed projectId
// silently drops). When no cid is in payload, `_resolveWorkspaceScope`
// already falls back to payload.projectId, so the commander-tab path
// (project chip click before any conversation exists) continues to work.
function _projectFileScopeForUser(userId: string, projectId: string | undefined): string | null {
  if (!projectId || !safeId(projectId)) return null;
  return path.resolve(projectFilesDir(userId, projectId));
}

function _escapePreviewHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type OfficePreviewKind = 'word' | 'spreadsheet' | 'presentation';

function _officePreviewKindForExt(ext: string): OfficePreviewKind | null {
  if (ext === '.docx' || ext === '.docm') return 'word';
  if (ext === '.xlsx' || ext === '.xlsm') return 'spreadsheet';
  if (ext === '.pptx' || ext === '.pptm') return 'presentation';
  return null;
}

// 卡片视图会为可视卡片批量请求 Office 预览：按 path+size+mtime 做进程内
// LRU 缓存（上限 24 条），同一文件重复预览/卡片来回滚动不重复解析。
const _officePreviewCache = new Map<string, { at: number; html: string; kind: string }>();
const OFFICE_PREVIEW_CACHE_MAX = 24;

function _officePreviewCacheGet(key: string): { html: string; kind: string } | null {
  const hit = _officePreviewCache.get(key);
  if (!hit) return null;
  hit.at = Date.now();
  return { html: hit.html, kind: hit.kind };
}

function _officePreviewCachePut(key: string, html: string, kind: string): void {
  _officePreviewCache.set(key, { at: Date.now(), html, kind });
  if (_officePreviewCache.size <= OFFICE_PREVIEW_CACHE_MAX) return;
  let oldestKey = '';
  let oldestAt = Infinity;
  for (const [k, v] of _officePreviewCache) {
    if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
  }
  if (oldestKey) _officePreviewCache.delete(oldestKey);
}

function _wrapOfficePreviewHtml(kind: OfficePreviewKind, title: string, body: string, opts?: { compact?: boolean }): string {
  const safeTitle = _escapePreviewHtml(title || 'Office preview');
  // 卡片缩略模式：整页紧贴顶部、小字号、去留白——小卡里「全而不大」。
  const compactCss = opts?.compact ? `
  <style>
    body { background: #fff; font-size: 11px; }
    .office-preview { padding: 0; min-height: 0; }
    .office-word { max-width: none; min-height: 0; margin: 0; padding: 12px 14px; border: 0; box-shadow: none; }
    .office-word h1 { margin: 0 0 8px; font-size: 16px; }
    .office-word h2 { margin: 12px 0 6px; font-size: 13px; }
    .office-word h3 { margin: 10px 0 5px; font-size: 12px; }
    .office-word p, .office-word li { margin: 0 0 6px; font-size: 11px; line-height: 1.5; }
    .office-word ul, .office-word ol { margin: 0 0 8px 18px; }
    .office-word table, .office-table-wrap table { margin: 8px 0; font-size: 10px; }
    .office-word th, .office-word td, .office-table-wrap th, .office-table-wrap td { padding: 3px 5px; }
    .office-spreadsheet { padding: 6px; }
    .office-sheet { margin: 0 0 10px; padding: 8px; }
    .office-sheet h2 { margin: 0 0 8px; font-size: 12px; }
    .office-table-wrap { max-height: none; }
    .office-table-wrap td { min-width: 60px; }
    .office-presentation { padding: 6px; gap: 8px; }
    .office-slide { width: 100%; padding: 12px 14px; border-radius: 4px; }
    .office-slide-body p { margin: 0 0 6px; font-size: 12px; }
    .office-slide-body p:first-child { font-size: 14px; }
  </style>` : '';
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #eef2f7;
      color: #0f172a;
      font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .office-preview {
      width: 100%;
      min-height: 100vh;
      margin: 0 auto;
      padding: 24px;
    }
    .office-word {
      max-width: 820px;
      background: #fff;
      min-height: calc(100vh - 48px);
      margin: 20px auto 32px;
      padding: 56px 64px;
      border: 1px solid #e5e7eb;
      box-shadow: 0 1px 8px rgba(15, 23, 42, 0.06);
    }
    .office-spreadsheet {
      max-width: none;
      padding: 18px;
    }
    .office-word h1, .office-word h2, .office-word h3 {
      line-height: 1.3;
      color: #111827;
    }
    .office-word h1 {
      margin: 0 0 22px;
      font-size: 28px;
      font-weight: 700;
    }
    .office-word h2 {
      margin: 26px 0 12px;
      font-size: 21px;
      font-weight: 650;
    }
    .office-word h3 {
      margin: 22px 0 10px;
      font-size: 17px;
      font-weight: 650;
    }
    .office-word p,
    .office-word li {
      margin: 0 0 13px;
      font-size: 15px;
      line-height: 1.72;
      color: #111827;
    }
    .office-word ul,
    .office-word ol {
      margin: 0 0 16px 24px;
      padding: 0;
    }
    .office-word table {
      border-collapse: collapse;
      width: 100%;
      margin: 16px 0;
    }
    .office-word th, .office-word td,
    .office-table-wrap th, .office-table-wrap td {
      border: 1px solid #cbd5e1;
      padding: 7px 9px;
      vertical-align: top;
    }
    .office-sheet {
      margin: 0 0 22px;
      padding: 18px;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
    }
    .office-sheet h2 {
      margin: 0 0 12px;
      font-size: 15px;
    }
    .office-table-wrap {
      overflow: auto;
      max-height: 70vh;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
    }
    .office-table-wrap table {
      border-collapse: collapse;
      min-width: 100%;
      background: #fff;
      font-size: 13px;
    }
    .office-table-wrap td {
      min-width: 96px;
      white-space: pre-wrap;
    }
    .office-empty-cell, .office-muted { color: #64748b; }
    .office-presentation {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 24px;
      padding: 24px;
    }
    .office-slide {
      width: min(1120px, calc(100vw - 64px));
      aspect-ratio: 16 / 9;
      margin: 0 auto;
      padding: clamp(32px, 5vw, 64px);
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
      display: flex;
      align-items: center;
    }
    .office-slide-body p {
      margin: 0 0 18px;
      font-size: clamp(18px, 2vw, 30px);
      line-height: 1.35;
    }
    .office-slide-body p:first-child {
      font-size: clamp(26px, 3vw, 44px);
      font-weight: 600;
      line-height: 1.2;
    }
    @media (max-width: 720px) {
      .office-preview { padding: 12px; }
      .office-word {
        margin: 0 auto;
        min-height: calc(100vh - 24px);
        padding: 32px 24px;
      }
      .office-word h1 { font-size: 24px; }
      .office-word p,
      .office-word li { font-size: 14px; }
      .office-presentation { padding: 12px; gap: 14px; }
      .office-slide {
        width: calc(100vw - 24px);
        padding: 24px;
      }
      .office-slide-body p { font-size: 16px; }
      .office-slide-body p:first-child { font-size: 22px; }
    }
  </style>
  ${compactCss}
</head>
<body>
  <main class="office-preview office-${kind}">
    ${body}
  </main>
</body>
</html>`;
}

/** Build the allowed-roots list for the file-class IPC sandbox: workspace ∪
 *  current cid's attachment dir ∪ payload's project-file dir. The actual
 *  containment check happens via `util/path-sandbox.isPathAllowed`, which
 *  realpath-resolves both candidate and roots so a symlink planted inside
 *  any allowed root cannot exfiltrate to a path outside.
 *
 *  Centralised for `conversations.attachments.import` / `workspace.revealPath`
 *  / `produced.readText` / `produced.writeText` so the scope union stays in
 *  sync. Previously each handler did its own `path.resolve(target).startsWith(
 *  scope + path.sep)` triplet — lexical only, which let a symlink target
 *  outside the scope quietly slip through under a `<uid>` workspace path
 *  that itself contained one (the realistic attack: LLM-assisted skill
 *  drops a symlink into an attachment dir; user later writes to the
 *  apparent path through `produced.writeText` and the bytes land at
 *  attacker-chosen target). */
async function _ipcFileSandboxAllowedRoots(userId: string, payload: any): Promise<string[]> {
  const projectId = await _resolveWorkspaceScope(userId, payload);
  const roots: string[] = [userWorkspace.getWorkspacePath(userId, projectId)];
  const att = _attachmentScopeForPayload(userId, payload);
  if (att) roots.push(att);
  const pf = _projectFileScopeForUser(userId, projectId);
  if (pf) roots.push(pf);
  return roots;
}

/** Test-only export — see `test/main/ipc/{produced-readText,workspace-reveal}.test.ts`. */
export const _ipcFileSandboxAllowedRootsForTest = _ipcFileSandboxAllowedRoots;

async function _isConversationRecordedFile(userId: string, cid: string, absPath: string): Promise<boolean> {
  if (!safeId(cid)) return false;
  const target = path.resolve(absPath);
  const matches = (value: unknown): boolean =>
    typeof value === 'string' && !!value && path.resolve(value) === target;

  try {
    const messages = await chats.getMessages(userId, cid, 2000);
    for (const msg of messages as any[]) {
      const produced = Array.isArray(msg?.produced) ? msg.produced : [];
      if (produced.some(matches)) return true;
    }
  } catch { /* best-effort allow-list */ }

  return false;
}

async function _isAllowedFileActionPath(userId: string, payload: any, absPath: string): Promise<boolean> {
  if (isPathAllowed(absPath, await _ipcFileSandboxAllowedRoots(userId, payload))) return true;
  // COGSEED-18：空间内容目录内的文件放行（文件夹导入产物在 `<空间>/imports/` 下，
  // 条目无 cid）。仅当调用方显式声明 spaceId 且该空间属于当前用户——防越权。
  const spaceId = payload?.spaceId;
  if (typeof spaceId === 'string' && safeId(spaceId) && await spaces.spaceExists(userId, spaceId)) {
    try {
      const { spaceContentDir } = await import('../paths');
      const contentDir = path.resolve(spaceContentDir(userId, spaceId));
      const target = path.resolve(absPath);
      if (target === contentDir || target.startsWith(contentDir + path.sep)) return true;
    } catch { /* fall through */ }
  }
  const cid = payload?.cid;
  if (typeof cid !== 'string' || !cid) return false;
  // 1) 会话记录过的产物文件（消息 produced[]）
  if (await _isConversationRecordedFile(userId, cid, absPath)) return true;
  // 2) 空间会话工作区目录内的文件（工作区兜底扫到的产物——部分工具直接写文件、
  //    未登记 produced，打开/定位产物时也应放行）
  try {
    const conv = await chats.getConversation(userId, cid);
    if (conv?.space_id) {
      const { getConversationWorkspacePath } = await import('../features/group_chat/conv_workspace');
      const wsDir = path.resolve(await getConversationWorkspacePath(userId, cid));
      const target = path.resolve(absPath);
      if (target === wsDir || target.startsWith(wsDir + path.sep)) return true;
    }
  } catch { /* fall through to false */ }
  return false;
}

function _contextTreeHasPath(nodes: contexts.ContextNode[], relPath: string): boolean {
  for (const node of nodes || []) {
    if (node.path === relPath) return true;
    if (node.type === 'dir' && node.children?.length && _contextTreeHasPath(node.children, relPath)) return true;
  }
  return false;
}

async function _uniqueContextImportPath(rawName: string): Promise<string> {
  const name = path.basename(String(rawName || '').trim() || 'artifact');
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const tree = await contexts.listContextsTree();
  if (!_contextTreeHasPath(tree, name)) return name;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!_contextTreeHasPath(tree, candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

function _libraryImportTargetName(payload: any, sourcePath: string): string {
  const raw = typeof payload?.targetPath === 'string' && payload.targetPath.trim()
    ? payload.targetPath.trim()
    : (typeof payload?.name === 'string' && payload.name.trim() ? payload.name.trim() : path.basename(sourcePath));
  return raw || path.basename(sourcePath) || 'artifact';
}

function _libraryTextTargetName(payload: any): string {
  const raw = typeof payload?.targetPath === 'string' && payload.targetPath.trim()
    ? payload.targetPath.trim()
    : (typeof payload?.path === 'string' && payload.path.trim() ? payload.path.trim() : '');
  return raw || 'archive.md';
}

async function _resolveLibraryTargetSpaceId(userId: string, payload: any): Promise<string | undefined> {
  const requestedScope = payload?.targetScope && typeof payload.targetScope === 'object'
    ? payload.targetScope
    : null;
  let spaceId: string | undefined;
  if (payload && typeof payload.cid === 'string' && payload.cid && safeId(payload.cid)) {
    const { getConversation } = await import('../features/chats');
    const conv = await getConversation(userId, payload.cid);
    const sid = (conv as any)?.space_id;
    spaceId = typeof sid === 'string' && sid ? sid : undefined;
  } else if (payload && typeof payload.spaceId === 'string' && payload.spaceId && safeId(payload.spaceId)) {
    spaceId = payload.spaceId;
  }
  if (requestedScope?.type === 'global') spaceId = undefined;
  if (requestedScope?.type === 'space' && typeof requestedScope.spaceId === 'string' && safeId(requestedScope.spaceId)) {
    spaceId = requestedScope.spaceId;
  }
  return spaceId;
}

async function _importProducedToLibrary(payload: any, ctx: IpcContext): Promise<any> {
  const target = payload?.path;
  if (typeof target !== 'string' || !target) throw new Error('missing path');
  const norm = path.resolve(target);
  if (!await _isAllowedFileActionPath(ctx.userId, payload, norm)) {
    throw new Error('path is outside the user workspace');
  }
  let st: fs.Stats;
  try { st = fs.statSync(norm); }
  catch { return { ok: false, error: 'not_found' }; }
  if (!st.isFile()) return { ok: false, error: 'not_supported' };

  const spaceId = await _resolveLibraryTargetSpaceId(ctx.userId, payload);
  const buf = fs.readFileSync(norm);
  const targetName = _libraryImportTargetName(payload, norm);
  if (spaceId) {
    const result = await spaceFiles.uploadSpaceFile(ctx.userId, spaceId, targetName, buf);
    if (!result.ok) return result;
    return { ok: true, scope: 'space', spaceId, info: result.info };
  }

  const relPath = typeof payload?.targetPath === 'string' && payload.targetPath.trim()
    ? payload.targetPath.trim()
    : await _uniqueContextImportPath(targetName);
  const result = contexts.uploadContextFile(relPath, buf);
  if (!result.ok) return result;
  return { ok: true, scope: 'global', path: result.path, bytes: result.bytes };
}

async function _writeTextToLibrary(payload: any, ctx: IpcContext): Promise<any> {
  const content = typeof payload?.content === 'string' ? payload.content : '';
  const targetName = _libraryTextTargetName(payload);
  const spaceId = await _resolveLibraryTargetSpaceId(ctx.userId, payload);
  if (spaceId) {
    const result = await spaceFiles.uploadSpaceFile(ctx.userId, spaceId, targetName, Buffer.from(content, 'utf8'));
    if (!result.ok) return result;
    return { ok: true, scope: 'space', spaceId, info: result.info };
  }

  const result = contexts.writeContextFile(targetName, content);
  if (!result.ok) return result;
  return { ok: true, scope: 'global', path: result.path };
}

export const _libraryWriteTextForTest = _writeTextToLibrary;
export const _libraryImportProducedForTest = _importProducedToLibrary;

function _recycleDataChangeForPaths(paths: string[]): { domains: string[]; cids: string[]; recycle: true } {
  const domains = new Set<string>();
  const cids = new Set<string>();
  for (const raw of paths || []) {
    const rel = String(raw || '').replace(/\\/g, '/');
    if (!rel.startsWith('cloud/')) continue;
    const first = rel.slice('cloud/'.length).split('/', 1)[0];
    if (first === 'chats' || first === 'chat_attachments' || first === 'chat_artifacts' || first === 'sessions') {
      domains.add('chats');
    } else if (first === 'contexts') domains.add('contexts');
    else if (first === 'projects') {
      const parts = rel.split('/');
      const projectChild = parts[3] || '';
      if (projectChild === 'chats' || projectChild === 'chat_attachments' || projectChild === 'chat_artifacts' || projectChild === 'sessions') {
        domains.add('chats');
      } else if (projectChild === 'auto_tasks') {
        domains.add('auto_tasks');
      } else {
        domains.add('projects');
      }
    }
    else if (first === 'auto_tasks') domains.add('auto_tasks');
    else if (first === 'agents') domains.add('agents');
    else if (first === 'skills') domains.add('skills');
    else if (first === 'marketplace') domains.add('marketplace');
    else if (first === 'config') domains.add('component_enabled');

    const chatFile = /^cloud\/chats\/([^/]+)\.jsonl$/.exec(rel);
    const chatDir = /^cloud\/chats\/([^/]+)\//.exec(rel);
    const chatPool = /^cloud\/chat_(?:attachments|artifacts)\/([^/]+)\//.exec(rel);
    const projectChatFile = /^cloud\/projects\/[^/]+\/chats\/([^/]+)\.jsonl$/.exec(rel);
    const projectChatDir = /^cloud\/projects\/[^/]+\/chats\/([^/]+)\//.exec(rel);
    const projectChatPool = /^cloud\/projects\/[^/]+\/chat_(?:attachments|artifacts)\/([^/]+)\//.exec(rel);
    const cid = chatFile?.[1] || chatDir?.[1] || chatPool?.[1]
      || projectChatFile?.[1] || projectChatDir?.[1] || projectChatPool?.[1] || '';
    if (cid && safeId(cid) && cid !== 'agent' && cid !== 'skill') cids.add(cid);
  }
  return { domains: Array.from(domains), cids: Array.from(cids), recycle: true };
}

function _codedError(code: string): Error & { code: string } {
  const err = new Error(code) as Error & { code: string };
  err.code = code;
  return err;
}

async function _afterRecycleRestore(ctx: IpcContext, paths: string[]): Promise<void> {
  const change = _recycleDataChangeForPaths(paths);
  for (const raw of paths || []) {
    const rel = String(raw || '').replace(/\\/g, '/');
    if (rel.startsWith('cloud/contexts/')) {
      const ctxRel = rel.slice('cloud/contexts/'.length);
      if (ctxRel) {
        search.upsertContext(ctx.userId, ctxRel);
        kbIndexer.enqueue(ctx.userId, ctxRel, 'upsert');
      }
    }
    const projectFile = /^cloud\/projects\/([^/]+)\/(?:contexts|files)\/(.+)$/.exec(rel);
    if (projectFile && safeId(projectFile[1]) && projectFile[2]) {
      spaceLibraryIndexer.enqueue(ctx.userId, projectFile[1], projectFile[2], 'upsert');
    }
  }
  if (change.domains.includes('agents')) {
    try { agents.invalidateAgentListCache(); } catch { /* best-effort cache bust */ }
  }
  if (change.domains.includes('skills')) {
    try { skills.clearSkillListCache(); } catch { /* best-effort cache bust */ }
  }
  if (change.domains.includes('auto_tasks')) {
    autoTasks.rescheduleAllForActiveUser().catch((err) => {
      log.warn('auto task reschedule after recycle restore failed', { error: logErrorRef(err) });
    });
  }
  void change;
}

// ── Invoke handlers ──────────────────────────────────────────────────────
// Contract: `(payload, { userId, sender }) => result` where result is
// merged into a `{ ok: true, ...result }` response. Throw to signal error.

/**
 * Resolve an installed skill's content directory for the workbench handlers.
 *
 * Checks the same roots in the same precedence order as
 * `skills.getSkillForEdit` (marketplace before custom) so a baseline pins the
 * tree the runtime would actually load. Returns null when the skill is absent,
 * letting callers report a readable refusal instead of hashing a missing path.
 */
function _resolveWorkbenchSkillDir(userId: string, skillId: string): string | null {
  const candidates = [
    userMarketplaceSkillDir(userId, skillId),
    path.join(userSkillsDir(userId), skillId),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
  }
  return null;
}

async function ensureKstarWakeProjectionConfirmed(
  userId: string,
  cid: string,
  requestId: string,
  decision: unknown,
  request: { kstar_decision?: { required?: unknown }; asset_confirmation_snapshot?: { projection_id?: unknown } },
): Promise<{ ok: false; error: string } | null> {
  if (decision !== 'approve') return null;
  if (request.kstar_decision?.required !== true) return null;
  if (typeof request.asset_confirmation_snapshot?.projection_id === 'string') return null;
  const lifecycle = await readKstarTaskLifecycle(userId, cid);
  const projectionId = lifecycle.requirement?.projectionId || lifecycle.projection?.id;
  if (!projectionId || !safeId(projectionId)) {
    return { ok: false, error: 'kstar wake request has no confirmed projection' };
  }
  const confirmed = await recallProjection.confirmAndApproveWake(userId, { cid, projectionId, wakeRequestId: requestId });
  if (confirmed.ok !== true) return { ok: false, error: confirmed.error || 'projection wake confirmation failed' };
  return null;
}

const invokeHandlers: Record<string, InvokeHandler> = {
  'stt.start': async (_payload, ctx) => stt.startSession(ctx.userId),
  'stt.pushAudio': async (payload, ctx) => {
    const raw = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    if (typeof raw.sessionId !== 'string' || !safeId(raw.sessionId)) throw new Error('invalid session id');
    if (typeof raw.chunk !== 'string') throw new Error('invalid audio chunk');
    const bytes = Buffer.from(raw.chunk, 'base64');
    if (bytes.length % 2 !== 0) throw new Error('invalid pcm length');
    const samples = new Float32Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2) / 32768;
    stt.pushAudio(ctx.userId, raw.sessionId, samples);
    return { ok: true };
  },
  'stt.stop': async (payload, ctx) => {
    const raw = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    if (typeof raw.sessionId !== 'string' || !safeId(raw.sessionId)) throw new Error('invalid session id');
    return stt.stopSession(ctx.userId, raw.sessionId);
  },
  'cogseed.task.start': async (payload, ctx) => cogseedBackend.cogseedIpcService.start(ctx.userId, payload),
  'cogseed.task.read': async (payload, ctx) => cogseedBackend.cogseedIpcService.read(ctx.userId, payload),
  'cogseed.task.cancel': async (payload, ctx) => cogseedBackend.cogseedIpcService.cancel(ctx.userId, payload),
  'cogseed.task.abort': async (payload, ctx) => cogseedBackend.cogseedIpcService.abort(ctx.userId, payload),
  'cogseed.task.retry': async (payload, ctx) => cogseedBackend.cogseedIpcService.retry(ctx.userId, payload),
  'cogseed.task.resume': async (payload, ctx) => cogseedBackend.cogseedIpcService.resume(ctx.userId, payload),
  'cogseed.task.action': async (payload, ctx) => cogseedBackend.cogseedIpcService.action(ctx.userId, payload),
  'cogseed.task.events': async (payload, ctx) => cogseedBackend.cogseedIpcService.events(ctx.userId, payload),
  'cogseed.connector.list': async (_payload, ctx) => cogseedBackend.cogseedIpcService.connectors(ctx.userId),
  'cogseed.kb.index': async (payload, ctx) => cogseedBackend.cogseedIpcService.kbIndex(ctx.userId, payload),
  'cogseed.kb.search': async (payload, ctx) => cogseedBackend.cogseedIpcService.kbSearch(ctx.userId, payload),
  'cogseed.kb.read': async (payload, ctx) => cogseedBackend.cogseedIpcService.kbRead(ctx.userId, payload),
  'cogseed.kb.sources': async (_payload, ctx) => cogseedBackend.cogseedIpcService.kbSources(ctx.userId),
  'cogseed.connector.tools': async (payload, ctx) => cogseedBackend.cogseedIpcService.connectorTools(ctx.userId, payload),
  'cogseed.session.list': async (_payload, ctx) => ({ sessions: await cogseedBackend.cogseedIpcService.sessions(ctx.userId) }),
  'cogseed.session.read': async (payload, ctx) => cogseedBackend.cogseedIpcService.session(ctx.userId, payload),
  'cogseed.runtime.status': async (_payload, ctx) => cogseedBackend.cogseedIpcService.runtimeStatus(ctx.userId),
  'cogseed.runtime.restart': async (_payload, ctx) => cogseedBackend.cogseedIpcService.restartRuntime(ctx.userId),
  'cogseed.runtime.recover': async (_payload, ctx) => cogseedBackend.cogseedIpcService.recover(ctx.userId),

  // Execution log handlers
  'executionLog.readAll': async () => {
    return { records: executionLog.readAllRecords() };
  },
  'executionLog.readSince': async (payload) => {
    const sinceMs = typeof payload?.sinceMs === 'number' ? payload.sinceMs : Date.now();
    return { records: executionLog.readRecordsSince(sinceMs) };
  },
  'executionLog.cleanup': async () => {
    executionLog.cleanupOldRecords();
    return { ok: true };
  },

  'user.init': async () => {
    const user = await users.getOrCreateSelfUser();
    return user;
  },

  'conversations.list': async ({ mode, active_cid, expanded_projects, project_id, task_id, bucket, offset }, ctx) => {
    // Channel conversations get their sidebar grouping fields (platform
    // back-fill via bindings + live display name) on every list response;
    // persisted fields stay authoritative, the join is display-only.
    const annotate = async <T extends { conversation_id: string; channel_platform?: string }>(rows: readonly T[]): Promise<T[]> => {
      if (!rows.length) return [...rows];
      const [bindings, instances] = await Promise.all([
        messagingBindings.listBindings(ctx.userId).catch(() => []),
        messagingRegistry.listInstances(ctx.userId).catch(() => []),
      ]);
      return annotateChannelConversations(rows, bindings, instances);
    };
    if (mode === 'startup') {
      const expandedProjectIds = String(expanded_projects || '')
        .split(',')
        .filter((id) => safeId(id));
      const result = await chats.listStartupConversations(ctx.userId, {
        activeConversationId: safeId(active_cid) ? active_cid : undefined,
        expandedProjectIds,
      });
      if (Array.isArray((result as { conversations?: unknown }).conversations)) {
        (result as { conversations: Awaited<ReturnType<typeof annotate>> }).conversations =
          await annotate((result as { conversations: Array<{ conversation_id: string; channel_platform?: string }> }).conversations);
      }
      return result;
    }
    if (mode === 'project') {
      if (!safeId(project_id)) throw new Error('invalid project id');
      const page = await chats.listProjectConversationPage(ctx.userId, project_id, offset);
      if (Array.isArray((page as { conversations?: unknown }).conversations)) {
        (page as { conversations: Awaited<ReturnType<typeof annotate>> }).conversations =
          await annotate((page as { conversations: Array<{ conversation_id: string; channel_platform?: string }> }).conversations);
      }
      return page;
    }
    if (mode === 'auto_task') {
      if (!safeId(task_id)) throw new Error('invalid auto task id');
      const page = await chats.listAutoTaskConversationPage(ctx.userId, task_id, offset);
      if (Array.isArray((page as { conversations?: unknown }).conversations)) {
        (page as { conversations: Awaited<ReturnType<typeof annotate>> }).conversations =
          await annotate((page as { conversations: Array<{ conversation_id: string; channel_platform?: string }> }).conversations);
      }
      return page;
    }
    if (mode === 'old_unprojected') {
      if (bucket !== 'last30' && bucket !== 'older') throw new Error('invalid conversation bucket');
      const page = await chats.listOldUnprojectedConversationPage(ctx.userId, bucket, offset);
      if (Array.isArray((page as { conversations?: unknown }).conversations)) {
        (page as { conversations: Awaited<ReturnType<typeof annotate>> }).conversations =
          await annotate((page as { conversations: Array<{ conversation_id: string; channel_platform?: string }> }).conversations);
      }
      return page;
    }
    return { conversations: await annotate(await chats.listConversations(ctx.userId)) };
  },

  'conversations.autoTaskCounts': async ({ task_ids } = {}, ctx) => {
    const ids = Array.isArray(task_ids) ? task_ids : [];
    return { counts: await chats.countAutoTaskConversations(ctx.userId, ids) };
  },

  'conversations.get': async (args, ctx) => {
    const { cid } = args;
    if (!safeId(cid)) throw new Error('invalid cid');
    const conv = await chats.getConversation(ctx.userId, cid, conversationProjectHint(args));
    if (!conv) throw new Error('conversation not found');
    // Same channel annotation as the list endpoints — a freshly hydrated
    // sidebar row (e.g. external inbound to a brand-new conversation) must
    // land in its channel group immediately.
    if (!conv.channel_platform) {
      const [bindings, instances] = await Promise.all([
        messagingBindings.listBindings(ctx.userId).catch(() => []),
        messagingRegistry.listInstances(ctx.userId).catch(() => []),
      ]);
      const [annotated] = annotateChannelConversations([conv], bindings, instances);
      return { conversation: annotated || conv };
    }
    const [instances] = await Promise.all([
      messagingRegistry.listInstances(ctx.userId).catch(() => []),
    ]);
    const [annotated] = annotateChannelConversations([conv], [], instances);
    return { conversation: annotated || conv };
  },

  'conversations.setPermissionMode': async (args, ctx) => {
    const { cid, permission_mode } = args;
    if (!safeId(cid)) throw new Error('invalid cid');
    if (permission_mode !== 'full' && permission_mode !== 'auto_approve' && permission_mode !== 'ask') {
      throw new Error('invalid permission mode');
    }
    const conv = await chats.updateConversation(ctx.userId, cid, { permission_mode }, conversationProjectHint(args));
    if (!conv) throw new Error('conversation not found');
    return { conversation: conv };
  },

  'conversations.history': async (args, ctx) => {
    const { cid, limit = 10, before, around_index } = args;
    if (!safeId(cid)) throw new Error('invalid cid');
    const projectIdHint = conversationProjectHint(args);
    const conv = await chats.getConversation(ctx.userId, cid, projectIdHint);
    if (!conv) throw new Error('conversation not found');
    const resolvedProjectId = conv.project_id ?? null;
    // Stamp the conv-bound agent's current enabled state so the renderer can
    // grey out the input + show a banner without making a second IPC round trip.
    // True for unbound (no agent_id) — input always allowed there.
    const agent_enabled = conv.agent_id ? isAgentEnabled(ctx.userId, conv.agent_id) : true;
    const runtime = await groupChat.runtimeStatus(ctx.userId, cid, resolvedProjectId);
    const requestedLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 10)));
    const requestedBefore = Number(before);
    const requestedAroundIndex = Number(around_index);
    const hasAroundIndex = Number.isSafeInteger(requestedAroundIndex) && requestedAroundIndex >= 0;
    const page = hasAroundIndex
      ? await chats.getMessagesPageAtIndex(
        ctx.userId, cid, requestedAroundIndex, requestedLimit, resolvedProjectId)
      : await chats.getMessagesPage(
        ctx.userId,
        cid,
        requestedLimit,
        Number.isSafeInteger(requestedBefore) && requestedBefore >= 0 ? requestedBefore : undefined,
        resolvedProjectId,
      );
    return {
      conversation: { ...conv, ...runtime, agent_enabled },
      history: page.history,
      next_cursor: page.nextCursor,
      ...(hasAroundIndex && 'pageStart' in page && 'historyIndexes' in page ? {
        page_start: page.pageStart,
        history_indexes: page.historyIndexes,
      } : {}),
    };
  },

  // ── Conversation aside: read-only side thread (see features/conversation_aside) ──
  // Never touches the main transcript or the group-chat bus. Business logic
  // stays in the feature; these handlers only validate and delegate.

  'aside.list': async ({ cid, project_id }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return {
      ok: true,
      turns: await conversationAside.listAsideTurns(ctx.userId, cid, project_id ?? null),
    };
  },

  'aside.clear': async ({ cid, project_id }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    await conversationAside.clearAsideTurns(ctx.userId, cid, project_id ?? null);
    return { ok: true };
  },

  'conversations.files.list': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const projectId = await userWorkspace.resolveProjectIdForCid(ctx.userId, cid);
    const workspaceRoot = userWorkspace.getWorkspacePath(ctx.userId, projectId);
    const state = await readGroupChatState(ctx.userId, cid);
    // 导入会话 / 详情页自定义：coding_project_dir（绝对路径，原始 Agent 项目
    // 目录）优先。即使目录已不存在也返回该路径——listWorkspaceFiles 报
    // rootExists:false，renderer 据此显示「已被移动或删除」并引导重新选择。
    // 系统/临时目录（旧版误绑定 $TMPDIR）不作为工作区根（会扫出一堆系统文件）。
    const codingDir = (state.coding_project_dir && path.isAbsolute(state.coding_project_dir))
      ? state.coding_project_dir
      : '';
    let root: string;
    if (codingDir) {
      const { isSystemTmpDir } = await import('../util/path-sandbox');
      root = isSystemTmpDir(codingDir)
        ? (state.workspace_dir ? path.join(workspaceRoot, state.workspace_dir) : workspaceRoot)
        : codingDir;
    } else {
      root = state.workspace_dir
        ? path.join(workspaceRoot, state.workspace_dir)
        : workspaceRoot;
    }
    return await conversationFiles.listWorkspaceFiles(root);
  },

  // 引导「工作区目录已被移动或删除」→ 用户重新选择目录后固化到本会话。
  // 安全边界：必须是本机真实存在的目录（绝对路径 + stat + realpath 规范化，
  // 防符号链接越权）；用户显式选择（explicit:true），之后不再被自动重指。
  'workspace.setCodingProjectDir': async ({ cid, dir }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    if (typeof dir !== 'string' || !dir.trim()) throw new Error('dir required');
    const abs = path.isAbsolute(dir) ? dir : path.resolve(dir);
    let real = '';
    try {
      const st = await (await import('node:fs/promises')).stat(abs);
      if (!st.isDirectory()) throw new Error('not a directory');
      const { canonicalizePath, isSystemTmpDir } = await import('../util/path-sandbox');
      real = canonicalizePath(abs);
      // 拒绝系统/临时目录（选 /tmp 当工作区会扫出一堆系统文件）。
      if (isSystemTmpDir(real)) throw new Error('system/temp directory is not a valid workspace');
    } catch (err) {
      throw new Error(`workspace directory not found: ${(err as Error)?.message || String(err)}`);
    }
    const { setCodingProjectDir } = await import('../features/group_chat/state');
    await setCodingProjectDir(ctx.userId, cid, real, { explicit: true });
    return { ok: true, dir: real };
  },

  'conversations.clone': async (args, ctx) => {
    const { cid } = args;
    if (!safeId(cid)) throw new Error('invalid cid');
    const projectIdHint = conversationProjectHint(args);
    const result = await conversationCopyMerge.cloneConversation(
      ctx.userId,
      cid,
      Object.prototype.hasOwnProperty.call(args, 'project_id') ? { projectIdHint } : {},
    );
    return { conversation: result.newConversation };
  },

  'conversations.merge': async (args, ctx) => {
    const { cids, title } = args;
    if (!Array.isArray(cids) || cids.some((cid) => !safeId(cid))) {
      throw new Error('invalid cids');
    }
    if (new Set(cids).size < 2) {
      throw new Error('at least two source conversations are required');
    }
    if (typeof title !== 'string') throw new Error('invalid title');
    const projectIdHint = conversationProjectHint(args);
    const result = await conversationCopyMerge.mergeConversations(
      ctx.userId,
      cids,
      {
        title,
        ...(Object.prototype.hasOwnProperty.call(args, 'project_id') ? { projectIdHint } : {}),
      },
    );
    return {
      conversation: result.newConversation,
      summary: result.summaryMessage,
      agent_summaries: result.agentSummaries,
    };
  },

  'conversations.create': async ({ title = '', spaceId = '', kind = '' } = {}, ctx) => {
    // Validate the spaceId belongs to this user before persisting it on
    // the conv record. Unknown / invalid spaceIds are dropped silently
    // (the conv lands without space membership) — the renderer should
    // not be able to put a conv into a space the backend doesn't know
    // about, but a stale / since-deleted sid coming from the commander chip
    // shouldn't fail the create either.
    let validSpaceId = '';
    if (spaceId && typeof spaceId === 'string' && safeId(spaceId)) {
      if (await spaces.spaceExists(ctx.userId, spaceId)) validSpaceId = spaceId;
    }
    // 会话 kind 白名单：目前只有 space_builder（空间模式）被允许透传；
    // 其余一律回落 normal，防止渲染层任意指定会话类型。
    const convKind = kind === 'space_builder' ? 'space_builder' : 'normal';
    const conv = await chats.createConversation(ctx.userId, {
      kind: convKind,
      title,
      ...(validSpaceId ? { spaceId: validSpaceId } : {}),
    });
    return { conversation: conv };
  },

  // ── 把已有会话绑定到空间（问题 A：只有新建时能绑，这里补「移入/移出」）──
  // spaceId 合法且属于该用户 → 绑定；空/缺失 → 解绑（移出空间回到普通列表）。
  'conversations.setSpace': async (args, ctx) => {
    const { cid, spaceId } = args;
    if (!safeId(cid)) throw new Error('invalid cid');
    let validSpaceId: string | null = null;
    if (spaceId && typeof spaceId === 'string' && safeId(spaceId)) {
      if (!await spaces.spaceExists(ctx.userId, spaceId)) throw new Error('invalid spaceId');
      validSpaceId = spaceId;
    }
    const conv = await chats.setConversationSpace(
      ctx.userId, cid, validSpaceId, conversationProjectHint(args));
    if (!conv) throw new Error('conversation not found');
    return { conversation: conv };
  },

  // ── 空间任务引用（任务级：产物 → references / 资产 → 上下文块）──────────
  'conversations.taskRefs.list': async ({ cid } = {}, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const conv = await chats.getConversation(ctx.userId, cid);
    return { references: conv?.task_references || [] };
  },

  'conversations.taskRefs.add': async ({ cid, reference } = {}, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    if (!reference || typeof reference !== 'object') throw new Error('invalid reference');
    if (reference.kind !== 'artifact' && reference.kind !== 'asset') throw new Error('invalid reference kind');
    if (typeof reference.name !== 'string' || !reference.name) throw new Error('invalid reference name');
    const conv = await chats.getConversation(ctx.userId, cid);
    if (!conv) throw new Error('conversation not found');
    const refs = [...(conv.task_references || [])];
    if (refs.length >= 20) throw new Error('too many references');
    const item = {
      kind: reference.kind,
      name: String(reference.name).slice(0, 200),
      ...(typeof reference.source_cid === 'string' && reference.source_cid ? { source_cid: reference.source_cid } : {}),
      ...(typeof reference.source_title === 'string' && reference.source_title ? { source_title: String(reference.source_title).slice(0, 200) } : {}),
      ...(typeof reference.source_msg_id === 'string' && reference.source_msg_id ? { source_msg_id: reference.source_msg_id } : {}),
      ...(typeof reference.source_ts === 'string' && reference.source_ts ? { source_ts: reference.source_ts } : {}),
      ...(typeof reference.file_name === 'string' && reference.file_name ? { file_name: String(reference.file_name).slice(0, 200) } : {}),
      ...(typeof reference.asset_id === 'string' && reference.asset_id ? { asset_id: reference.asset_id } : {}),
      ...(typeof reference.asset_type === 'string' && reference.asset_type ? { asset_type: String(reference.asset_type).slice(0, 60) } : {}),
      ...(typeof reference.summary === 'string' && reference.summary ? { summary: String(reference.summary).slice(0, 400) } : {}),
    };
    const key = item.kind === 'asset'
      ? `asset:${item.asset_id || ''}`
      : `artifact:${item.source_cid || ''}:${item.file_name || ''}`;
    const dup = refs.some((r) => (r.kind === 'asset' ? `asset:${r.asset_id || ''}` : `artifact:${r.source_cid || ''}:${r.file_name || ''}`) === key);
    if (!dup) refs.push(item);
    await chats.updateConversation(ctx.userId, cid, { task_references: refs });
    return { references: refs };
  },

  'conversations.taskRefs.remove': async ({ cid, index } = {}, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const conv = await chats.getConversation(ctx.userId, cid);
    if (!conv) throw new Error('conversation not found');
    const refs = [...(conv.task_references || [])];
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= refs.length) throw new Error('invalid index');
    refs.splice(i, 1);
    await chats.updateConversation(ctx.userId, cid, { task_references: refs.length ? refs : undefined });
    return { references: refs };
  },

  'conversations.delete': async (args, ctx) => {
    const { cid } = args;
    if (!safeId(cid)) throw new Error('invalid cid');
    const conversation = await chats.getConversation(ctx.userId, cid, conversationProjectHint(args));
    if (!conversation) return { deleted: false };
    await recycleBin.createAppRecycleBatchForConversation(ctx.userId, cid);
    const ok = await chats.deleteConversation(ctx.userId, cid, conversationProjectHint(args));
    if (ok) {
      // The conversation no longer exists by this point, so persist its
      // durable source reference directly. Do not revoke assets here: source
      // removal must remain an explicit user choice.
      await recordDeletedConversationSource(ctx.userId, conversation);
    }
    return { deleted: ok };
  },

  'conversations.pin': async (args, ctx) => {
    const { cid, pinned } = args;
    if (!safeId(cid)) throw new Error('invalid cid');
    const conv = await chats.setConversationPinned(
      ctx.userId, cid, !!pinned, conversationProjectHint(args));
    if (!conv) throw new Error('conversation not found');
    return { conversation: conv };
  },

  'conversations.rename': async (args, ctx) => {
    const { cid, title } = args;
    if (!safeId(cid)) throw new Error('invalid cid');
    const conv = await chats.renameConversation(
      ctx.userId, cid, title, conversationProjectHint(args));
    if (!conv) throw new Error('conversation not found');
    return { conversation: conv };
  },

  'conversations.completeSpaceBuilder': async (args, ctx) => {
    const { cid } = args;
    if (!safeId(cid)) throw new Error('invalid cid');
    // 只允许标记 kind=space_builder 的会话；其余拒绝，防止任意会话被误标。
    const conv = await chats.getConversation(ctx.userId, cid, conversationProjectHint(args));
    if (!conv || conv.kind !== 'space_builder') throw new Error('not a space_builder conversation');
    const updated = await chats.updateConversation(
      ctx.userId, cid, { space_builder_completed: new Date().toISOString() }, conversationProjectHint(args));
    if (!updated) throw new Error('conversation not found');
    return { conversation: updated };
  },

  'conversations.deleteAll': async (_args, ctx) => {
    const convs = await chats.listConversations(ctx.userId);
    await recycleBin.createAppRecycleBatchForConversations(
      ctx.userId,
      convs.map((c) => c.conversation_id),
    );
    const deleted = await chats.deleteAllConversations(ctx.userId);
    // `deleteAllConversations` intentionally returns only a count. Re-check
    // each pre-delete row so a partial failure cannot create a tombstone for a
    // conversation that is still available.
    await Promise.all(convs.map(async (conversation) => {
      const remaining = await chats.getConversation(ctx.userId, conversation.conversation_id, conversation.project_id || null);
      if (!remaining) await recordDeletedConversationSource(ctx.userId, conversation);
    }));
    return { deleted };
  },

  'spaces.list': async (_payload, ctx) => {
    return { spaces: await spaces.listSpaces(ctx.userId) };
  },

  // Reference-only catalog for the workspace picker. Runtime skill loading has
  // its own trust gate; this route must not block first paint on deep rescans.
  'spaces.resources.catalog': async () => {
    const [skillRows, agentRows] = await Promise.all([
      skills.listSkillCatalog(),
      agents.listAgents(),
    ]);

    // 引导未完成时，过滤掉所有 CLI Agent
    let filteredAgents = agentRows;
    if (!onboardingState.getOnboardingCompleted()) {
      filteredAgents = agentRows.filter((agent) => {
        const runtime = agent && agent.runtime;
        if (runtime && (runtime.kind === 'cli' || runtime.kind === 'p3394-gateway')) {
          return false;
        }
        return true;
      });
    }

    return { skills: skillRows, agents: filteredAgents };
  },

  'spaces.create': async ({ name, system_name_key, template_id, primary_template_id, secondary_template_ids, icon, space_type, sustained_outcome, instructions, base_agent, base_agents, main_skill_ref } = {}, ctx) => {
    const result = await spaces.createSpace(ctx.userId, { name, system_name_key, template_id, primary_template_id, secondary_template_ids, icon, space_type, sustained_outcome, instructions, base_agent, base_agents, main_skill_ref });
    if (!result.ok) throw new Error((result as { error: string }).error);
    return { space: result.space };
  },

  'spaces.createFromDraft': async ({ draft } = {}, ctx) => {
    if (!draft || typeof draft !== 'object') throw new Error('invalid draft');
    const result = await spaces.createSpaceFromDraft(ctx.userId, draft);
    if (!result.ok) {
      const err = result as { error: string; details?: string[] };
      throw new Error(err.details && err.details.length ? `invalid_draft: ${err.details.join('；')}` : err.error);
    }
    // corrections：资源引用（模板/技能/智能体）自动纠正/忽略说明（LLM 幻觉 id 的后端兜底）
    return { space: result.space, ...(result.corrections && result.corrections.length ? { corrections: result.corrections } : {}) };
  },

  'spaces.get': async ({ spaceId }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    const space = await spaces.getSpace(ctx.userId, spaceId);
    if (!space) throw new Error('not_found');
    return { space };
  },

  'spaces.update': async (args, ctx) => {
    // 全字段透传：后端 updateSpace 支持 name/icon/template_id/primary_template_id/
    // secondary_template_ids/space_type/sustained_outcome/instructions/base_agent/
    // base_agents/main_skill_ref/gate_status/pinned_at。除 name/icon/template_id
    // 外均按「调用方是否显式传入」转发（undefined 视为不改），避免静默丢字段——
    // 旧版只收 name/icon/template_id，导致空间目标（sustained_outcome）等更新被丢弃。
    const {
      spaceId, name, icon, template_id, primary_template_id, secondary_template_ids,
      space_type, sustained_outcome, instructions, base_agent, base_agents,
      main_skill_ref, gate_status,
    } = args || {};
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    const result = await spaces.updateSpace(ctx.userId, spaceId, {
      name, icon, template_id,
      ...(Object.prototype.hasOwnProperty.call(args || {}, 'primary_template_id') ? { primary_template_id } : {}),
      ...(Object.prototype.hasOwnProperty.call(args || {}, 'secondary_template_ids') ? { secondary_template_ids } : {}),
      ...(Object.prototype.hasOwnProperty.call(args || {}, 'space_type') ? { space_type } : {}),
      ...(Object.prototype.hasOwnProperty.call(args || {}, 'sustained_outcome') ? { sustained_outcome } : {}),
      ...(Object.prototype.hasOwnProperty.call(args || {}, 'instructions') ? { instructions } : {}),
      ...(Object.prototype.hasOwnProperty.call(args || {}, 'base_agent') ? { base_agent } : {}),
      ...(Object.prototype.hasOwnProperty.call(args || {}, 'base_agents') ? { base_agents } : {}),
      ...(Object.prototype.hasOwnProperty.call(args || {}, 'main_skill_ref') ? { main_skill_ref } : {}),
      ...(Object.prototype.hasOwnProperty.call(args || {}, 'gate_status') ? { gate_status } : {}),
      ...(Object.prototype.hasOwnProperty.call(args || {}, 'pinned_at') ? { pinned_at: args.pinned_at } : {}),
    });
    if (!result.ok) throw new Error((result as { error: string }).error);
    return { space: result.space };
  },

  'spaces.delete': async ({ spaceId }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    const result = await spaces.deleteSpace(ctx.userId, spaceId);
    if (!result.ok) throw new Error((result as { error: string }).error);
    return { ok: true };
  },

  // 在系统文件管理器中打开空间文件夹（macOS 访达 / Windows 资源管理器）。
  // 路径由主进程从 spaceId 解析，渲染端不提供任意路径。
  'spaces.openInFinder': async ({ spaceId }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    const { spaceContentDir } = await import('../paths');
    const target = spaceContentDir(ctx.userId, spaceId);
    try {
      const st = fs.statSync(target);
      if (!st.isDirectory()) throw new Error('not_a_directory');
    } catch {
      // 空间目录未创建（无产物/附件）→ 打开其父级，仍能定位到空间文件夹
      const parent = path.dirname(target);
      const openErr = await shell.openPath(parent);
      if (openErr) throw new Error(openErr);
      return { ok: true, path: parent };
    }
    const openErr = await shell.openPath(target);
    if (openErr) throw new Error(openErr);
    return { ok: true, path: target };
  },

  'spaces.resources.add': async ({ spaceId, kind, id } = {}, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (kind !== 'skill' && kind !== 'agent') throw new Error('invalid kind');
    if (typeof id !== 'string' || !id) throw new Error('invalid id');
    const result = await spaces.addSpaceResource(ctx.userId, spaceId, kind, id);
    if (!result.ok) throw new Error((result as { error: string }).error);
    return result.resources;
  },

  'spaces.resources.remove': async ({ spaceId, kind, id } = {}, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (kind !== 'skill' && kind !== 'agent') throw new Error('invalid kind');
    if (typeof id !== 'string' || !id) throw new Error('invalid id');
    const result = await spaces.removeSpaceResource(ctx.userId, spaceId, kind, id);
    if (!result.ok) throw new Error((result as { error: string }).error);
    return result.resources;
  },

  'spaces.resources.pruneInvalid': async ({ spaceId } = {}, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    const [sAgents, sSkills] = await Promise.all([
      agents.listAgents().catch(() => []),
      skills.listSkillCatalog().catch(() => []),
    ]);

    // 引导未完成时，过滤掉所有 CLI Agent
    let filteredAgents = sAgents;
    if (!onboardingState.getOnboardingCompleted()) {
      filteredAgents = sAgents.filter((agent) => {
        const runtime = agent && agent.runtime;
        if (runtime && (runtime.kind === 'cli' || runtime.kind === 'p3394-gateway')) {
          return false;
        }
        return true;
      });
    }

    const result = await spaces.pruneInvalidSpaceResources(ctx.userId, spaceId, {
      skills: new Set(sSkills.map((s) => s.id)),
      agents: new Set(filteredAgents.map((a) => a.agent_id)),
    });
    if (!result.ok) throw new Error((result as { error: string }).error);
    return { removed: result.removed };
  },

  // 模板目录：唯一正式出口在 Personal Ontology。返回 RoleTemplateSummary
  // （templateId/name/description/version/installed/bundle），**不含**
  // preset_groups / sections / 字段值 / group_id —— 见 personal_ontology_contract.ts。
  'personalOntology.templates.catalog': async (_payload, ctx) => {
    const contract = await import('../features/personal_ontology_contract');
    return { templates: await contract.listRoleTemplateSummaries(ctx.userId) };
  },

  // 情境入口场景列表（教育/写作/职场+自定义）。场景归属未裁决，先统一从 contract 出。
  'personalOntology.scenarios.list': async (_payload, _ctx) => {
    const contract = await import('../features/personal_ontology_contract');
    return { scenarios: contract.listRoleScenarios() };
  },

  // ── 空间三 tab 数据源（空间化重构阶段 1）──────────────────────────────
  'spaces.conversations.list': async ({ spaceId } = {}, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    return { conversations: await chats.listSpaceConversations(ctx.userId, spaceId) };
  },

  'spaces.artifacts.list': async ({ spaceId } = {}, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    return { artifacts: await spacesArtifacts.listSpaceArtifacts(ctx.userId, spaceId) };
  },

  // 删除空间产物（产物页「更多」→ 删除产物）。破坏性操作由渲染层二次确认；
  // 这里以空间产物列表为准重新解析目标（path 或 artifactId 精确命中），拒绝
  // 任意外部路径。web artifact 删除整个产物目录，文件产物删除文件本身
  // （macOS 走废纸篓，其余平台回退 rm）。删除后失效产物缓存与文件索引。
  'spaces.artifacts.delete': async ({ spaceId, path: targetPath, artifactId, cid } = {}, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (typeof targetPath !== 'string' || !targetPath) throw new Error('missing path');
    const wanted = path.resolve(targetPath);
    const entries = await spacesArtifacts.listSpaceArtifacts(ctx.userId, spaceId);
    const target = entries.find((e) => (
      (e.path && path.resolve(e.path) === wanted)
      || (typeof artifactId === 'string' && artifactId && e.artifactId === artifactId)
    ));
    if (!target || !target.path) throw new Error('artifact not found in space');
    // web artifact → 删除整个产物目录；文件 → 删除文件本身
    let victim = path.resolve(target.path);
    if (target.type === 'artifact') victim = path.dirname(victim);
    let st: fs.Stats;
    try { st = fs.statSync(victim); }
    catch { return { ok: false, error: 'not_found' }; }
    try {
      if (typeof shell.trashItem === 'function') await shell.trashItem(victim);
      else if (st.isDirectory()) fs.rmSync(victim, { recursive: true, force: true });
      else fs.unlinkSync(victim);
    } catch (err) {
      try {
        if (st.isDirectory()) fs.rmSync(victim, { recursive: true, force: true });
        else fs.unlinkSync(victim);
      }
      catch {
        return { ok: false, error: String((err as Error).message || 'delete failed') };
      }
    }
    spacesArtifacts.invalidateSpaceArtifacts(spaceId);
    try {
      const fileIndexer = require('../features/file_indexer') as { invalidateFileCache?: (userId: string, absPath: string) => void };
      fileIndexer.invalidateFileCache?.(ctx.userId, victim);
    } catch { /* cache invalidation is best-effort */ }
    void cid;
    return { ok: true, path: victim };
  },

  // COGSEED-18：新建空间时本地文件夹整体导入（复制进空间内容目录 imports/，保留目录结构）。
  // 进度经 broadcastToRenderer 推送 'workspace-import:progress'（preload PUSH_EVENT_PREFIXES 白名单内）。
  'workspace.importFolder': async ({ spaceId, sourceDir } = {}, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (typeof sourceDir !== 'string' || !path.isAbsolute(sourceDir)) throw new Error('invalid sourceDir');
    return spaceImport.importFolderIntoSpace(ctx.userId, spaceId, sourceDir, (p) => {
      broadcastToRenderer('workspace-import:progress', p);
    });
  },

  // ── 空间作用域（@ 选择器按空间能力过滤：agents ∪ skills = 模板 bundle ∪ extra）──
  // 语义与 runner 一致（S1）：空间缺失/空配置/全失效 → scope=null（全局可见不过滤）。
  'spaces.scope.resolve': async ({ spaceId } = {}, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (!await spaces.spaceExists(ctx.userId, spaceId)) throw new Error('invalid spaceId');
    const scope = await spaces.resolveSpaceScope(ctx.userId, spaceId);
    return { scope }; // null = 全局；否则 { skills: string[]; agents: string[] }
  },

  // ── 项目 ↔ 空间绑定（工作空间一期）──────────────────────────────────────
  'spaces.instructions.get': async ({ spaceId }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    const result = await spaces.readSpaceInstructions(ctx.userId, spaceId);
    if (!result.ok) throw new Error((result as { error: string }).error);
    return { content: result.content, limit: result.limit };
  },

  'spaces.instructions.set': async ({ spaceId, content }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (typeof content !== 'string') throw new Error('invalid content');
    const result = await spaces.writeSpaceInstructions(ctx.userId, spaceId, content);
    if (!result.ok) throw new Error((result as { error: string }).error);
    return { ok: true };
  },

  'spaces.files.list': async ({ spaceId }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (!await spaces.spaceExists(ctx.userId, spaceId)) throw new Error('not_found');
    return { files: await spaceFiles.listSpaceFiles(ctx.userId, spaceId) };
  },

  'spaces.files.tree': async ({ spaceId }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (!await spaces.spaceExists(ctx.userId, spaceId)) throw new Error('not_found');
    return { tree: await spaceFiles.listSpaceFileTree(ctx.userId, spaceId) };
  },

  'spaces.files.mkdir': async ({ spaceId, path: relPath }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (typeof relPath !== 'string' || !relPath) throw new Error('invalid path');
    return spaceFiles.createSpaceDir(ctx.userId, spaceId, relPath);
  },

  'spaces.files.upload': async ({ spaceId, name, data }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (typeof data !== 'string') throw new Error('missing data');
    if (data.length > 12 * 1024 * 1024) {
      return { ok: false, error: 'large uploads require path-based import', code: 'E_IMPORT_PATH_REQUIRED' };
    }
    const buf = Buffer.from(data, 'base64');
    return spaceFiles.uploadSpaceFile(ctx.userId, spaceId, name || '', buf);
  },

  'spaces.files.pickAndUpload': async ({ spaceId, targetDir } = {}, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (!await spaces.spaceExists(ctx.userId, spaceId)) throw new Error('not_found');
    const picked = await _pickLocalFiles('Choose files', PROJECT_PICK_EXTENSIONS, true);
    const results = [];
    for (const filePath of picked) {
      const name = path.basename(filePath);
      try {
        const targetName = _targetInDir(targetDir, name);
        const res = await spaceFiles.importSpaceFileFromPath(ctx.userId, spaceId, targetName, filePath);
        results.push({ name, targetName, ...res });
      } catch (err) {
        results.push({ ok: false, name, error: (err as Error)?.message || String(err) });
      }
    }
    return { ok: true, files: results };
  },

  'spaces.files.createText': async ({ spaceId, name }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    return spaceFiles.createSpaceTextFile(ctx.userId, spaceId, name);
  },

  'spaces.files.readText': async ({ spaceId, name }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    return spaceFiles.readSpaceTextFile(ctx.userId, spaceId, name);
  },

  'spaces.files.updateText': async ({ spaceId, name, content }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    if (typeof content !== 'string') throw new Error('missing content');
    return spaceFiles.updateSpaceTextFile(ctx.userId, spaceId, name, content);
  },

  'spaces.files.rename': async ({ spaceId, oldName, name }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (typeof oldName !== 'string' || !oldName) throw new Error('invalid oldName');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    return spaceFiles.renameSpaceFile(ctx.userId, spaceId, oldName, name);
  },

  'spaces.files.delete': async ({ spaceId, name }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    await recycleBin.createAppRecycleBatchForCloudEntry(
      ctx.userId,
      `cloud/spaces/${spaceId}/contexts/${name}`,
      'space_file',
    );
    return spaceFiles.deleteSpaceEntry(ctx.userId, spaceId, name);
  },

  'library.transfer': async (payload, ctx) => {
    return libraryTransfer.transferLibraryEntries(ctx.userId, payload);
  },

  'spaces.files.absPath': async ({ spaceId, name }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    const r = await spaceFiles.resolveSpaceFileAbsPath(ctx.userId, spaceId, name);
    if (!r.ok) return { ok: false, error: (r as { error?: string }).error || 'failed' };
    return { ok: true, path: r.absPath, kind: r.kind };
  },

  'spaces.files.image': async ({ spaceId, name }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    return spaceFiles.readSpaceImage(ctx.userId, spaceId, name);
  },

  'spaces.files.docxHtml': async ({ spaceId, name }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    return spaceFiles.readSpaceDocxHtml(ctx.userId, spaceId, name);
  },

  'spaces.files.status': async ({ spaceId, skipReconcile }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (!await spaces.spaceExists(ctx.userId, spaceId)) throw new Error('not_found');
    // 快照先行：状态/文件列表直接读向量库（毫秒级），全量磁盘 reconcile
    // 放后台补跑（in-flight 合并），不阻塞页签打开。状态变化经
    // space.kb.events 实时推送，reconcile 结果并非首屏依赖。
    if (!skipReconcile) {
      void spaceLibraryIndexer.reconcile(ctx.userId, spaceId).catch((err) => {
        log.warn('background space library reconcile failed', {
          space_id: spaceId,
          error: (err as Error)?.message || String(err),
        });
      });
    }
    const summary = spaceLibraryIndexer.statusSummary(ctx.userId, spaceId);
    const files = spaceLibraryIndexer.listFiles(ctx.userId, spaceId).map((r) => ({
      name: r.rel_path,
      path: r.rel_path,
      kind: r.kind,
      status: r.status,
      chunks: r.chunks,
      bytes: r.bytes,
      mtime: r.mtime,
      error: r.error || undefined,
    }));
    return { summary, files, reconcile: null };
  },

  'spaces.files.reconcile': async ({ spaceId }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (!await spaces.spaceExists(ctx.userId, spaceId)) throw new Error('not_found');
    const result = await spaceLibraryIndexer.reconcile(ctx.userId, spaceId);
    return { result };
  },

  'spaces.files.reprocess': async ({ spaceId, name }, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    if (!await spaces.spaceExists(ctx.userId, spaceId)) throw new Error('not_found');
    spaceLibraryIndexer.enqueue(ctx.userId, spaceId, name, 'upsert', { force: true });
    return { ok: true, name };
  },

  // ── Project bindings (the strict scope of agents/skills visible inside
  // a project conversation; see CLAUDE.md §6 outer-intersection rule) ──
  // `bindings.list` returns the bound ids JOINED with name/description so
  // the renderer can paint the detail page in one round-trip. Unknown ids
  // (referent deleted) are pruned here so stale bindings never become user
  // cleanup work.
  'autoTasks.list': async ({ projectId } = {}, ctx) => {
    const opts: { projectId?: string | null } = {};
    if (projectId === null) opts.projectId = null;
    else if (typeof projectId === 'string' && projectId) opts.projectId = projectId;
    const tasks = await autoTasks.listTasks(ctx.userId, opts);
    return { tasks };
  },

  'autoTasks.create': async ({ id, content, message_parts, schedule, title, enabled, recipient, skill, connector, project_id, attachments }, ctx) => {
    const result = await autoTasks.createTask(ctx.userId, {
      ...(typeof id === 'string' && id ? { id } : {}),
      content: typeof content === 'string' ? content : '',
      message_parts: Array.isArray(message_parts) ? message_parts : undefined,
      schedule,
      title: typeof title === 'string' ? title : undefined,
      enabled: enabled !== false,
      recipient: recipient && typeof recipient === 'object' ? recipient : undefined,
      skill: skill && typeof skill === 'object' ? skill : undefined,
      connector: connector && typeof connector === 'object' ? connector : undefined,
      project_id: typeof project_id === 'string' ? project_id : undefined,
      attachments: Array.isArray(attachments) ? attachments.filter((n: any) => typeof n === 'string' && n) : undefined,
    });
    if (!result.ok) throw new Error((result as { error: string }).error);
    return { task: result.task };
  },

  'autoTasks.allocateDraftId': async () => {
    return { id: autoTasks.allocateDraftTaskId() };
  },

  // Current device fingerprint — { id: <MAC>, name: <hostname> }. Renderer
  // uses this to decide which task rows are "本机" (matches MAC) vs. show
  // the device_name from the task as-is (other devices).
  'autoTasks.currentDevice': async () => {
    const d = autoTasks.getCurrentDevice();
    return { device: { id: d.id, name: d.name } };
  },

  'autoTasks.attachments.list': async ({ taskId } = {}, ctx) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('invalid taskId');
    return { items: await autoTasks.listAttachments(ctx.userId, taskId) };
  },

  'autoTasks.attachments.upload': async ({ taskId, name, dataBase64 }, ctx) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('invalid taskId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    if (typeof dataBase64 !== 'string') throw new Error('invalid data');
    const buf = Buffer.from(dataBase64, 'base64');
    const res = await autoTasks.uploadAttachment(ctx.userId, taskId, name, buf);
    if (!res.ok) throw new Error((res as { error: string }).error);
    return { name: res.name };
  },

  'autoTasks.attachments.attachContext': async ({ taskId, relPath } = {}, ctx) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('invalid taskId');
    if (typeof relPath !== 'string' || !relPath.trim()) throw new Error('missing relPath');
    const absPath = contexts.resolveContextFileAbsPath(relPath);
    const st = fs.statSync(absPath);
    if (!st.isFile()) throw new Error('not_a_file');
    const res = await autoTasks.uploadAttachment(
      ctx.userId,
      taskId,
      path.basename(absPath),
      fs.readFileSync(absPath),
    );
    if (!res.ok) throw new Error((res as { error: string }).error);
    return { name: res.name };
  },

  'autoTasks.attachments.attachProjectFile': async ({ taskId, projectId, name } = {}, ctx) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('invalid taskId');
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (typeof name !== 'string' || !name.trim()) throw new Error('missing name');
    const resolved = await spaceFiles.resolveSpaceFileAbsPath(ctx.userId, projectId, name);
    if (!resolved.ok) throw new Error((resolved as { error?: string }).error || 'not_found');
    const st = fs.statSync(resolved.absPath);
    if (!st.isFile()) throw new Error('not_a_file');
    const res = await autoTasks.uploadAttachment(
      ctx.userId,
      taskId,
      path.basename(resolved.absPath),
      fs.readFileSync(resolved.absPath),
    );
    if (!res.ok) throw new Error((res as { error: string }).error);
    return { name: res.name };
  },

  'autoTasks.attachments.import': async (payload = {}, ctx) => {
    const taskId = (payload as any)?.taskId;
    const sourcePath = (payload as any)?.path;
    if (typeof taskId !== 'string' || !taskId) throw new Error('invalid taskId');
    if (typeof sourcePath !== 'string' || !sourcePath) throw new Error('missing path');

    const norm = path.resolve(sourcePath);
    const allowedRoots = await _ipcFileSandboxAllowedRoots(ctx.userId, payload);
    if (!isPathAllowed(norm, allowedRoots)) {
      throw new Error('path is outside the user workspace');
    }

    let st: fs.Stats;
    try { st = fs.statSync(norm); }
    catch { throw new Error('file not found'); }
    if (!st.isFile()) throw new Error('file not found');

    const displayName = typeof (payload as any)?.name === 'string' && (payload as any).name.trim()
      ? (payload as any).name.trim()
      : path.basename(norm);
    const ext = path.extname(displayName).replace(/^\./, '').toLowerCase();
    if (!CHAT_PICK_EXTENSIONS.includes(ext)) throw new Error('unsupported_format');

    const res = await autoTasks.uploadAttachment(
      ctx.userId,
      taskId,
      path.basename(displayName),
      fs.readFileSync(norm),
    );
    if (!res.ok) throw new Error((res as { error: string }).error);
    return { name: res.name };
  },

  'autoTasks.attachments.pickAndUpload': async ({ taskId } = {}, ctx) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('invalid taskId');
    const picked = await _pickLocalFiles('Choose files', CHAT_PICK_EXTENSIONS, true);
    const items: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const filePath of picked) {
      const name = path.basename(filePath);
      try {
        const buf = fs.readFileSync(filePath);
        const res = await autoTasks.uploadAttachment(ctx.userId, taskId, name, buf);
        if (res.ok) items.push(res.name);
        else failed.push({ name, error: (res as any).error });
      } catch (err) {
        failed.push({ name, error: (err as Error)?.message || String(err) });
      }
    }
    return { items, failed };
  },

  'autoTasks.attachments.delete': async ({ taskId, name }, ctx) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('invalid taskId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    await recycleBin.createAppRecycleBatchForCloudEntry(
      ctx.userId,
      `${(findAutoTaskLocation(ctx.userId, taskId) || globalAutoTaskLocation(ctx.userId, taskId)).attachmentsRelBase}/${name}`,
      'attachment',
    );
    const res = await autoTasks.deleteAttachment(ctx.userId, taskId, name);
    return { deleted: res.ok };
  },

  'autoTasks.update': async ({ taskId, updates }, ctx) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('invalid taskId');
    if (!updates || typeof updates !== 'object') throw new Error('invalid updates');
    const result = await autoTasks.updateTask(ctx.userId, taskId, updates as any);
    if (!result.ok) throw new Error((result as { error: string }).error);
    return { task: result.task };
  },

  'autoTasks.delete': async ({ taskId }, ctx) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('invalid taskId');
    await recycleBin.createAppRecycleBatchForAutoTask(ctx.userId, taskId);
    const res = await autoTasks.deleteTask(ctx.userId, taskId);
    return { deleted: res.ok };
  },

  'autoTasks.setEnabled': async ({ taskId, enabled }, ctx) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('invalid taskId');
    const result = await autoTasks.setTaskEnabled(ctx.userId, taskId, !!enabled);
    if (!result.ok) throw new Error((result as { error: string }).error);
    return { task: result.task };
  },

  // ── Group chat (replaces legacy conversations.send / .stream / .markFormSubmitted) ──
  // 任务级引用合并（@ 产物/资产 → task_references）已下沉到 groupChat.send() 核心——
  // conversations.sendStream（标准 composer 实际走的流式路径）与 groupChat.send 都汇聚
  // 到那里，引用才能随消息发出。这里只做参数透传。
  'groupChat.send': async ({ cid, content, attachments, use_selections, references, recipient_agent_id, recipient_origin }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const text = (content || '').trim();
    if (!text) throw new Error('empty message');
    const atts = Array.isArray(attachments) ? attachments.filter((n: any) => typeof n === 'string') : [];
    const useSelections = Array.isArray(use_selections) ? use_selections : [];
    const refs = Array.isArray(references) ? references : [];
    if ((recipient_agent_id !== undefined || recipient_origin !== undefined)
      && (typeof recipient_agent_id !== 'string' || !safeId(recipient_agent_id)
        || (recipient_origin !== 'user_selection' && recipient_origin !== 'cli_fallback'))) {
      throw new Error('invalid recipient route');
    }
    return groupChat.send({
      userId: ctx.userId, cid, text,
      ...(atts.length ? { attachments: atts } : {}),
      ...(useSelections.length ? { use_selections: useSelections } : {}),
      ...(refs.length ? { references: refs } : {}),
      ...(recipient_agent_id ? { recipient_agent_id, recipient_origin } : {}),
    });
  },

  'companionRepro.getState': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return { ok: true, state: await companionRepro.readCompanionReproStateOrCreate(ctx.userId, cid) };
  },

  'companionRepro.saveDraft': async (payload, ctx) => {
    const cid = payload?.cid;
    if (!safeId(cid)) throw new Error('invalid cid');
    const draft = payload?.draft || {};
    const workspacePath = typeof draft.workspace_path === 'string' ? path.resolve(draft.workspace_path) : '';
    if (!workspacePath) throw new Error('missing workspace path');
    if (!isPathAllowed(workspacePath, await _ipcFileSandboxAllowedRoots(ctx.userId, payload))) {
      throw new Error('path is outside the user workspace');
    }
    const state = await companionRepro.saveDraft(ctx.userId, cid, {
      paper_title: typeof draft.paper_title === 'string' ? draft.paper_title.trim() : undefined,
      paper_selection: String(draft.paper_selection || '').trim(),
      repo_url: String(draft.repo_url || '').trim(),
      commit: String(draft.commit || '').trim(),
      workspace_path: workspacePath,
      user_intent: String(draft.user_intent || '').trim(),
    });
    return { ok: true, state };
  },

  'companionRepro.submitGuideMessage': async ({ cid, text }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return { ok: true, state: await companionRepro.submitGuideMessage(ctx.userId, cid, String(text || '')) };
  },

  'companionRepro.generateProjectContext': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return { ok: true, project_context: await companionRepro.generateProjectContext(ctx.userId, cid) };
  },

  'companionRepro.applyProjectContextRevision': async ({ cid, before, after, reason }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return { ok: true, project_context: await companionRepro.applyProjectContextRevision(ctx.userId, cid, {
      before: String(before || '').trim(),
      after: String(after || '').trim(),
      reason: String(reason || '').trim(),
    }) };
  },

  'companionRepro.generateTaskContract': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return { ok: true, task_contract: await companionRepro.generateTaskContract(ctx.userId, cid) };
  },

  'companionRepro.confirmTaskContract': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return { ok: true, task_contract: await companionRepro.confirmTaskContract(ctx.userId, cid, ctx.userId) };
  },

  'companionRepro.startExecution': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const result = await companionRepro.startExecution(ctx.userId, cid, {
      send: async ({ text }) => {
        const sent = await groupChat.send({ userId: ctx.userId, cid, text });
        return sent?.ok ? { ok: true } : { ok: false, error: String((sent as any)?.error || 'send_failed') };
      },
    });
    if (result.ok) return { ok: true, execution: result.execution };
    return { ok: false, error: 'error' in result ? result.error : 'start_failed' };
  },

  'companionRepro.readEvidence': async ({ cid, limit }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return { ok: true, events: await companionRepro.readEvidence(ctx.userId, cid, Number(limit) || 50) };
  },

  'p3394.validation.scan': async ({ skillId, target }, ctx) => {
    if (!safeId(skillId)) throw new Error('invalid skill id');
    if (target !== 'installed-skill') throw new Error('unsupported validation target');
    const skillDir = userMarketplaceSkillDir(ctx.userId, skillId);
    return { ok: true, validation: await p3394.runSkillValidation(ctx.userId, {
      skillId, target, skillDir, allowedRoots: [skillDir], boundary: 'static',
    }) };
  },

  'p3394.validation.read': async ({ validationId }, ctx) => {
    if (!safeId(validationId)) throw new Error('invalid validation id');
    return { ok: true, validation: await p3394.readSkillValidation(ctx.userId, validationId) };
  },

  'p3394.execution.list': async (_args, ctx) => {
    return { ok: true, executions: await executionRecords.list(ctx.userId) };
  },

  'p3394.execution.read': async ({ executionId }, ctx) => {
    if (!safeId(executionId)) throw new Error('invalid execution id');
    return { ok: true, execution: await executionRecords.read(ctx.userId, executionId) };
  },

  'p3394.contextReuseReceipt.read': async ({ executionId }, ctx) => {
    if (!safeId(executionId)) throw new Error('invalid execution id');
    return { ok: true, receipt: await p3394.readReceipt(ctx.userId, executionId) };
  },

  // P3394 Bridge inbound port (Phase 3). The renderer may initiate an
  // operation, but the sender identity is always rewritten to the local
  // agent by P3394IpcChannel.handleInbound — a renderer can never declare an
  // Agent identity or capability.
  'p3394.bridge.inbound': async (args, _ctx) => {
    if (!args || typeof args !== 'object' || !('envelope' in args)) {
      return { ok: false, error: 'invalid bridge inbound request' };
    }
    const result = p3394BridgeIpcPort.handleInbound((args as { envelope: unknown }).envelope);
    if (result.ok === false) {
      return { ok: false, error: result.error.message };
    }
    return { ok: true, accepted: true, channel_id: p3394BridgeIpcPort.channel_id };
  },

  // ── Workbench: complex-delivery Workspace (US-20) ─────────────────────
  // The gate decides whether the renderer may paint the Workspace body at
  // all ("未达Gate不得展示空Workspace"). The skill tree is resolved here from
  // the installed skill roots rather than accepted from the renderer, so a
  // caller cannot point a baseline check at an arbitrary directory.

  'workbench.baseline.freeze': async ({ assetId, version, source, evaluationContractRef }, ctx) => {
    if (!safeId(assetId)) throw new Error('invalid asset id');
    const skillDir = _resolveWorkbenchSkillDir(ctx.userId, assetId);
    if (!skillDir) throw new Error('skill not found');
    return {
      ok: true,
      baseline: await workbench.freezeBaseline(ctx.userId, {
        assetId,
        version: String(version || ''),
        skillDir,
        allowedRoots: [skillDir],
        source,
        ...(evaluationContractRef ? { evaluationContractRef: String(evaluationContractRef) } : {}),
      }),
    };
  },

  'workbench.baseline.list': async (_args, ctx) => {
    return { ok: true, baselines: await workbench.listBaselines(ctx.userId) };
  },

  'workbench.baseline.verify': async ({ baselineId }, ctx) => {
    if (!safeId(baselineId)) throw new Error('invalid baseline id');
    const baseline = await workbench.readBaseline(ctx.userId, baselineId);
    const skillDir = _resolveWorkbenchSkillDir(ctx.userId, baseline.skill_ref.asset_id);
    if (!skillDir) return { ok: true, result: { ok: false, reason: 'unreadable' } };
    return {
      ok: true,
      result: await workbench.verifyBaseline(ctx.userId, baselineId, skillDir, [skillDir]),
    };
  },

  'workbench.gate.evaluate': async ({ baselineId, receiptExecutionId }, ctx) => {
    if (!safeId(baselineId)) throw new Error('invalid baseline id');
    if (!safeId(receiptExecutionId)) throw new Error('invalid execution id');
    const baseline = await workbench.readBaseline(ctx.userId, baselineId);
    const skillDir = _resolveWorkbenchSkillDir(ctx.userId, baseline.skill_ref.asset_id)
      || userMarketplaceSkillDir(ctx.userId, baseline.skill_ref.asset_id);
    return {
      ok: true,
      decision: await workbench.evaluateWorkspaceGate(ctx.userId, {
        baselineId,
        skillDir,
        allowedRoots: [skillDir],
        receiptExecutionId,
      }),
    };
  },

  'p3394.behaviorContrast.start': async ({ contrastId, receiptExecutionId, task, attachmentIds, conversationId, agentId, executionKind }, ctx) => {
    if (contrastId !== undefined && !safeId(contrastId)) throw new Error('invalid contrast id');
    if (!safeId(receiptExecutionId) || !safeId(conversationId)) throw new Error('invalid behavior contrast scope');
    if (agentId !== undefined && !safeId(agentId)) throw new Error('invalid agent id');
    if (!Array.isArray(attachmentIds)) throw new Error('invalid attachment ids');
    const contrast = await p3394.runConfiguredBehaviorContrast(ctx.userId, {
      ...(contrastId ? { contrastId } : {}),
      receiptExecutionId,
      task: boundedText(task, 'task', 100_000),
      attachmentIds,
      conversationId,
      ...(agentId ? { agentId } : {}),
      executionKind,
    });
    return { ok: true, contrast };
  },

  'p3394.behaviorContrast.read': async ({ contrastId }, ctx) => {
    if (!safeId(contrastId)) throw new Error('invalid contrast id');
    return { ok: true, contrast: await p3394.readBehaviorContrast(ctx.userId, contrastId) };
  },

  'p3394.listWakeRequests': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return { ok: true, requests: await p3394.listWakeRequests(ctx.userId, cid) };
  },

  'p3394.decideWakeRequest': async ({ cid, requestId, decision, reason }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    if (!safeId(requestId)) throw new Error('invalid request id');
    if (decision !== 'approve' && decision !== 'reject') throw new Error('invalid decision');
    const request = await p3394.getWakeRequest(ctx.userId, requestId);
    if (!request || request.conversation_id !== cid) throw new Error('wake request not found');
    const kstarProjectionError = await ensureKstarWakeProjectionConfirmed(ctx.userId, cid, requestId, decision, request);
    if (kstarProjectionError) return kstarProjectionError;
    return p3394.decideWakeRequest(ctx.userId, {
      requestId,
      decision,
      ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
    });
  },

  'p3394.listProtocolEvents': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return { ok: true, protocol_events: await p3394.listP3394ProtocolEvents(ctx.userId, cid) };
  },


  // 候选出 IPC 一律带 capability：渲染层不再自己解释 raw status。能力是 DTO
  // 投影，不写回存储（落盘记录仍是纯候选记录）。
  'recall.candidates.list': async (_args, ctx) => ({
    ok: true,
    candidates: await (async () => {
      const all = await recallCandidates.listRecallCandidates(ctx.userId);
      // 冲突是跨候选判断，只有全量读口算得出来。不传的话列表会说"能确认"，
      // 而晋升闸门按同一批数据判冲突并拒绝——又是一次假审批。
      const conflicts = recallCandidates.recallCandidateConflictingTypes(all);
      return all.map((candidate) => withRecallCandidateCapabilities(candidate, conflicts.get(candidate.id)));
    })(),
  }),

  'recall.sources.list': async ({ kinds, conversationId, limit } = {}, ctx) => {
    if (kinds !== undefined && (
      !Array.isArray(kinds)
      || kinds.length > recallSources.COGNITION_CATALOG_KINDS.length
      || kinds.some((kind) => !recallSources.COGNITION_CATALOG_KINDS.includes(kind))
    )) throw new Error('invalid cognition source kinds');
    if (conversationId !== undefined && !safeId(conversationId)) throw new Error('invalid conversation id');
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new Error('invalid source limit');
    return {
      ok: true,
      sources: await recallSources.listCognitionSources(ctx.userId, {
        ...(kinds !== undefined ? { kinds } : {}),
        ...(conversationId !== undefined ? { conversationId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    };
  },

  'recall.sources.pause': async ({ kind, sourceId } = {}, ctx) => {
    if (!recallSources.COGNITION_CATALOG_KINDS.includes(kind) || !safeId(sourceId)) {
      throw new Error('invalid cognition source');
    }
    return { ok: true, control: await recallSources.pauseCognitionSource(ctx.userId, kind, sourceId) };
  },

  'recall.sources.resume': async ({ kind, sourceId } = {}, ctx) => {
    if (!recallSources.COGNITION_CATALOG_KINDS.includes(kind) || !safeId(sourceId)) {
      throw new Error('invalid cognition source');
    }
    return { ok: true, control: await recallSources.resumeCognitionSource(ctx.userId, kind, sourceId) };
  },

  'recall.sources.retry': async ({ kind, sourceId } = {}, ctx) => {
    if (!recallSources.COGNITION_CATALOG_KINDS.includes(kind) || !safeId(sourceId)) {
      throw new Error('invalid cognition source');
    }
    return { ok: true, control: await recallSources.retryCognitionSource(ctx.userId, kind, sourceId) };
  },

  'recall.sources.reconnect': async ({ kind, sourceId } = {}, ctx) => {
    if (!recallSources.COGNITION_CATALOG_KINDS.includes(kind) || !safeId(sourceId)) {
      throw new Error('invalid cognition source');
    }
    return { ok: true, control: await recallSources.reconnectCognitionSource(ctx.userId, kind, sourceId) };
  },

  'recall.sources.removeImpact': async ({ kind, sourceId } = {}, ctx) => {
    if (!recallSources.COGNITION_CATALOG_KINDS.includes(kind) || !safeId(sourceId)) {
      throw new Error('invalid cognition source');
    }
    return { ok: true, impact: await recallSources.previewCognitionSourceRemoval(ctx.userId, kind, sourceId) };
  },

  'recall.sources.remove': async ({ kind, sourceId, revokeAssets } = {}, ctx) => {
    if (
      !recallSources.COGNITION_CATALOG_KINDS.includes(kind)
      || !safeId(sourceId)
      || typeof revokeAssets !== 'boolean'
    ) throw new Error('invalid cognition source removal');
    return {
      ok: true,
      result: await recallSources.removeCognitionSource(ctx.userId, kind, sourceId, revokeAssets),
    };
  },

  'recall.views.list': async ({ purpose, workspaceId, includeExpired, limit } = {}, ctx) => {
    if (purpose !== undefined && purpose !== 'conversation_capture' && purpose !== 'task_context') throw new Error('invalid recall view purpose');
    if (workspaceId !== undefined && !safeId(workspaceId)) throw new Error('invalid workspace id');
    if (includeExpired !== undefined && typeof includeExpired !== 'boolean') throw new Error('invalid include expired');
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new Error('invalid recall view limit');
    return {
      ok: true,
      views: await recallViews.listRecallViews(ctx.userId, {
        ...(purpose !== undefined ? { purpose } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(includeExpired !== undefined ? { includeExpired } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    };
  },

  'recall.views.read': async ({ viewId } = {}, ctx) => {
    if (!safeId(viewId)) throw new Error('invalid recall view id');
    return { ok: true, view: await recallViews.readRecallView(ctx.userId, viewId) };
  },

  'recall.teaching.list': async ({ conversationId, status, limit } = {}, ctx) => {
    if (conversationId !== undefined && !safeId(conversationId)) throw new Error('invalid conversation id');
    if (status !== undefined && status !== 'active' && status !== 'revoked') throw new Error('invalid teaching status');
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new Error('invalid teaching limit');
    // `signals` 保留原字段名（既有调用方按它读），另给 `total`——它是满足查询
    // 条件的真实条数，不受 limit 影响。「待我处理」的「教学回执」指标此前取
    // `signals.length`，超过 limit 就是个错数字，且错得不可见。
    const page = await recallTeaching.listUserTeachingSignalPage(ctx.userId, {
      ...(conversationId !== undefined ? { conversationId } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { ok: true, signals: page.items, total: page.total };
  },

  'recall.teaching.revoke': async ({ signalId } = {}, ctx) => {
    if (!safeId(signalId)) throw new Error('invalid teaching signal id');
    return { ok: true, signal: await recallTeaching.revokeUserTeachingSignal(ctx.userId, signalId) };
  },

  'recall.captures.list': async ({ limit, statuses, executionPolicy, cursor } = {}, ctx) => {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new Error('invalid capture limit');
    const validStatuses = new Set([
      'waiting', 'waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled', 'queued', 'extracting', 'paused',
      'review_ready', 'writing', 'completed', 'no_candidate', 'configuration_required', 'failed', 'cancelled',
    ]);
    if (statuses !== undefined && (
      !Array.isArray(statuses)
      || statuses.length > validStatuses.size
      || statuses.some((status) => typeof status !== 'string' || !validStatuses.has(status))
    )) throw new Error('invalid recall capture statuses');
    if (executionPolicy !== undefined && !['smart', 'immediate', 'nightly', 'manual'].includes(executionPolicy)) {
      throw new Error('invalid recall capture execution policy');
    }
    if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 500)) {
      throw new Error('invalid recall capture cursor');
    }
    const page = await recallCaptures.queryRecallCaptures(ctx.userId, {
      ...(limit === undefined ? {} : { limit }),
      ...(statuses === undefined ? {} : { statuses }),
      ...(executionPolicy === undefined ? {} : { executionPolicy }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    return { ok: true, ...page };
  },

  'recall.captures.read': async ({ captureId } = {}, ctx) => {
    if (!safeId(captureId)) throw new Error('invalid recall capture id');
    return { ok: true, capture: await recallCaptures.readRecallCaptureWorkflow(ctx.userId, captureId) };
  },

  'recall.captures.retry': async ({ captureId } = {}, ctx) => {
    if (!safeId(captureId)) throw new Error('invalid recall capture id');
    return { ok: true, capture: await recallCaptures.retryRecallCapture(ctx.userId, captureId) };
  },

  'recall.captures.pause': async ({ captureId } = {}, ctx) => {
    if (!safeId(captureId)) throw new Error('invalid recall capture id');
    return { ok: true, capture: await recallCaptures.pauseRecallCapture(ctx.userId, captureId) };
  },

  'recall.captures.resume': async ({ captureId } = {}, ctx) => {
    if (!safeId(captureId)) throw new Error('invalid recall capture id');
    return { ok: true, capture: await recallCaptures.resumeRecallCapture(ctx.userId, captureId) };
  },

  'recall.captures.cancel': async ({ captureId } = {}, ctx) => {
    if (!safeId(captureId)) throw new Error('invalid recall capture id');
    return { ok: true, capture: await recallCaptures.cancelRecallCapture(ctx.userId, captureId) };
  },

  'recall.captures.runNow': async ({ captureId } = {}, ctx) => {
    if (!safeId(captureId)) throw new Error('invalid recall capture id');
    return { ok: true, capture: await recallCaptures.runRecallCaptureNow(ctx.userId, captureId) };
  },

  'recall.captures.manualCreate': async ({ conversationId } = {}, ctx) => {
    if (!safeId(conversationId)) throw new Error('invalid conversation id');
    return {
      ok: true,
      capture: await recallCaptures.queueManualRecallCaptureFromConversation(ctx.userId, conversationId),
    };
  },

  'recall.captures.historicalAutoStart': async ({ conversationId } = {}, ctx) => {
    if (!safeId(conversationId)) throw new Error('invalid conversation id');
    return {
      ok: true,
      capture: await recallCaptures.startHistoricalRecallCapture(ctx.userId, conversationId),
    };
  },

  'recall.captures.settings.get': async (_input, ctx) => {
    const [settings, model] = await Promise.all([
      recallCaptureSettings.readRecallCaptureSettings(ctx.userId),
      auth.getConfig(),
    ]);
    return {
      ok: true,
      settings,
      model: {
        ...model,
        configured: auth.hasConfiguredModel().configured,
        authorizationRequired: Boolean(auth.getConfiguredModelOAuthExpiredMessage()),
      },
    };
  },

  'recall.captures.settings.update': async (input = {}, ctx) => {
    const settings = await recallCaptureSettings.updateRecallCaptureSettings(ctx.userId, input);
    return { ok: true, settings };
  },

  'recall.candidates.importPersonalOntology': async ({ candidateId } = {}, ctx) => {
    if (!safeId(candidateId)) throw new Error('invalid personal ontology candidate id');
    return { ok: true, candidate: withRecallCandidateCapabilities(await recallCandidates.importPersonalOntologyCandidate(ctx.userId, candidateId)) };
  },

  'recall.candidates.read': async ({ candidateId } = {}, ctx) => {
    if (!safeId(candidateId)) throw new Error('invalid recall candidate id');
    return { ok: true, candidate: withRecallCandidateCapabilities(await recallCandidates.readRecallCandidate(ctx.userId, candidateId)) };
  },

  'recall.candidates.save': async ({ judgment, value, summary, uncertainty, suggestedType, suggestedScope, suggestedAction, risk, sourceRefs, evidenceRefs, expiresAt, taskRunId, targetAssetId, spaceId, applicableWhen, forbiddenWhen } = {}, ctx) => {
    if (typeof judgment !== 'string' || judgment.length > 4_000) throw new Error('invalid recall candidate judgment');
    if (summary !== undefined && (typeof summary !== 'string' || summary.length > 1_000)) throw new Error('invalid recall candidate summary');
    if (value !== undefined && (typeof value !== 'string' || value.length > 1_000)) throw new Error('invalid recall candidate value');
    if (uncertainty !== undefined && (typeof uncertainty !== 'string' || uncertainty.length > 1_000)) throw new Error('invalid recall candidate uncertainty');
    if (suggestedType !== 'personal' && suggestedType !== 'rule' && suggestedType !== 'template' && suggestedType !== 'skill_method') throw new Error('invalid recall candidate type');
    if (typeof suggestedScope !== 'string' || suggestedScope.length > 500) throw new Error('invalid recall candidate scope');
    if (!Array.isArray(sourceRefs) || sourceRefs.length > 100) throw new Error('invalid recall candidate source refs');
    if (spaceId !== undefined && !safeId(spaceId)) throw new Error('invalid space id');
    if (evidenceRefs !== undefined && (!Array.isArray(evidenceRefs) || evidenceRefs.length > 100)) throw new Error('invalid recall candidate evidence refs');
    if (suggestedAction !== undefined && !['create', 'update', 'limit_scope', 'pause', 'keep_current', 'reject'].includes(suggestedAction)) throw new Error('invalid recall candidate action');
    if (risk !== undefined && !['low', 'medium', 'high'].includes(risk)) throw new Error('invalid recall candidate risk');
    if (expiresAt !== undefined && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) throw new Error('invalid recall candidate expiry');
    if (taskRunId !== undefined && !safeId(taskRunId)) throw new Error('invalid recall candidate task run id');
    if (targetAssetId !== undefined && !safeId(targetAssetId)) throw new Error('invalid recall candidate target asset id');
    if (applicableWhen !== undefined && (!Array.isArray(applicableWhen) || applicableWhen.length > 32)) throw new Error('invalid recall candidate applicable range');
    if (forbiddenWhen !== undefined && (!Array.isArray(forbiddenWhen) || forbiddenWhen.length > 32)) throw new Error('invalid recall candidate forbidden range');
    return { ok: true, candidate: withRecallCandidateCapabilities(await recallCandidates.saveRecallCandidate(ctx.userId, { judgment, ...(value !== undefined ? { value } : {}), ...(summary !== undefined ? { summary } : {}), ...(uncertainty !== undefined ? { uncertainty } : {}), suggestedType, suggestedScope, ...(suggestedAction !== undefined ? { suggestedAction } : {}), ...(risk !== undefined ? { risk } : {}), sourceRefs, ...(evidenceRefs !== undefined ? { evidenceRefs } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}), ...(taskRunId !== undefined ? { taskRunId } : {}), ...(targetAssetId !== undefined ? { targetAssetId } : {}), ...(spaceId ? { spaceId } : {}), ...(applicableWhen !== undefined ? { applicableWhen } : {}), ...(forbiddenWhen !== undefined ? { forbiddenWhen } : {}) })) };
  },

  'recall.candidates.update': async ({ candidateId, judgment, value, summary, uncertainty, suggestedType, suggestedScope, suggestedAction, risk, sourceRefs, evidenceRefs, expiresAt, taskRunId, targetAssetId, applicableWhen, forbiddenWhen } = {}, ctx) => {
    if (!safeId(candidateId) || typeof judgment !== 'string' || judgment.length > 4_000 || (value !== undefined && (typeof value !== 'string' || value.length > 1_000)) || (summary !== undefined && (typeof summary !== 'string' || summary.length > 1_000)) || (uncertainty !== undefined && (typeof uncertainty !== 'string' || uncertainty.length > 1_000)) || (suggestedType !== 'personal' && suggestedType !== 'rule' && suggestedType !== 'template' && suggestedType !== 'skill_method') || typeof suggestedScope !== 'string' || suggestedScope.length > 500 || !Array.isArray(sourceRefs) || sourceRefs.length > 100) throw new Error('invalid recall candidate update');
    if (evidenceRefs !== undefined && (!Array.isArray(evidenceRefs) || evidenceRefs.length > 100)) throw new Error('invalid recall candidate evidence refs');
    if (suggestedAction !== undefined && !['create', 'update', 'limit_scope', 'pause', 'keep_current', 'reject'].includes(suggestedAction)) throw new Error('invalid recall candidate action');
    if (risk !== undefined && !['low', 'medium', 'high'].includes(risk)) throw new Error('invalid recall candidate risk');
    if (expiresAt !== undefined && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) throw new Error('invalid recall candidate expiry');
    if (taskRunId !== undefined && !safeId(taskRunId)) throw new Error('invalid recall candidate task run id');
    if (targetAssetId !== undefined && !safeId(targetAssetId)) throw new Error('invalid recall candidate target asset id');
    if (applicableWhen !== undefined && (!Array.isArray(applicableWhen) || applicableWhen.length > 32)) throw new Error('invalid recall candidate applicable range');
    if (forbiddenWhen !== undefined && (!Array.isArray(forbiddenWhen) || forbiddenWhen.length > 32)) throw new Error('invalid recall candidate forbidden range');
    return { ok: true, candidate: withRecallCandidateCapabilities(await recallCandidates.updateRecallCandidate(ctx.userId, candidateId, { judgment, ...(value !== undefined ? { value } : {}), ...(summary !== undefined ? { summary } : {}), ...(uncertainty !== undefined ? { uncertainty } : {}), suggestedType, suggestedScope, ...(suggestedAction !== undefined ? { suggestedAction } : {}), ...(risk !== undefined ? { risk } : {}), sourceRefs, ...(evidenceRefs !== undefined ? { evidenceRefs } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}), ...(taskRunId !== undefined ? { taskRunId } : {}), ...(targetAssetId !== undefined ? { targetAssetId } : {}), ...(applicableWhen !== undefined ? { applicableWhen } : {}), ...(forbiddenWhen !== undefined ? { forbiddenWhen } : {}) })) };
  },

  'recall.candidates.defer': async ({ candidateId, note } = {}, ctx) => {
    if (!safeId(candidateId)) throw new Error('invalid recall candidate id');
    if (note !== undefined && (typeof note !== 'string' || note.length > 1_000)) throw new Error('invalid recall candidate note');
    return { ok: true, candidate: withRecallCandidateCapabilities(await recallCandidates.deferRecallCandidate(ctx.userId, candidateId, note)) };
  },

  'recall.candidates.resume': async ({ candidateId } = {}, ctx) => {
    if (!safeId(candidateId)) throw new Error('invalid recall candidate id');
    return { ok: true, candidate: withRecallCandidateCapabilities(await recallCandidates.resumeRecallCandidate(ctx.userId, candidateId)) };
  },

  'recall.candidates.reject': async ({ candidateId, note } = {}, ctx) => {
    if (!safeId(candidateId)) throw new Error('invalid recall candidate id');
    if (note !== undefined && (typeof note !== 'string' || note.length > 1_000)) throw new Error('invalid recall candidate note');
    return { ok: true, candidate: withRecallCandidateCapabilities(await recallCandidates.rejectRecallCandidate(ctx.userId, candidateId, note)) };
  },

  'recall.candidates.ignore': async ({ candidateId, note } = {}, ctx) => {
    if (!safeId(candidateId)) throw new Error('invalid recall candidate id');
    if (note !== undefined && (typeof note !== 'string' || note.length > 1_000)) throw new Error('invalid recall candidate note');
    return { ok: true, candidate: withRecallCandidateCapabilities(await recallCandidates.ignoreRecallCandidate(ctx.userId, candidateId, note)) };
  },

  'recall.candidates.keepCurrent': async ({ candidateId, note } = {}, ctx) => {
    if (!safeId(candidateId)) throw new Error('invalid recall candidate id');
    if (note !== undefined && (typeof note !== 'string' || note.length > 1_000)) throw new Error('invalid recall candidate note');
    return { ok: true, candidate: withRecallCandidateCapabilities(await recallCandidates.keepCurrentRecallCandidate(ctx.userId, candidateId, note)) };
  },

  'recall.candidates.promoteBatch': async ({ candidateIds } = {}, ctx) => {
    if (!Array.isArray(candidateIds) || candidateIds.length > 100 || candidateIds.some((id) => !safeId(id))) throw new Error('invalid recall candidate ids');
    return { ok: true, ...(await recallCandidates.batchPromoteRecallCandidates(ctx.userId, candidateIds)) };
  },

  'recall.candidates.promote': async ({ candidateId, riskAcknowledged, profileTarget } = {}, ctx) => {
    if (!safeId(candidateId)) throw new Error('invalid recall candidate id');
    if (riskAcknowledged !== undefined && typeof riskAcknowledged !== 'boolean') throw new Error('invalid risk acknowledgment');
    // 落点只有一个 opaque fieldRef（PO contract 生成）。IPC 层只做形状与长度
    // 校验，语义判定（模板存在/已安装/分节/字段/T-box）留给 PO 写入口——
    // 收归前这里逐字段校验 groupId+section+fieldName，等于在 IPC 层复述一遍
    // PO 的内部结构。
    if (profileTarget !== undefined) {
      if (!profileTarget || typeof profileTarget !== 'object' || Array.isArray(profileTarget)
        || typeof profileTarget.fieldRef !== 'string'
        || !safeId(profileTarget.fieldRef)
        || profileTarget.fieldRef.length > 512) {
        throw new Error('invalid personal profile target');
      }
    }
    const promoted = await recallCaptures.promoteRecallCaptureCandidate(ctx.userId, candidateId, {
      riskAcknowledged: riskAcknowledged === true,
      ...(profileTarget ? { profileTarget: { fieldRef: profileTarget.fieldRef } } : {}),
    });
    return {
      ok: true,
      ...promoted,
      ...(promoted.candidate ? { candidate: withRecallCandidateCapabilities(promoted.candidate) } : {}),
    };
  },

  // 资产读口统一走 canonical layer：出去的每一条必然是四类正式资产，
  // 渲染层不需要再自己辨真假。返回底层记录形状以保持读兼容。
  'recall.assets.list': async (_args, ctx) => ({
    ok: true,
    assets: (await formalAssets.listFormalAssets(ctx.userId)).map((asset) => asset.record),
  }),
  'recall.assets.listForSpace': async ({ spaceId } = {}, ctx) => {
    if (!safeId(spaceId)) throw new Error('invalid space id');
    return {
      ok: true,
      assets: (await formalAssets.listFormalAssets(ctx.userId, { spaceId })).map((asset) => asset.record),
    };
  },
  'recall.assets.read': async ({ assetId } = {}, ctx) => {
    if (!safeId(assetId)) throw new Error('invalid recall asset id');
    const asset = await formalAssets.getFormalAsset(ctx.userId, assetId);
    if (!asset) throw new Error('recall ability asset not found');
    return { ok: true, asset: asset.record };
  },
  'recall.assets.update': async ({ assetId, title, statement, scope, scopePolicy, type, evidenceRefs, ontologyRefs, relations, derivedFrom, applicableWhen, forbiddenWhen, sensitivity, reason, acknowledgeRecommendation } = {}, ctx) => {
    if (!safeId(assetId)) throw new Error('invalid recall asset id');
    const note = boundedText(reason, 'recall asset update reason', 1_000);
    if (title !== undefined && (typeof title !== 'string' || title.length > 120)) throw new Error('invalid recall asset title');
    if (statement !== undefined && (typeof statement !== 'string' || statement.length > 4_000)) throw new Error('invalid recall asset statement');
    if (scope !== undefined && (typeof scope !== 'string' || scope.length > 500)) throw new Error('invalid recall asset scope');
    if (scopePolicy !== undefined && (!scopePolicy || typeof scopePolicy !== 'object' || Array.isArray(scopePolicy))) throw new Error('invalid recall asset scope policy');
    if (type !== undefined && !['personal', 'rule', 'template', 'skill_method'].includes(type)) throw new Error('invalid recall asset type');
    if (evidenceRefs !== undefined && !Array.isArray(evidenceRefs)) throw new Error('invalid recall asset evidence');
    if (ontologyRefs !== undefined && !Array.isArray(ontologyRefs)) throw new Error('invalid recall asset ontology refs');
    if (relations !== undefined && !Array.isArray(relations)) throw new Error('invalid recall asset relations');
    if (derivedFrom !== undefined && !Array.isArray(derivedFrom)) throw new Error('invalid recall asset provenance');
    if (applicableWhen !== undefined && (!Array.isArray(applicableWhen) || applicableWhen.length > 32)) throw new Error('invalid recall asset applicable range');
    if (forbiddenWhen !== undefined && (!Array.isArray(forbiddenWhen) || forbiddenWhen.length > 32)) throw new Error('invalid recall asset forbidden range');
    if (sensitivity !== undefined && !['L0', 'L1', 'L2'].includes(sensitivity)) throw new Error('invalid recall asset sensitivity');
    if (acknowledgeRecommendation !== undefined && typeof acknowledgeRecommendation !== 'boolean') throw new Error('invalid recall asset recommendation acknowledgment');
    return { ok: true, asset: await recallAssets.updateAbilityAsset(ctx.userId, assetId, { ...(title !== undefined ? { title } : {}), ...(statement !== undefined ? { statement } : {}), ...(scope !== undefined ? { scope } : {}), ...(scopePolicy !== undefined ? { scopePolicy } : {}), ...(type !== undefined ? { type } : {}), ...(evidenceRefs !== undefined ? { evidenceRefs } : {}), ...(ontologyRefs !== undefined ? { ontologyRefs } : {}), ...(relations !== undefined ? { relations } : {}), ...(derivedFrom !== undefined ? { derivedFrom } : {}), ...(applicableWhen !== undefined ? { applicableWhen } : {}), ...(forbiddenWhen !== undefined ? { forbiddenWhen } : {}), ...(sensitivity !== undefined ? { sensitivity } : {}), reason: note, actor: 'user', ...(acknowledgeRecommendation !== undefined ? { acknowledgeRecommendation } : {}) }) };
  },
  'recall.assets.pause': async ({ assetId, note } = {}, ctx) => { if (!safeId(assetId) || (note !== undefined && (typeof note !== 'string' || !note.trim() || note.length > 1_000))) throw new Error('invalid recall asset pause'); return { ok: true, asset: await recallAssets.pauseAbilityAsset(ctx.userId, assetId, { actor: 'user', reason: note ?? 'user pause' }) }; },
  'recall.assets.resume': async ({ assetId, note } = {}, ctx) => { if (!safeId(assetId) || (note !== undefined && (typeof note !== 'string' || !note.trim() || note.length > 1_000))) throw new Error('invalid recall asset resume'); return { ok: true, asset: await recallAssets.resumeAbilityAsset(ctx.userId, assetId, { actor: 'user', reason: note ?? 'user resume' }) }; },
  'recall.assets.revoke': async ({ assetId, note } = {}, ctx) => { if (!safeId(assetId) || (note !== undefined && (typeof note !== 'string' || !note.trim() || note.length > 1_000))) throw new Error('invalid recall asset revoke'); return { ok: true, asset: await recallAssets.revokeAbilityAsset(ctx.userId, assetId, { actor: 'user', reason: note ?? 'user revoke' }) }; },
  'recall.assets.recommend': async ({ assetId, action, reason } = {}, ctx) => { if (!safeId(assetId) || (action !== 'pause' && action !== 'rework')) throw new Error('invalid recall asset recommendation'); return { ok: true, asset: await recallAssets.recommendAbilityAssetAction(ctx.userId, assetId, { actor: 'system', action, reason: boundedText(reason, 'recall asset recommendation reason', 1_000) }) }; },
  'recall.assets.versions': async ({ assetId } = {}, ctx) => { if (!safeId(assetId)) throw new Error('invalid recall asset id'); return { ok: true, versions: await recallAssets.listAbilityAssetVersions(ctx.userId, assetId), audit: await recallAssets.listAbilityAssetAudit(ctx.userId, assetId) }; },
  // 规范 22.1 的其余治理动作。彻底清除不可逆，恢复受保留期约束，两者的判断都在
  // feature 层——这里只做参数校验。
  'recall.assets.archive': async ({ assetId, note } = {}, ctx) => { if (!safeId(assetId) || (note !== undefined && (typeof note !== 'string' || !note.trim() || note.length > 1_000))) throw new Error('invalid recall asset archive'); return { ok: true, asset: await recallAssets.archiveAbilityAsset(ctx.userId, assetId, { actor: 'user', reason: note ?? 'user archive' }) }; },
  'recall.assets.delete': async ({ assetId, note } = {}, ctx) => { if (!safeId(assetId) || (note !== undefined && (typeof note !== 'string' || !note.trim() || note.length > 1_000))) throw new Error('invalid recall asset delete'); return { ok: true, asset: await recallAssets.deleteAbilityAsset(ctx.userId, assetId, { actor: 'user', reason: note ?? 'user delete' }) }; },
  'recall.assets.purge': async ({ assetId, note } = {}, ctx) => { if (!safeId(assetId) || (note !== undefined && (typeof note !== 'string' || !note.trim() || note.length > 1_000))) throw new Error('invalid recall asset purge'); return { ok: true, asset: await recallAssets.purgeAbilityAsset(ctx.userId, assetId, { actor: 'user', reason: note ?? 'user purge' }) }; },
  'recall.assets.restore': async ({ assetId, note } = {}, ctx) => { if (!safeId(assetId) || (note !== undefined && (typeof note !== 'string' || !note.trim() || note.length > 1_000))) throw new Error('invalid recall asset restore'); return { ok: true, asset: await recallAssets.restoreAbilityAsset(ctx.userId, assetId, { actor: 'user', reason: note ?? 'user restore' }) }; },
  'recall.assets.rollback': async ({ assetId, version, note } = {}, ctx) => { if (!safeId(assetId) || typeof version !== 'string' || !/^[0-9]{1,9}$/.test(version) || (note !== undefined && (typeof note !== 'string' || !note.trim() || note.length > 1_000))) throw new Error('invalid recall asset rollback'); return { ok: true, asset: await recallAssets.rollbackAbilityAsset(ctx.userId, assetId, version, { actor: 'user', reason: note ?? `user rollback to v${version}` }) }; },

  'recall.skills.prepare': async ({ assetId } = {}, ctx) => {
    if (!safeId(assetId)) throw new Error('invalid recall asset id');
    return { ok: true, draft: await recallSkillDrafts.prepareRecallSkillDraft(ctx.userId, assetId) };
  },

  'recall.skills.confirm': async ({ assetId, draftHash } = {}, ctx) => {
    if (!safeId(assetId) || typeof draftHash !== 'string' || !/^[a-f0-9]{64}$/.test(draftHash)) {
      throw new Error('invalid recall skill confirmation');
    }
    return { ok: true, ...(await recallSkillDrafts.confirmRecallSkillDraft(ctx.userId, assetId, draftHash)) };
  },

  'recall.skills.decide': async ({ assetId, draftHash, decision } = {}, ctx) => {
    if (!safeId(assetId) || typeof draftHash !== 'string' || !/^[a-f0-9]{64}$/.test(draftHash)
      || (decision !== 'accept' && decision !== 'defer' && decision !== 'reject')) {
      throw new Error('invalid recall skill decision');
    }
    if (decision === 'accept') {
      return { ok: true, ...(await recallSkillDrafts.confirmRecallSkillDraft(ctx.userId, assetId, draftHash)) };
    }
    return { ok: true, draft: await recallSkillDrafts.decideRecallSkillDraft(ctx.userId, assetId, draftHash, decision) };
  },

  'recall.workspaceRefs.list': async ({ assetId } = {}, ctx) => { if (assetId !== undefined && !safeId(assetId)) throw new Error('invalid recall asset id'); return { ok: true, references: await recallWorkspaceRefs.listWorkspaceAssetReferences(ctx.userId, assetId) }; },
  'recall.workspaceRefs.add': async ({ assetId, workspaceId, scope, enabled } = {}, ctx) => { if (!safeId(assetId) || !safeId(workspaceId) || typeof scope !== 'string' || (enabled !== undefined && typeof enabled !== 'boolean')) throw new Error('invalid workspace reference'); return { ok: true, reference: await recallWorkspaceRefs.addWorkspaceAssetReference(ctx.userId, { assetId, workspaceId, scope, ...(enabled !== undefined ? { enabled } : {}) }) }; },
  'recall.workspaceRefs.update': async ({ id, scope, enabled } = {}, ctx) => { if (!safeId(id) || (scope !== undefined && typeof scope !== 'string') || (enabled !== undefined && typeof enabled !== 'boolean')) throw new Error('invalid workspace reference'); return { ok: true, reference: await recallWorkspaceRefs.updateWorkspaceAssetReference(ctx.userId, id, { ...(scope !== undefined ? { scope } : {}), ...(enabled !== undefined ? { enabled } : {}) }) }; },
  'recall.workspaceRefs.remove': async ({ id } = {}, ctx) => { if (!safeId(id)) throw new Error('invalid workspace reference id'); await recallWorkspaceRefs.removeWorkspaceAssetReference(ctx.userId, id); return { ok: true }; },

  'recall.projections.preview': async ({ taskRunId, workspaceId, purpose, taskText, authorization, expiresAt } = {}, ctx) => { if (!safeId(taskRunId) || (workspaceId !== undefined && !safeId(workspaceId)) || typeof purpose !== 'string' || (taskText !== undefined && (typeof taskText !== 'string' || taskText.length > 2_000)) || (authorization !== undefined && authorization !== 'user_confirmed' && authorization !== 'workspace_policy' && authorization !== 'not_required') || (expiresAt !== undefined && typeof expiresAt !== 'string')) throw new Error('invalid recall projection'); return { ok: true, projection: await recallProjection.previewContextProjection(ctx.userId, { taskRunId, ...(workspaceId !== undefined ? { workspaceId } : {}), purpose, ...(taskText !== undefined ? { taskText } : {}), ...(authorization !== undefined ? { authorization } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) }) }; },
  'recall.projections.list': async ({ workspaceId, status, includeExpired, limit } = {}, ctx) => {
    if (workspaceId !== undefined && !safeId(workspaceId)) throw new Error('invalid workspace id');
    if (status !== undefined && !['preview', 'confirmed', 'deferred', 'rejected', 'expired', 'revoked'].includes(status)) throw new Error('invalid projection status');
    if (includeExpired !== undefined && typeof includeExpired !== 'boolean') throw new Error('invalid include expired');
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new Error('invalid projection limit');
    return {
      ok: true,
      projections: await recallProjection.listContextProjections(ctx.userId, {
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(includeExpired !== undefined ? { includeExpired } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    };
  },
  'recall.projections.confirm': async ({ projectionId, cid } = {}, ctx) => { if (!safeId(projectionId) || !safeId(cid)) throw new Error('invalid projection confirm'); return { ok: true, ...(await kstarProjectionDecision.confirmProjectionAndResumeCommander(ctx.userId, { projectionId, cid })) }; },
  'recall.projections.retryForecast': async ({ projectionId, cid } = {}, ctx) => { if (!safeId(projectionId) || !safeId(cid)) throw new Error('invalid projection retry'); return { ok: true, ...(await kstarProjectionDecision.retryProjectionInCommander(ctx.userId, { projectionId, cid })) }; },
  'recall.projections.revise': async ({ projectionId, purpose, addAssetIds, removeAssetIds, decisionNote } = {}, ctx) => { if (!safeId(projectionId) || (purpose !== undefined && typeof purpose !== 'string') || (addAssetIds !== undefined && (!Array.isArray(addAssetIds) || addAssetIds.length > 100 || addAssetIds.some((id) => !safeId(id)))) || (removeAssetIds !== undefined && (!Array.isArray(removeAssetIds) || removeAssetIds.length > 100 || removeAssetIds.some((id) => !safeId(id)))) || (decisionNote !== undefined && typeof decisionNote !== 'string')) throw new Error('invalid projection revision'); return { ok: true, projection: await recallProjection.reviseContextProjection(ctx.userId, projectionId, { ...(purpose !== undefined ? { purpose } : {}), ...(addAssetIds !== undefined ? { addAssetIds } : {}), ...(removeAssetIds !== undefined ? { removeAssetIds } : {}), ...(decisionNote !== undefined ? { decisionNote } : {}) }) }; },
  'recall.projections.availableAssets': async ({ projectionId } = {}, ctx) => { if (!safeId(projectionId)) throw new Error('invalid projection id'); return { ok: true, assets: await recallProjection.listAvailableProjectionAssets(ctx.userId, projectionId) }; },
  'recall.projections.confirmAndApproveWake': async ({ cid, projectionId, wakeRequestId } = {}, ctx) => { if (!safeId(cid) || !safeId(projectionId) || !safeId(wakeRequestId)) throw new Error('invalid projection wake confirmation'); return recallProjection.confirmAndApproveWake(ctx.userId, { cid, projectionId, wakeRequestId }); },
  'recall.projections.defer': async ({ projectionId, note } = {}, ctx) => { if (!safeId(projectionId) || (note !== undefined && (typeof note !== 'string' || note.length > 1_000))) throw new Error('invalid projection id'); return { ok: true, projection: await recallProjection.deferContextProjection(ctx.userId, projectionId, note) }; },
  'recall.projections.reject': async ({ projectionId, cid, note } = {}, ctx) => { if (!safeId(projectionId) || !safeId(cid) || (note !== undefined && (typeof note !== 'string' || note.length > 1_000))) throw new Error('invalid projection id'); return { ok: true, ...(await kstarProjectionDecision.rejectProjectionAndResumeCommander(ctx.userId, { projectionId, cid, note })) }; },
  'kstar.review.confirm': async ({ episodeId, verdict } = {}, ctx) => {
    if (!safeId(episodeId) || !['met', 'partial', 'not_met', 'skip'].includes(String(verdict))) {
      return { ok: false, error: 'invalid kstar review input' };
    }
    try {
      await kstarTaskClosure.confirmKstarReview(ctx.userId, episodeId, { verdict });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  },
  'kstar.review.read': async ({ episodeId } = {}, ctx) => {
    if (!safeId(episodeId)) return { ok: false, error: 'invalid kstar review episode id' };
    try {
      const review = await kstarReviewService.readKstarReview(ctx.userId, episodeId);
      return { ok: true, review: review ? { reviewState: review.reviewState } : null };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  },
  'recall.projections.card': async ({ projectionId } = {}, ctx) => { if (!safeId(projectionId)) throw new Error('invalid projection id'); return { ok: true, card: await recallProjectionCard.buildProjectionCard(ctx.userId, projectionId) }; },
  'recall.projections.postCard': async ({ cid, projectionId } = {}, ctx) => { if (!safeId(cid) || !safeId(projectionId)) throw new Error('invalid projection message'); return { ok: true, ...(await recallProjectionMessage.postProjectionCardMessage(ctx.userId, { cid, projectionId }, { send: async (payload) => ({ id: (await groupChat.sendCommanderMessage({ userId: ctx.userId, cid, text: String(payload.text || ''), ...(payload.card ? { recall_projection_card: { projectionId: payload.card.projectionId } } : {}) })).msg?.id || '' }) })) }; },
  'recall.projections.previewAndPostCard': async ({ cid, taskRunId, workspaceId, purpose, taskText, authorization, expiresAt } = {}, ctx) => { if (!safeId(cid) || !safeId(taskRunId) || (workspaceId !== undefined && !safeId(workspaceId)) || typeof purpose !== 'string' || (taskText !== undefined && (typeof taskText !== 'string' || taskText.length > 2_000)) || (authorization !== undefined && authorization !== 'user_confirmed' && authorization !== 'workspace_policy' && authorization !== 'not_required') || (expiresAt !== undefined && typeof expiresAt !== 'string')) throw new Error('invalid projection message'); return { ok: true, ...(await recallProjectionMessage.previewAndPostProjectionCard(ctx.userId, { cid, taskRunId, ...(workspaceId !== undefined ? { workspaceId } : {}), purpose, ...(taskText !== undefined ? { taskText } : {}), ...(authorization !== undefined ? { authorization } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) }, { send: async (payload) => ({ id: (await groupChat.sendCommanderMessage({ userId: ctx.userId, cid, text: String(payload.text || ''), recall_projection_card: { projectionId: payload.card.projectionId } })).msg?.id || '' }) })) }; },
  'recall.projections.previewAndPostForNextTask': async ({ cid, workspaceId, purpose, taskText, authorization, expiresAt } = {}, ctx) => { if (!safeId(cid) || (workspaceId !== undefined && !safeId(workspaceId)) || (purpose !== undefined && typeof purpose !== 'string') || (taskText !== undefined && (typeof taskText !== 'string' || taskText.length > 2_000)) || (authorization !== undefined && authorization !== 'user_confirmed' && authorization !== 'workspace_policy' && authorization !== 'not_required') || (expiresAt !== undefined && typeof expiresAt !== 'string')) throw new Error('invalid projection message'); return { ok: true, ...(await recallProjectionMessage.previewAndPostProjectionCardForNextTask(ctx.userId, { cid, ...(workspaceId !== undefined ? { workspaceId } : {}), ...(purpose !== undefined ? { purpose } : {}), ...(taskText !== undefined ? { taskText } : {}), ...(authorization !== undefined ? { authorization } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) }, { send: async (payload) => ({ id: (await groupChat.sendCommanderMessage({ userId: ctx.userId, cid, text: String(payload.text || ''), recall_projection_card: { projectionId: payload.card.projectionId } })).msg?.id || '' }) })), }; },
  'recall.projections.reviseAndPostCard': async ({ cid, projectionId, purpose, addAssetIds, removeAssetIds, decisionNote } = {}, ctx) => { if (!safeId(cid) || !safeId(projectionId) || (purpose !== undefined && typeof purpose !== 'string') || (addAssetIds !== undefined && (!Array.isArray(addAssetIds) || addAssetIds.length > 100 || addAssetIds.some((id) => !safeId(id)))) || (removeAssetIds !== undefined && (!Array.isArray(removeAssetIds) || removeAssetIds.length > 100 || removeAssetIds.some((id) => !safeId(id)))) || (decisionNote !== undefined && typeof decisionNote !== 'string')) throw new Error('invalid projection message'); return { ok: true, ...(await recallProjectionMessage.reviseAndPostProjectionCard(ctx.userId, { cid, projectionId, ...(purpose !== undefined ? { purpose } : {}), ...(addAssetIds !== undefined ? { addAssetIds } : {}), ...(removeAssetIds !== undefined ? { removeAssetIds } : {}), ...(decisionNote !== undefined ? { decisionNote } : {}) }, { send: async (payload) => ({ id: (await groupChat.sendCommanderMessage({ userId: ctx.userId, cid, text: String(payload.text || ''), recall_projection_card: { projectionId: payload.card.projectionId } })).msg?.id || '' }) })) }; },
  'recall.projections.read': async ({ projectionId } = {}, ctx) => { if (!safeId(projectionId)) throw new Error('invalid projection id'); return { ok: true, projection: await recallProjection.readContextProjection(ctx.userId, projectionId) }; },

  'recall.proofs.transfer.prepare': async ({ projectionId, executionId, expectedResultSnapshot } = {}, ctx) => { if (!safeId(projectionId) || !safeId(executionId) || typeof expectedResultSnapshot !== 'string' || expectedResultSnapshot.length > 4_000) throw new Error('invalid transfer proof'); return { ok: true, proof: await recallProofs.prepareTransferProof(ctx.userId, { projectionId, executionId, expectedResultSnapshot }) }; },
  'recall.proofs.transfer.complete': async ({ proofId, status, receiptId, observedTransfer } = {}, ctx) => { if (!safeId(proofId) || (status !== 'succeeded' && status !== 'degraded' && status !== 'rejected') || receiptId !== undefined || typeof observedTransfer !== 'string' || observedTransfer.length > 4_000) throw new Error('invalid transfer completion'); return { ok: true, proof: await recallProofs.completeTransferProof(ctx.userId, proofId, { status, observedTransfer }) }; },
  'recall.proofs.effectiveness.evaluate': async ({ transferProofId, outcome, observedResult, evidenceRefs } = {}, ctx) => { if (!safeId(transferProofId) || !['better','no_improvement','worse','insufficient_evidence','invalid','rework'].includes(outcome) || typeof observedResult !== 'string' || observedResult.length > 4_000 || !Array.isArray(evidenceRefs) || evidenceRefs.length > 100) throw new Error('invalid effectiveness proof'); return { ok: true, proof: await recallProofs.evaluateEffectivenessProof(ctx.userId, { transferProofId, outcome, observedResult, evidenceRefs }) }; },

  'recall.proofs.effectiveness.feedback': async ({ transferProofId, feedback, note, evidenceRefs } = {}, ctx) => { if (!safeId(transferProofId) || !['positive', 'neutral', 'negative', 'invalid', 'rework'].includes(feedback) || (note !== undefined && typeof note !== 'string') || (evidenceRefs !== undefined && !Array.isArray(evidenceRefs))) throw new Error('invalid effectiveness feedback'); return { ok: true, proof: await effectivenessFeedback.recordEffectivenessFeedback(ctx.userId, { transferProofId, feedback, ...(note !== undefined ? { note } : {}), ...(evidenceRefs !== undefined ? { evidenceRefs } : {}) }) }; },
  'recall.proofs.effectiveness.feedbackForTask': async ({ taskRunId, feedback, note, evidenceRefs } = {}, ctx) => { if (!safeId(taskRunId) || !['positive', 'neutral', 'negative', 'invalid', 'rework'].includes(feedback) || (note !== undefined && typeof note !== 'string') || (evidenceRefs !== undefined && !Array.isArray(evidenceRefs))) throw new Error('invalid effectiveness feedback'); return { ok: true, ...(await effectivenessFeedback.recordTaskEffectivenessFeedback(ctx.userId, { taskRunId, feedback, ...(note !== undefined ? { note } : {}), ...(evidenceRefs !== undefined ? { evidenceRefs } : {}) })) }; },
  // 跨作用域使用的确认与撤回。规范 10.2 要求「确认」，这里是确认真正发生的地方
  // ——没有它，confirm 档只会永远停在等待里。撤回后立刻回到需要确认的状态。
  'recall.assets.crossScope': async ({ assetId, confirmed, reason } = {}, ctx) => {
    if (!safeId(assetId) || typeof confirmed !== 'boolean') throw new Error('invalid cross-scope confirmation');
    return {
      ok: true,
      asset: await recallAssets.setAbilityAssetCrossScopeConfirmation(ctx.userId, assetId, confirmed, {
        actor: 'user',
        reason: typeof reason === 'string' && reason.trim() ? reason : 'cross-scope use decision',
      }),
    };
  },

  // 按资产反查证明。迁移证明说「被带过去用了」，效果证明说「用了有没有帮上忙」
  // ——两者不合并成一个「已验证」布尔值，outcome=worse 也是一条证明。
  'recall.proofs.list': async ({ assetId } = {}, ctx) => {
    if (!safeId(assetId)) throw new Error('invalid recall asset id');
    return { ok: true, proofs: await recallProofs.listAssetProofs(ctx.userId, assetId) };
  },

  // 一条认知的履历：从哪来、进过哪些智能体、真用过几次、哪几次没带上。
  // 这是履历不是进度条——渲染层不得把 `not_yet` 画成红色或警告。
  'recall.cognitionChain.read': async ({ assetId } = {}, ctx) => {
    if (!safeId(assetId)) throw new Error('invalid recall asset id');
    const { traceCognitionChainByAsset } = await import('../features/recall/cognition-chain');
    return { ok: true, chain: await traceCognitionChainByAsset(ctx.userId, assetId) };
  },
  'recall.tree.read': async (_args, ctx) => ({ ok: true, tree: await recallTree.readCognitionTree(ctx.userId) }),
  'recall.tree.rebuild': async (_args, ctx) => ({ ok: true, tree: await recallTree.rebuildCognitionTree(ctx.userId) }),
  'recall.usage.list': async ({ assetId } = {}, ctx) => { if (assetId !== undefined && !safeId(assetId)) throw new Error('invalid recall asset id'); return { ok: true, usage: await recallUsage.listRecallUsage(ctx.userId, assetId) }; },

  // 「非资产分流」的读通道。接续快照是**非资产**对象（v0.2 §7.3）：任务状态被
  // 带到新会话，但不进四类资产、不长认知树叶片。此前只有按会话单读的
  // `readContinuationSnapshot`，没有面向界面的列表口，那一页只能摆空壳。
  //
  // `total` 与 `items.length` 分开返回：limit 截断的是显示条数，不是事实条数。
  'recall.continuation.list': async ({ limit } = {}, ctx) => {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
      throw new Error('invalid continuation limit');
    }
    const { listContinuationSnapshots } = await import('../features/task_continuation');
    return { ok: true, ...(await listContinuationSnapshots(ctx.userId, { ...(limit !== undefined ? { limit } : {}) })) };
  },
  'recall.continuation.read': async ({ conversationId, projectId } = {}, ctx) => {
    if (!safeId(conversationId)) throw new Error('invalid conversation id');
    if (projectId !== undefined && projectId !== null && !safeId(projectId)) throw new Error('invalid project id');
    const { readContinuationSnapshot } = await import('../features/task_continuation');
    return {
      ok: true,
      snapshot: await readContinuationSnapshot(ctx.userId, conversationId, projectId ?? null),
    };
  },

  // 「使用与证明」视图：timeline-service 已按资产把使用、迁移证明、效果证明和
  // 治理事件聚合成一条事实链，但此前没有 IPC 暴露，渲染层拿不到。
  'recall.timeline.forAsset': async ({ assetId } = {}, ctx) => {
    if (!safeId(assetId)) throw new Error('invalid recall asset id');
    return { ok: true, items: await formalAssets.listFormalAssetTimeline(ctx.userId, assetId) };
  },
  'recall.timeline.list': async ({ limit } = {}, ctx) => {
    const bounded = limit === undefined ? undefined : Number(limit);
    if (bounded !== undefined && (!Number.isFinite(bounded) || bounded <= 0 || bounded > 2_000)) {
      throw new Error('invalid recall timeline limit');
    }
    return { ok: true, items: await formalAssets.listFormalAssetTimeline(ctx.userId, undefined, bounded) };
  },

  'recall.usage.feedback': async ({ cid, messageId, feedback } = {}, ctx) => {
    if (!safeId(cid) || !safeId(messageId) || (feedback !== 'positive' && feedback !== 'negative')) {
      throw new Error('invalid Recall usage feedback');
    }
    return {
      ok: true,
      result: await recallUsageFeedback.recordRecallMessageFeedback(ctx.userId, { cid, messageId, feedback }),
    };
  },

  'cognition.dashboard.read': async (_args, ctx) => {
    return { ok: true, dashboard: await cognition.buildCognitionDashboard(ctx.userId) };
  },

  'cognition.candidates.list': async ({ status, type, conversationId, skillId, limit } = {}, ctx) => {
    if (status !== undefined && status !== 'pending' && status !== 'accepted' && status !== 'rejected') throw new Error('invalid cognition candidate status');
    if (type !== undefined && type !== 'preference' && type !== 'ontology' && type !== 'rule' && type !== 'experience' && type !== 'skill_evolution') throw new Error('invalid cognition candidate type');
    if (conversationId !== undefined && !safeId(conversationId)) throw new Error('invalid conversation id');
    if (skillId !== undefined && !safeId(skillId)) throw new Error('invalid skill id');
    const n = limit === undefined ? undefined : Number(limit);
    return { ok: true, candidates: await cognition.listCognitionCandidates(ctx.userId, {
      ...(status !== undefined ? { status } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(conversationId !== undefined ? { conversationId } : {}),
      ...(skillId !== undefined ? { skillId } : {}),
      ...(Number.isFinite(n) && n > 0 ? { limit: Math.min(n, 200) } : {}),
    }) };
  },

  'cognition.candidates.decide': async ({ source, candidateId, decision, reason, notes, toGlobalMemory, toGroupIds } = {}, ctx) => {
    if (source !== 'personal_ontology') throw new Error('invalid cognition candidate source');
    if (!safeId(candidateId)) throw new Error('invalid candidate id');
    if (decision !== 'accept' && decision !== 'reject') throw new Error('invalid cognition candidate decision');
    if (toGroupIds !== undefined && (!Array.isArray(toGroupIds) || toGroupIds.some((id) => !safeId(id)))) throw new Error('invalid group ids');
    return { ok: true, result: await cognition.decideCognitionCandidate(ctx.userId, {
      source,
      candidateId,
      decision,
      ...(typeof reason === 'string' ? { reason } : {}),
      ...(typeof notes === 'string' ? { notes } : {}),
      ...(typeof toGlobalMemory === 'boolean' ? { toGlobalMemory } : {}),
      ...(Array.isArray(toGroupIds) ? { toGroupIds } : {}),
    }) };
  },

  'cognition.receipts.list': async ({ status, agentId, conversationId, skillId, limit } = {}, ctx) => {
    if (status !== undefined && status !== 'prepared' && status !== 'succeeded' && status !== 'degraded' && status !== 'rejected') throw new Error('invalid cognition receipt status');
    if (agentId !== undefined && !safeId(agentId)) throw new Error('invalid agent id');
    if (conversationId !== undefined && !safeId(conversationId)) throw new Error('invalid conversation id');
    if (skillId !== undefined && !safeId(skillId)) throw new Error('invalid skill id');
    const n = limit === undefined ? undefined : Number(limit);
    return { ok: true, receipts: await cognition.listCognitionReuseReceipts(ctx.userId, {
      ...(status !== undefined ? { status } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      ...(conversationId !== undefined ? { conversationId } : {}),
      ...(skillId !== undefined ? { skillId } : {}),
      ...(Number.isFinite(n) && n > 0 ? { limit: Math.min(n, 200) } : {}),
    }) };
  },

  'cognition.receipts.read': async ({ executionId } = {}, ctx) => {
    if (!safeId(executionId)) throw new Error('invalid execution id');
    return { ok: true, receipt: await cognition.readCognitionReuseReceipt(ctx.userId, executionId) };
  },

  'cognition.assets.list': async ({ type, limit } = {}, ctx) => {
    // N-6: 类型枚举必须与 `CognitionAssetType`（= 四类正式资产）一致。
    // 此前这里收的是上一代分类 skill/knowledge/ontology/evaluation，与适配器
    // 过滤用的 personal/rule/template/skill_method **完全不相交**——传合法类型
    // 抛错、传能通过校验的类型恒返回空列表。渲染层当时不传该参数，所以一直潜伏。
    // 判据走 `formal-assets` 的 canonical 边界，不在这里再抄一份四类字面量。
    if (type !== undefined && !formalAssets.isFormalAssetType(type)) throw new Error('invalid cognition asset type');
    const n = limit === undefined ? undefined : Number(limit);
    // 不传 limit 拿全量再自己截：适配器本来就是先建完整数组、最后一步才 slice
    // （assets-adapter.ts 末尾），所以 total 不额外付读盘代价。此前渲染层按
    // `limit:500` 取回后拿 `.length` 当资产总数，超过 500 就静默错。
    const all = await cognition.listCognitionAssets(ctx.userId, {
      ...(type !== undefined ? { type } : {}),
    });
    const bounded = Number.isFinite(n) && (n as number) > 0 ? Math.min(n as number, 500) : undefined;
    return { ok: true, assets: bounded ? all.slice(0, bounded) : all, total: all.length };
  },

  // 「待我处理」的唯一读口。判断规则在 formal-assets/inbox.ts，与晋升 gate、
  // Runtime gate 复用同一批函数——渲染层不再自己判断什么算待办。
  'cognition.inbox.list': async (_args, ctx) => {
    // 待办读口本身不截断，所以 total 恒等于 items.length；仍显式返回，
    // 让「items + total」在认知资产各读口上是同一个契约，渲染层不必按页
    // 记住哪个口有 total、哪个没有。
    const items = await cognition.listCognitionInbox(ctx.userId);
    return { ok: true, items, total: items.length };
  },

  // 「已处理历史」：跨全部候选列出真实落账的审查决定，按处理时间倒序。
  // 决定账本此前只有按 targetRef 的单读口（存储就是一个 targetRef 一个 jsonl），
  // 回答不了"我一共处理过什么"，那一段历史在界面上完全看不到。
  //
  // 只读既有权威存储，不新增模型、不改候选状态机；`items + total` 与认知资产
  // 其余读口同一契约。
  'cognition.reviewDecisions.list': async ({ limit } = {}, ctx) => {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
      throw new Error('invalid review decision limit');
    }
    return {
      ok: true,
      ...(await cognition.listRecentReviewDecisions(ctx.userId, {
        ...(limit !== undefined ? { limit } : {}),
      })),
    };
  },

  // 「版本与治理」问的是"这一版改了什么"。版本快照本来就存着全量内容，这里
  // 只做比对，不新增持久化。没有 diff 的话，"回滚到此版本"对用户就是盲赌。
  'cognition.assets.diff': async ({ assetId } = {}, ctx) => {
    if (!safeId(assetId)) throw new Error('invalid cognition asset id');
    return { ok: true, diffs: await cognition.listCognitionAssetDiffs(ctx.userId, assetId) };
  },

  'cognition.skills.summary': async ({ skillId } = {}, ctx) => {
    if (!safeId(skillId)) throw new Error('invalid skill id');
    return { ok: true, summary: await cognition.getSkillCognitionSummary(ctx.userId, skillId) };
  },

  'cognition.skills.audit': async (_args, ctx) => ({
    ok: true,
    audit: await cognition.getSkillVersionMigrationAudit(ctx.userId),
  }),

  'cognition.skills.diff': async ({ skillId, fromVersion, toVersion } = {}, ctx) => {
    if (!safeId(skillId) || typeof fromVersion !== 'string' || !fromVersion.trim()
      || typeof toVersion !== 'string' || !toVersion.trim()) throw new Error('invalid skill diff request');
    return { ok: true, diff: await cognition.diffSkillCognitionVersions(ctx.userId, skillId, fromVersion.trim(), toVersion.trim()) };
  },

  'cognition.skills.rollback.preview': async ({ skillId, version } = {}, ctx) => {
    if (!safeId(skillId) || typeof version !== 'string' || !version.trim() || !safeId(version.trim())) throw new Error('invalid skill rollback preview');
    return { ok: true, preview: await cognition.previewSkillCognitionRollback(ctx.userId, skillId, version.trim()) };
  },

  'cognition.skills.rollback': async ({ skillId, version, expectedManifestHash, expectedRevisionId, allowPartialLegacy } = {}, ctx) => {
    if (!safeId(skillId)) throw new Error('invalid skill id');
    if (typeof version !== 'string' || !version.trim() || !safeId(version.trim())) throw new Error('invalid skill version');
    if (expectedManifestHash !== undefined && (typeof expectedManifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedManifestHash))) throw new Error('invalid skill manifest hash');
    if (expectedRevisionId !== undefined && (typeof expectedRevisionId !== 'string' || !safeId(expectedRevisionId))) throw new Error('invalid skill revision');
    if (allowPartialLegacy !== undefined && typeof allowPartialLegacy !== 'boolean') throw new Error('invalid legacy rollback confirmation');
    return { ok: true, result: await cognition.rollbackSkillCognitionVersion(ctx.userId, skillId, version.trim(), {
      ...(expectedManifestHash ? { manifestHash: expectedManifestHash } : {}),
      ...(expectedRevisionId ? { revisionId: expectedRevisionId } : {}),
      ...(allowPartialLegacy === true ? { allowPartialLegacy: true } : {}),
    }) };
  },

  'groupChat.abort': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return groupChat.abort(ctx.userId, cid);
  },

  'groupChat.deleteMessages': async ({ cid, message_ids }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const ids = Array.isArray(message_ids) ? message_ids.filter((id: unknown) => typeof id === 'string') : [];
    return groupChat.deleteMessages(ctx.userId, cid, ids);
  },

  'groupChat.listMembers': async (args, ctx) => {
    const { cid } = args;
    if (!safeId(cid)) throw new Error('invalid cid');
    const projectIdHint = conversationProjectHint(args);
    const conv = await chats.getConversation(ctx.userId, cid, projectIdHint);
    if (!conv) {
      return { ok: false, error: 'conversation not found', actors: [] };
    }
    return groupChat.listMembers(ctx.userId, cid, conv.project_id ?? null);
  },

  'groupChat.runtimeStatus': async (args, ctx) => {
    const { cid } = args;
    if (!safeId(cid)) throw new Error('invalid cid');
    const projectIdHint = conversationProjectHint(args);
    const conv = await chats.getConversation(ctx.userId, cid, projectIdHint);
    return groupChat.runtimeStatus(ctx.userId, cid, conv?.project_id ?? projectIdHint);
  },

  'groupChat.listCollaborationConflicts': async (args, ctx) => {
    const { cid } = args;
    if (!safeId(cid)) throw new Error('invalid cid');
    const projectIdHint = conversationProjectHint(args);
    const conv = await chats.getConversation(ctx.userId, cid, projectIdHint);
    if (!conv) throw new Error('conversation not found');
    return groupChat.listCollaborationConflicts(ctx.userId, cid);
  },

  'groupChat.resolveCollaborationConflict': async (args, ctx) => {
    const { cid, conflictId, decision, selected_proposal_ids, text, reason } = args;
    if (!safeId(cid)) throw new Error('invalid cid');
    if (!safeId(conflictId)) throw new Error('invalid conflict id');
    if (decision !== 'accept' && decision !== 'reject' && decision !== 'merge') throw new Error('invalid conflict resolution decision');
    if (!Array.isArray(selected_proposal_ids)) throw new Error('invalid selected proposal ids');
    if (typeof text !== 'string' || !text.trim()) throw new Error('invalid conflict resolution text');
    const projectIdHint = conversationProjectHint(args);
    const conv = await chats.getConversation(ctx.userId, cid, projectIdHint);
    if (!conv) throw new Error('conversation not found');
    return groupChat.resolveCollaborationConflict(ctx.userId, cid, conflictId, {
      decision,
      selected_proposal_ids,
      text: text.trim(),
      ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
    });
  },

  'groupChat.reviewCollaborationGate': async (args, ctx) => {
    const { cid, gateId, decision, reason } = args;
    if (!safeId(cid)) throw new Error('invalid cid');
    if (!safeId(gateId)) throw new Error('invalid gate id');
    if (decision !== 'approve' && decision !== 'reject') throw new Error('invalid gate review decision');
    const projectIdHint = conversationProjectHint(args);
    const conv = await chats.getConversation(ctx.userId, cid, projectIdHint);
    if (!conv) throw new Error('conversation not found');
    return groupChat.reviewCollaborationGate(ctx.userId, cid, gateId, {
      decision,
      reviewed_by: 'user',
      ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
    });
  },

  'groupChat.markFormSubmitted': async ({ cid, msgId, formId, values }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    if (typeof msgId !== 'string' || !msgId) throw new Error('invalid msgId');
    if (typeof formId !== 'string' || !/^[a-f0-9]{8,64}$/.test(formId)) {
      throw new Error('invalid formId');
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('invalid values');
    }
    return groupChat.markFormSubmittedAndDispatch({
      userId: ctx.userId, cid, msgId, formId, values: values as Record<string, unknown>,
    });
  },

  'groupChat.resolveMarketplaceInstallRequest': async ({ cid, msgId, requestId, decision }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    if (typeof msgId !== 'string' || !safeId(msgId)) throw new Error('invalid msgId');
    if (typeof requestId !== 'string' || !safeId(requestId)) throw new Error('invalid requestId');
    if (decision !== 'install' && decision !== 'skip') throw new Error('invalid decision');
    return groupChat.resolveMarketplaceInstallRequest({
      userId: ctx.userId,
      cid,
      msgId,
      requestId,
      decision,
    });
  },

  // Generic native directory picker. Used by the agent-input-form
  // `directory` type so coding agents (claude / codex) collect their
  // project directory through the standard input-form pipeline.
  'common.pickDirectory': async ({ title } = {}) => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      title: typeof title === 'string' && title ? title : t('dialog.choose_directory'),
    };
    const res = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths?.length) return { cancelled: true };
    return { cancelled: false, path: res.filePaths[0] };
  },

  'common.pickFiles': async ({ title, extensions, multiple } = {}) => {
    const rawExts = Array.isArray(extensions) ? extensions : CHAT_PICK_EXTENSIONS;
    const picked = await _pickLocalFiles(
      typeof title === 'string' && title ? title : 'Choose files',
      rawExts,
      multiple !== false,
    );
    const files = picked.map((filePath) => {
      const buf = fs.readFileSync(filePath);
      return {
        name: path.basename(filePath),
        dataBase64: buf.toString('base64'),
        size: buf.length,
      };
    });
    return { files };
  },

  // ── Chat attachments (per-cid file pool for main chat) ──
  'conversations.attachments.list': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    await chatAttachments.warmConversationSpace(ctx.userId, cid);
    return { items: chatAttachments.listPendingAttachments(ctx.userId, cid) };
  },

  'conversations.attachments.upload': async ({ cid, name, data }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    // `data` arrives as base64 (contextBridge can't ferry Buffers cleanly —
    // same convention as contexts.tmp.upload).
    const buf = typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.from(data || []);
    return chatAttachments.uploadAttachment(ctx.userId, cid, name || '', buf);
  },

  'conversations.attachments.pickAndUpload': async ({ cid } = {}, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const picked = await _pickLocalFiles('Choose files', CHAT_PICK_EXTENSIONS, true);
    const items = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const filePath of picked) {
      const name = path.basename(filePath);
      try {
        const buf = fs.readFileSync(filePath);
        const res = await chatAttachments.uploadAttachment(ctx.userId, cid, name, buf);
        if (res.ok) items.push({ displayName: name, info: res.info, reused: !!res.reused });
        else failed.push({ name, error: (res as any).error });
      } catch (err) {
        failed.push({ name, error: (err as Error)?.message || String(err) });
      }
    }
    return { items, failed };
  },

  'conversations.attachments.import': async (payload, ctx) => {
    const cid = payload?.cid;
    const sourcePath = payload?.path;
    if (!safeId(cid)) throw new Error('invalid cid');
    if (typeof sourcePath !== 'string' || !sourcePath) throw new Error('missing path');

    const norm = path.resolve(sourcePath);
    const allowedRoots = await _ipcFileSandboxAllowedRoots(ctx.userId, payload);
    const inSandbox = isPathAllowed(norm, allowedRoots);
    const inRecordedFile = !inSandbox && await _isConversationRecordedFile(ctx.userId, cid, norm);
    if (!inSandbox && !inRecordedFile) {
      throw new Error('path is outside the user workspace');
    }
    return chatAttachments.importAttachmentFromPath(ctx.userId, cid, norm);
  },

  'conversations.attachments.delete': async ({ cid, name }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    await chatAttachments.warmConversationSpace(ctx.userId, cid);
    if (!chatAttachments.isDraftAttachmentCid(cid)) {
      await recycleBin.createAppRecycleBatchForCloudEntry(
        ctx.userId,
        chatAttachmentRelPath(ctx.userId, cid, name || '', null, chatAttachments.cachedConversationSpace(ctx.userId, cid)),
        'attachment',
      );
    }
    return chatAttachments.deleteAttachment(ctx.userId, cid, name || '');
  },

  'conversations.attachments.adopt': async ({ from_cid, to_cid }, ctx) => {
    if (!safeId(from_cid)) throw new Error('invalid from_cid');
    if (!safeId(to_cid)) throw new Error('invalid to_cid');
    return chatAttachments.adoptDraftAttachments(ctx.userId, from_cid, to_cid);
  },

  // Import a global Library (contexts) file into a composer draft pool —
  // the "@ Library" picker path. `cid` is the draft pool (main_chat /
  // projchat-<id>), not a real conversation yet; `relPath` is validated by
  // `resolveContextFileAbsPath` (traversal / hidden-segment / must-exist).
  'contexts.attachToDraft': async ({ relPath, cid } = {}, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    if (typeof relPath !== 'string' || !relPath.trim()) throw new Error('missing relPath');
    const absPath = contexts.resolveContextFileAbsPath(relPath);
    const st = fs.statSync(absPath);
    if (!st.isFile()) throw new Error('not_a_file');
    const res = await chatAttachments.importAttachmentFromPath(ctx.userId, cid, absPath);
    if (!res.ok) throw new Error((res as { error: string }).error);
    return { info: res.info };
  },

  // Same as above but for a space-scoped Library file — resolves through
  // `resolveSpaceFileAbsPath`, which validates space ownership + name.
  'spaces.files.attachToDraft': async ({ spaceId, name, cid } = {}, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    if (!safeId(spaceId)) throw new Error('invalid spaceId');
    if (typeof name !== 'string' || !name.trim()) throw new Error('missing name');
    const resolved = await spaceFiles.resolveSpaceFileAbsPath(ctx.userId, spaceId, name);
    if (!resolved.ok) throw new Error((resolved as { error?: string }).error || 'not_found');
    const res = await chatAttachments.importAttachmentFromPath(ctx.userId, cid, resolved.absPath);
    if (!res.ok) throw new Error((res as { error: string }).error);
    return { info: res.info };
  },

  // ── Chat artifacts (interactive web-app bundles, served via chat-app://) ──
  // Open the artifact's index.html in the OS default browser (a `file://`
  // URL via `shell.openPath`). Path is resolved through
  // `chatArtifacts.resolveArtifactFilePath` so caller-supplied cid /
  // artifactId can only ever reach a file inside that artifact's pool.
  'conversations.artifacts.openExternal': async ({ cid, artifactId }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const r = chatArtifacts.resolveArtifactFilePath(ctx.userId, String(cid), String(artifactId || ''), 'index.html');
    if (!r.ok) throw new Error((r as { error?: string }).error || 'artifact not found');
    const absPath = (r as { absPath: string }).absPath;
    const err = await shell.openPath(absPath);
    if (err) throw new Error(err);
    return { ok: true, path: absPath };
  },
  // Read-only health check used by the renderer to avoid displaying a stale
  // compacted-history preview as if it were a real interactive app.
  'conversations.artifacts.inspect': async ({ cid, artifactId }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return chatArtifacts.inspectArtifactIndex(ctx.userId, String(cid), String(artifactId || ''));
  },
  // ── Agents ──
  'agents.list': async ({ summary } = {}) => {
    // P3394 local peers and AI team Agents share one directory. Reconcile
    // online peers before every directory read so a live external node cannot
    // remain invisible merely because its projection callback was missed.
    try {
      const { syncP3394TeamDirectory } = await import('../features/p3394_bridge/app-wiring');
      await syncP3394TeamDirectory();
    } catch {
      // Directory reads remain available if the bridge is not active yet.
    }
    // `force` is a renderer-cache concern: callers may need a fresh payload,
    // but ordinary navigation must not delete the validated on-disk Agent
    // catalog and reopen every agent.json. Actual definition mutations,
    // marketplace reconcile and sync already invalidate the main cache at
    // their write boundary.
    let agentList = summary === true || summary === '1'
      ? await agents.listAgentSummaries()
      : await agents.listAgents();

    // 引导未完成时，过滤掉所有 CLI Agent（claude/codex/opencode/workbuddy）
    // 只有用户在引导中主动"连接"后，这些 Agent 才可见可用
    if (!onboardingState.getOnboardingCompleted()) {
      agentList = agentList.filter((agent) => {
        const runtime = agent && agent.runtime;
        // 过滤掉所有 CLI 类型的 Agent
        if (runtime && (runtime.kind === 'cli' || runtime.kind === 'p3394-gateway')) {
          return false;
        }
        return true;
      });
    }

    return { agents: agentList };
  },

  'agents.get': async ({ agent_id }) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    const agent = await agents.getAgent(agent_id);
    if (!agent) throw new Error('agent not found');
    return { agent };
  },

  // 「查看继承内容」入口。inheritance 为 null 表示这个 Agent 生成时还没有继承
  // 机制，渲染层必须把它和「继承为空」分开说，不能都显示成没继承任何东西。
  'agents.inheritance': async ({ agent_id } = {}, ctx) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    const { readAgentInheritance } = await import('../features/agent_inheritance');
    return { ok: true, inheritance: await readAgentInheritance(ctx.userId, agent_id) };
  },

  'agents.create': async ({ name = '', description = '', description_zh, description_en, workflow = '', icon, color, runtime, category, output_format } = {}) => {
    return { agent: await agents.createCustomAgent({ name, description, description_zh, description_en, workflow, icon, color, runtime, category, output_format }) };
  },


  'agents.update': async ({ agent_id, updates }) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    const data = await agents.updateCustomAgent(agent_id, updates || {});
    if (!data) throw new Error('agent not found or read-only');
    return { agent: data };
  },

  'agents.delete': async ({ agent_id }, ctx) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    // P3394 外接智能体删除联动：先停掉其受管网关（否则节点会因心跳复活），
    // 再清掉团队投影映射（按 agent_id 清，覆盖 nodeId ≠ cli 的自报节点，
    // 避免残留映射让下次 hello 复用已删除的记录 / 重建同名 agent），最后
    // 抑制该节点的自动投影——孤儿网关进程的 hello 不得自动重建同名 agent。
    // 同 CLI 允许多个外接 agent 共享同一个受管网关：只有该 CLI 不再被任何
    // 剩余 agent 引用时才允许停进程与投影抑制，否则删一个会连累另一个。
    try {
      const target = await agents.getAgent(agent_id);
      const rt = target?.runtime as { kind?: string; cli?: string } | undefined;
      if (rt && rt.kind === 'p3394-gateway' && rt.cli) {
        const remaining = await agents.countP3394GatewayAgentsByCli(rt.cli, { excludeAgentId: agent_id });
        if (remaining === 0) {
          const { stopExternalGateway } = await import('../features/p3394_bridge/external-gateways');
          await stopExternalGateway(rt.cli);
          const { removeProjectionsForAgent, suppressNodeProjection } = await import('../features/p3394_bridge/team-projection');
          removeProjectionsForAgent(agent_id);
          suppressNodeProjection(rt.cli);
        } else {
          // 同 CLI 还有其他外接 agent：只清自己这条投影映射，不碰共享网关，
          // 也不抑制该节点的自动投影（剩余 agent 仍需靠 hello 复用映射）。
          const { removeProjectionsForAgent } = await import('../features/p3394_bridge/team-projection');
          removeProjectionsForAgent(agent_id);
        }
      }
    } catch (error) {
      log.warn('P3394 gateway stop on agent delete failed', { agent_id, error: error instanceof Error ? error.message : String(error) });
    }
    await recycleBin.createAppRecycleBatchForAgent(ctx.userId, agent_id);
    const deleted = await agents.deleteCustomAgent(agent_id);
    return { ok: true, deleted };
  },

  // Per-user enable/disable toggle. enabled=true clears the override; both
  // builtin and custom agents are toggleable (it's a personal preference,
  // not a spec mutation). Returns the resolved state for the renderer to
  // confirm the new value.
  'agents.setEnabled': async ({ agent_id, enabled }) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
    // P3394 外接智能体停用联动：禁用即停托管网关（否则网关心跳继续、
    // peer 保持 online，与"已停用"的 UI 状态矛盾）；重新启用按需自愈
    // （下一次 turn 的 runP3394GatewayTurn 会自动拉起）。
    if (!enabled) {
      try {
        const target = await agents.getAgent(agent_id);
        const rt = target?.runtime as { kind?: string; cli?: string } | undefined;
        if (rt && rt.kind === 'p3394-gateway' && rt.cli) {
          // 同 CLI 允许多个外接 agent 共享网关：停用其中一个时，只有该
          // CLI 不再被任何剩余 agent 引用才停进程（否则禁用一个会把仍在
          // 使用的共享网关一并关掉）。
          const remaining = await agents.countP3394GatewayAgentsByCli(rt.cli, { excludeAgentId: agent_id });
          if (remaining === 0) {
            const { stopExternalGateway } = await import('../features/p3394_bridge/external-gateways');
            await stopExternalGateway(rt.cli);
          }
        }
      } catch (error) {
        log.warn('P3394 gateway stop on agent disable failed', { agent_id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    agents.setAgentEnabledForActiveUser(agent_id, enabled);
    return { ok: true, enabled };
  },

  'agents.cliProjectDir.get': async ({ agent_id }, ctx) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    const info = await agents.getAgentCliProjectDirInfo(ctx.userId, agent_id);
    if (!info) throw new Error('agent not found');
    return { info };
  },

  'agents.cliProjectDir.set': async ({ agent_id, path: dirPath = '' }, ctx) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    if (typeof dirPath !== 'string') throw new Error('path must be string');
    const info = await agents.setAgentCliProjectDir(ctx.userId, agent_id, dirPath);
    if (!info) throw new Error('agent not found');
    return { info };
  },

  'agents.chat.history': async ({ agent_id, limit = 500 }, ctx) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    if (!(await agents.getAgent(agent_id))) throw new Error('agent not found');
    return { messages: await agents.getAgentChatMessages(ctx.userId, agent_id, limit) };
  },

  'agents.chat.clear': async ({ agent_id }, ctx) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    return { cleared: await agents.clearAgentChat(ctx.userId, agent_id) };
  },

  'agents.chat.send': async ({ agent_id, content, model_text, attachments }, ctx) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    const text = (content || '').trim();
    if (!text) throw new Error('empty message');
    const modelText = typeof model_text === 'string' ? model_text.trim() : '';
    const atts = Array.isArray(attachments) ? attachments.filter((n: any) => typeof n === 'string' && n) : [];
    return agents.sendToAgentEditChat(ctx.userId, agent_id, text, {
      ...(atts.length ? { attachments: atts } : {}),
      ...(modelText ? { modelText } : {}),
    });
  },

  // ── Personal Ontology Groups ("记忆分组") ──
  'personalOntology.groups.list': async (_payload, ctx) => {
    const groups = await personalOntologyGroups.listGroups(ctx.userId);
    // 运行时附加模板显示名（渲染层层级展示用，不落盘）。显示名的唯一来源是
    // contract 的目录条目——不再让调用方各自查 T-box 常量。
    const contract = await import('../features/personal_ontology_contract');
    for (const g of groups) {
      if (!g.template_id) continue;
      const entry = contract.getRoleTemplateCatalogEntry(g.template_id);
      if (entry) g.template_name = entry.name;
    }
    return { groups };
  },
  'personalOntology.groups.create': async ({ title }, ctx) => {
    if (!title || typeof title !== 'string') throw new Error('missing title');
    return personalOntologyGroups.createGroup(ctx.userId, title);
  },
  'personalOntology.groups.rename': async ({ groupId, title }, ctx) => {
    if (!groupId || typeof groupId !== 'string') throw new Error('missing groupId');
    if (!title || typeof title !== 'string') throw new Error('missing title');
    return personalOntologyGroups.renameGroup(ctx.userId, groupId, title);
  },
  'personalOntology.groups.delete': async ({ groupId }, ctx) => {
    if (!groupId || typeof groupId !== 'string') throw new Error('missing groupId');
    return personalOntologyGroups.deleteGroup(ctx.userId, groupId);
  },
  'personalOntology.groups.read': async ({ groupId }, ctx) => {
    if (!groupId || typeof groupId !== 'string') throw new Error('missing groupId');
    // 三种入参都要读得出来：contract opaque ref（@ Picker 新路径）、复合 id
    // （groupId::分节，历史草稿里的存量 token）、普通 group id。readOntologyEntry
    // 内部按 ref 前缀分流后统一走 readContentById，chat-use 侧零改动。
    const contract = await import('../features/personal_ontology_contract');
    return contract.readOntologyEntry(ctx.userId, groupId);
  },
  'personalOntology.groups.write': async ({ groupId, content }, ctx) => {
    if (!groupId || typeof groupId !== 'string') throw new Error('missing groupId');
    return personalOntologyGroups.writeGroupContent(ctx.userId, groupId, String(content ?? ''));
  },

  // 可 @ 引用的本体条目（普通分组 + 已安装模板的分节）。返回的 ref 是
  // PO contract 生成的 opaque 句柄：渲染层原样存、原样回传，不解析、不拼接。
  'personalOntology.entries.list': async (_payload, ctx) => {
    const contract = await import('../features/personal_ontology_contract');
    return { entries: await contract.listOntologyEntries(ctx.userId) };
  },

  // 可写入的角色模板字段落点（已安装 ∩ T-box）。targets[].fieldRef 是 opaque
  // 写入句柄，调用方只回传它；label 已拼好，渲染层不重组显示名。
  'personalOntology.templates.fieldTargets': async (_payload, ctx) => {
    const contract = await import('../features/personal_ontology_contract');
    return { targets: await contract.listRoleTemplateFieldTargets(ctx.userId) };
  },

  // ── Personal Ontology Role Templates (角色模板) ──
  'personalOntology.templates.list': async (_payload, ctx) => {
    return { templates: await personalOntologyTemplateFiles.listTemplateStatus(ctx.userId) };
  },
  'personalOntology.profile.syncRecall': async (_payload, ctx) => {
    return { ok: true, ...(await recallProfileSync.schedulePersonalProfileSync(ctx.userId)) };
  },
  'personalOntology.templates.install': async ({ templateId, restoreData }, ctx) => {
    if (!templateId || typeof templateId !== 'string') throw new Error('missing templateId');
    return personalOntologyTemplateFiles.installTemplateFile(ctx.userId, templateId, restoreData === true);
  },
  'personalOntology.templates.hasArchive': async ({ templateId }, ctx) => {
    if (!templateId || typeof templateId !== 'string') throw new Error('missing templateId');
    return {
      hasArchive: personalOntologyTemplateFiles.templateHasArchive(ctx.userId, templateId),
      hasMemoryArchive: personalOntologyTemplateFiles.templateHasMemoryArchive(ctx.userId, templateId),
    };
  },
  'personalOntology.templates.uninstall': async ({ templateId, archiveMemory }, ctx) => {
    if (!templateId || typeof templateId !== 'string') throw new Error('missing templateId');
    return personalOntologyTemplateFiles.uninstallTemplateFile(ctx.userId, templateId, archiveMemory === true);
  },

  // ── Personal Ontology Group Fields (挖空表单字段，兼容复合 id) ──
  'personalOntology.groups.fields.list': async ({ groupId }, ctx) => {
    if (!groupId || typeof groupId !== 'string') throw new Error('missing groupId');
    return personalOntologyTemplateFiles.listFieldsByRef(ctx.userId, groupId);
  },
  'personalOntology.groups.fields.append': async ({ groupId, fieldName, value, source }, ctx) => {
    if (!groupId || typeof groupId !== 'string') throw new Error('missing groupId');
    if (!fieldName || typeof fieldName !== 'string') throw new Error('missing fieldName');
    if (typeof value !== 'string') throw new Error('missing value');
    return personalOntologyTemplateFiles.appendFieldValueToRef(ctx.userId, groupId, fieldName, value, typeof source === 'string' ? source : '手动');
  },
  'personalOntology.groups.fields.setValue': async ({ groupId, fieldName, value, oldValue }, ctx) => {
    if (!groupId || typeof groupId !== 'string') throw new Error('missing groupId');
    if (!fieldName || typeof fieldName !== 'string') throw new Error('missing fieldName');
    if (typeof value !== 'string') throw new Error('missing value');
    return personalOntologyTemplateFiles.setFieldValueToRef(ctx.userId, groupId, fieldName, String(oldValue ?? ''), value);
  },
  'personalOntology.groups.fields.removeValue': async ({ groupId, fieldName, value }, ctx) => {
    if (!groupId || typeof groupId !== 'string') throw new Error('missing groupId');
    if (!fieldName || typeof fieldName !== 'string') throw new Error('missing fieldName');
    if (typeof value !== 'string') throw new Error('missing value');
    return personalOntologyTemplateFiles.removeFieldValueToRef(ctx.userId, groupId, fieldName, value);
  },
  'personalOntology.groups.fields.remove': async ({ groupId, fieldName }, ctx) => {
    if (!groupId || typeof groupId !== 'string') throw new Error('missing groupId');
    if (!fieldName || typeof fieldName !== 'string') throw new Error('missing fieldName');
    return personalOntologyTemplateFiles.removeFieldToRef(ctx.userId, groupId, fieldName);
  },

  // ── Personal Ontology Group Entries (流水区，兼容复合 id) ──
  'personalOntology.groups.entries.remove': async ({ groupId, entryText }, ctx) => {
    if (!groupId || typeof groupId !== 'string') throw new Error('missing groupId');
    if (typeof entryText !== 'string') throw new Error('missing entryText');
    return personalOntologyTemplateFiles.removeEntryToRef(ctx.userId, groupId, entryText);
  },
  'personalOntology.groups.entries.promote': async ({ groupId, entryText, fieldName }, ctx) => {
    if (!groupId || typeof groupId !== 'string') throw new Error('missing groupId');
    if (typeof entryText !== 'string') throw new Error('missing entryText');
    if (!fieldName || typeof fieldName !== 'string') throw new Error('missing fieldName');
    return personalOntologyTemplateFiles.promoteEntryToRef(ctx.userId, groupId, entryText, fieldName);
  },

  // ── 桥接注册：renderer 引用但漏注册的通道（纯转发到现成能力，
  //  零逻辑变更；功能等同 renderer 期望语义）。──
  'agents.builtin.delete': async ({ agent_id }, ctx) => {
    if (!agent_id || typeof agent_id !== 'string') throw new Error('missing agent_id');
    return marketplace.uninstallMarketplaceAgent(agent_id);
  },

  'skills.builtin.delete': async ({ id }, ctx) => {
    if (!id || typeof id !== 'string') throw new Error('missing id');
    return marketplace.uninstallMarketplaceSkill(id);
  },

  'spaces.files.officeHtml': async ({ spaceId, name }, ctx) => {
    if (!spaceId || typeof spaceId !== 'string') throw new Error('missing spaceId');
    if (!name || typeof name !== 'string') throw new Error('missing name');
    return spaceFiles.readSpaceOfficeHtml(ctx.userId, spaceId, name);
  },

  'prefs.getTaskNotifications': async () => ({
    ok: true,
    enabled: appConfig.getTaskNotificationsEnabled(),
  }),

  'prefs.setTaskNotifications': async ({ enabled }) => {
    appConfig.setTaskNotificationsEnabled(enabled === true);
    return { ok: true, enabled: appConfig.getTaskNotificationsEnabled() };
  },

  'prefs.openTaskNotificationSettings': async () => {
    const url = notificationPermissions.systemNotificationSettingsUrl(process.platform, app.getName());
    if (url) void shell.openExternal(url);
    return { ok: true };
  },

  'skills.list': async ({ force } = {}) => {
    if (force === true || force === '1') skills.clearSkillListCache();
    return { skills: await skills.listSkills() };
  },

  'skills.read': async ({ source, id, file = 'SKILL.md' }) => {
    if (source !== 'marketplace' && source !== 'builtin' && source !== 'custom') throw new Error('invalid source');
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    return skills.readSkillFile(source, id, file);
  },

  'skills.checkDeclaration': async ({ id }, ctx) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    const found = await skills.getSkillForEdit(id);
    if (!found || found.source !== 'custom') throw new Error('only custom skills can be pre-checked');
    const declarationCheck = await skillReverify.checkDeclaration(found.dir, id);
    return { declarationCheck };
  },

  /** Deep re-verify one installed skill and persist the verdict. Backs the
   *  "重新检查" action on the skills panel. */
  'skills.trust.reverify': async ({ skillId } = {}, ctx) => {
    if (!skills.isValidSkillId(skillId)) throw new Error('invalid skill id');
    return { result: await skillReverify.reverifySkillDeep(ctx.userId, skillId) };
  },

  /** Receipts on record, for a trust/audit surface. */
  'skills.trust.list': async (_args, ctx) => {
    return { receipts: skillTrust.listReceipts(ctx.userId) };
  },

  /** W5/W6: run the generation admission gate on one custom skill and return
   *  a renderer-safe verdict for the unified import-check popup. Source-
   *  preserving: no shape escalation, no refusal receipt — the caller decides
   *  what to do with the verdict (the import paths already rolled back or
   *  kept content in main). */
  'skills.admit': async ({ skillId }, ctx) => {
    if (!skills.isValidSkillId(skillId)) throw new Error('invalid skill id');
    const { admitCustomSkill } = await import('../features/security/custom-skill-admission');
    const admission = await admitCustomSkill(ctx.userId, skillId);
    return {
      admission: {
        outcome: admission.outcome,
        reason: admission.reason ?? null,
        escalatedSkillShape: admission.escalatedSkillShape,
        ...(admission.scan ? { scan: admission.scan } : {}),
      },
    };
  },

  /** Guardrail status snapshot for the 安全与信任 settings page. Coarse
   *  status/version data only — no findings text, no paths. */
  'skills.security.status': async () => {
    const { guardrailStatus } = await import('../features/security/guardrail-status');
    return { status: guardrailStatus() };
  },

  'skills.writeFile': async ({ id, file, content }) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    if (!file) throw new Error('missing file');
    // Routes to custom in normal mode; in dev, built-in writes are accepted
    // and dual-write (src + data) via the dev module.
    const ok = await skills.writeSkillFileForEdit(id, file, content || '');
    if (!ok) throw new Error(t('errors.skill_write_failed'));
    return { written: true };
  },

  'skills.tree': async ({ source, id }) => {
    if (source !== 'marketplace' && source !== 'builtin' && source !== 'custom') throw new Error('invalid source');
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    return skills.listSkillTree(source, id);
  },

  'skills.create': async ({ name, description, category }) => {
    return { skill: await skills.createCustomSkill(name, description || '', category || '') };
  },

  'skills.pickImportDir': async () => {
    // Runs in main; show a native directory picker attached to the focused
    // BrowserWindow so the dialog is modal to CogSeed.
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      title: t('dialog.choose_skill_source_directory'),
    };
    const res = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths?.length) return { cancelled: true };
    return { cancelled: false, path: res.filePaths[0] };
  },

  'skills.createFromUrl': async ({ name, description, url }) => {
    const r = await skills.createFromUrl(name ?? null, description ?? null, String(url || ''));
    if (!r.ok) return r;
    return { skill: r.skill, skills: r.skills, seedModelText: r.seedModelText, seedMessage: r.seedMessage };
  },

  'skills.createFromDir': async ({ name, description, srcDir, force }) => {
    const r = await skills.createFromDir(name ?? null, description ?? null, String(srcDir || ''), { force: force === true });
    if (!r.ok) return r;
    // Forward the scan evidence on success too: the unified import-check
    // popup shows the verdict for folder imports, and a pass with no visible
    // evidence is indistinguishable from no check at all.
    return {
      skill: r.skill, skills: r.skills, seedModelText: r.seedModelText, seedMessage: r.seedMessage,
      ...(r.securityPass ? { securityPass: r.securityPass } : {}),
      ...(r.securityScan ? { securityScan: r.securityScan } : {}),
      ...(r.securityBlocked === true ? { securityBlocked: true } : {}),
      ...(r.securityUnavailable === true ? { securityUnavailable: true } : {}),
    };
  },

  'skills.discardImportDraft': async ({ id }) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    return { discarded: await skills.discardImportDraftIfPristine(id) };
  },

  'skills.update': async ({ id, updates, skipRename }) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    const data = await skills.updateCustomSkill(id, updates || {}, { skipRename: !!skipRename });
    if (!data) throw new Error('skill not found');
    return { skill: data };
  },

  'skills.updateForEdit': async ({ id, updates }) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    const data = await skills.applySkillMetadataForEdit(id, updates || {});
    if (!data.ok) {
      return {
        ok: false,
        error: data.reason || 'skill not found or read-only',
        report: data.report,
      };
    }
    return {
      skill: { id: data.skillId, name: data.name },
      written: data.written,
      report: data.report,
    };
  },

  'skills.delete': async ({ id }, ctx) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    await recycleBin.createAppRecycleBatchForSkill(ctx.userId, id);
    return { deleted: await skills.deleteCustomSkill(id) };
  },

  // Per-user enable/disable toggle. Builtin and custom both toggleable (it's
  // a personal preference, not a spec mutation). Wrapper handles the
  // _invalidateSkillListCache + invalidateCoreAgentSkills chain so the next
  // runner build re-renders the skills system-prompt block.
  'skills.setEnabled': async ({ id, enabled }) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
    skills.setSkillEnabledForActiveUser(id, enabled);
    return { ok: true, enabled };
  },

  'skills.get': async ({ id }) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    const skill = await skills.getCustomSkill(id);
    if (!skill) throw new Error('skill not found');
    return { skill };
  },

  'skills.chat.history': async ({ id, limit = 500 }, ctx) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    if (!(await skills.getSkillForEdit(id))) throw new Error('skill not found');
    return { messages: await skills.getSkillChatMessages(ctx.userId, id, limit) };
  },

  'skills.chat.clear': async ({ id }, ctx) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    return { cleared: await skills.clearSkillChat(ctx.userId, id) };
  },

  'skills.chat.send': async ({ id, content, model_text, attachments }, ctx) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    const text = (content || '').trim();
    if (!text) throw new Error('empty message');
    const modelText = typeof model_text === 'string' ? model_text.trim() : '';
    const atts = Array.isArray(attachments) ? attachments.filter((n: any) => typeof n === 'string' && n) : [];
    return skills.sendToSkillChat(ctx.userId, id, text, {
      ...(atts.length ? { attachments: atts } : {}),
      ...(modelText ? { modelText } : {}),
    });
  },

  // ── Marketplace ──
  // Listing + detail + install endpoints hit the public Server catalog; categories are served
  // from the local biz cache when callers pass `local_only`, otherwise refreshed on stale cache.
  'marketplace.categories': async (opts = {}) => ({
    list: await marketplaceBiz.getMarketplaceCategories({
      localOnly: !!opts.local_only,
      forceRefresh: !!opts.force_refresh,
    }),
  }),

  'marketplace.listAgents': async (opts = {}) => marketplace.listMarketplaceAgents(opts),

  'marketplace.listSkills': async (opts = {}) => marketplace.listMarketplaceSkills(opts),

  // Curated open-source projects catalog (read-only). Returns { list, total, categories }.
  'marketplace.listProjects': async (opts = {}) => marketplace.listMarketplaceProjects(opts),

  // Detail endpoints (cache-first) — used by the marketplace panel's detail view to render
  // full content. Caller passes the list-row's (version, freshness timestamp) so we can short-circuit
  // on a hot cache. Sweep is invoked once per openMarketplace at the entry point.
  'marketplace.detailAgent': async ({ id, version, published_at, updated_at, min_app_version, minAppVersion, min_version, minVersion, min_pc_version, minPcVersion }) => {
    if (!id || typeof id !== 'string') throw new Error('id required');
    if (typeof version !== 'string' || typeof published_at !== 'number') {
      throw new Error('version + published_at required');
    }
    return marketplace.getAgentDetail(id, {
      version, published_at,
      ...(typeof updated_at === 'number' ? { updated_at } : {}),
      ...(typeof min_app_version === 'string' ? { min_app_version } : {}),
      ...(typeof minAppVersion === 'string' ? { minAppVersion } : {}),
      ...(typeof min_version === 'string' ? { min_version } : {}),
      ...(typeof minVersion === 'string' ? { minVersion } : {}),
      ...(typeof min_pc_version === 'string' ? { min_pc_version } : {}),
      ...(typeof minPcVersion === 'string' ? { minPcVersion } : {}),
    });
  },

  'marketplace.detailSkill': async ({ id, version, published_at, updated_at, min_app_version, minAppVersion, min_version, minVersion, min_pc_version, minPcVersion }) => {
    if (!id || typeof id !== 'string') throw new Error('id required');
    if (typeof version !== 'string' || typeof published_at !== 'number') {
      throw new Error('version + published_at required');
    }
    return marketplace.getSkillDetail(id, {
      version, published_at,
      ...(typeof updated_at === 'number' ? { updated_at } : {}),
      ...(typeof min_app_version === 'string' ? { min_app_version } : {}),
      ...(typeof minAppVersion === 'string' ? { minAppVersion } : {}),
      ...(typeof min_version === 'string' ? { min_version } : {}),
      ...(typeof minVersion === 'string' ? { minVersion } : {}),
      ...(typeof min_pc_version === 'string' ? { min_pc_version } : {}),
      ...(typeof minPcVersion === 'string' ? { minPcVersion } : {}),
    });
  },

  'marketplace.installAgent': async ({ id, name, version, published_at, updated_at, min_app_version, minAppVersion, min_version, minVersion, min_pc_version, minPcVersion, force, acceptSecurityRisk }) => {
    if (!id || typeof id !== 'string') throw new Error('id required');
    if (typeof version !== 'string' || typeof published_at !== 'number') {
      throw new Error('version + published_at required');
    }
    return marketplace.installMarketplaceAgent(id, {
      version, published_at,
      ...(typeof updated_at === 'number' ? { updated_at } : {}),
      ...(typeof min_app_version === 'string' ? { min_app_version } : {}),
      ...(typeof minAppVersion === 'string' ? { minAppVersion } : {}),
      ...(typeof min_version === 'string' ? { min_version } : {}),
      ...(typeof minVersion === 'string' ? { minVersion } : {}),
      ...(typeof min_pc_version === 'string' ? { min_pc_version } : {}),
      ...(typeof minPcVersion === 'string' ? { minPcVersion } : {}),
    }, { force: force === true, name: typeof name === 'string' ? name : undefined, acceptSecurityRisk: acceptSecurityRisk === true });
  },

  'marketplace.installSkill': async ({ id, name, version, published_at, updated_at, min_app_version, minAppVersion, min_version, minVersion, min_pc_version, minPcVersion, force, acceptSecurityRisk }) => {
    if (!id || typeof id !== 'string') throw new Error('id required');
    if (typeof version !== 'string' || typeof published_at !== 'number') {
      throw new Error('version + published_at required');
    }
    return marketplace.installMarketplaceSkill(id, {
      version, published_at,
      ...(typeof updated_at === 'number' ? { updated_at } : {}),
      ...(typeof min_app_version === 'string' ? { min_app_version } : {}),
      ...(typeof minAppVersion === 'string' ? { minAppVersion } : {}),
      ...(typeof min_version === 'string' ? { min_version } : {}),
      ...(typeof minVersion === 'string' ? { minVersion } : {}),
      ...(typeof min_pc_version === 'string' ? { min_pc_version } : {}),
      ...(typeof minPcVersion === 'string' ? { minPcVersion } : {}),
    }, { force: force === true, name: typeof name === 'string' ? name : undefined, acceptSecurityRisk: acceptSecurityRisk === true });
  },

  // Uninstall is non-dev: wipes the local install copy + manifest entry. Does NOT touch the
  // server row (`marketplace_dev.deleteMarketplace*` does that, dev-only).
  'marketplace.uninstallAgent': async ({ id }) => {
    if (!id || typeof id !== 'string') throw new Error('id required');
    return marketplace.uninstallMarketplaceAgent(id);
  },

  'marketplace.uninstallSkill': async ({ id }) => {
    if (!id || typeof id !== 'string') throw new Error('id required');
    return marketplace.uninstallMarketplaceSkill(id);
  },

  // Entry-point housekeeping for the marketplace panel: sweep stale + over-sized cache entries.
  // Cheap (O(N entries) stat), so it's safe to call once per openMarketplace from the renderer.
  'marketplace.sweepCache': async () => ({ bytes_freed: await marketplaceCache.sweepIfNeeded() }),

  // Renderer queries this once at startup to learn the current reconcile state, then subscribes
  // to push-events `marketplace:reconcile-status` for in-flight progress. See main/index.ts
  // boot wiring + features/marketplace_reconcile.ts::subscribeReconcileStatus.
  'marketplace.reconcileStatus': async () => marketplaceReconcile.getReconcileStatus(),

  // Persistent listing-grid cache so cold starts don't show a blank panel. Renderer hydrates
  // from this on `openMarketplace` and writes back after every fresh /list response. See
  // `marketplace_cache.ts::{getListingsCache,setListingsCache}`.
  'marketplace.getListingsCache': async () => marketplaceCache.getListingsCache(),

  'marketplace.setListingsCache': async ({ entries }) => {
    if (!entries || typeof entries !== 'object') throw new Error('entries required');
    await marketplaceCache.setListingsCache(entries);
    return { ok: true as const };
  },

  'marketplace.mergeListingsCache': async ({ entries }) => {
    if (!entries || typeof entries !== 'object') throw new Error('entries required');
    await marketplaceCache.mergeListingsCache(entries);
    return { ok: true as const };
  },

  // Detail-page file viewer (skill kind only — agent payload is fully in the detail response).
  'marketplace.cacheSkillFiles': async ({ id }) => {
    if (!id || typeof id !== 'string') throw new Error('id required');
    return { list: await marketplaceCache.listSkillCacheFiles(id) };
  },

  'marketplace.cacheSkillRead': async ({ id, file }) => {
    if (!id || typeof id !== 'string') throw new Error('id required');
    if (!file || typeof file !== 'string') throw new Error('file required');
    const content = await marketplaceCache.readSkillCacheFile(id, file);
    return { content: content || '' };
  },

  // ── Global recycle bin (sync tombstones + in-app deletes) ──
  'recycle.list': async (_payload, ctx) => ({
    batches: await recycleBin.listRecycleBatches(ctx.userId),
  }),

  'recycle.restore': async ({ id }, ctx) => {
    const res = await recycleBin.restoreRecycleBatch(ctx.userId, String(id || ''));
    if (!res.batch) throw _codedError('recycle_batch_not_found');
    const changed = Array.from(new Set([
      ...res.restored_paths,
      ...res.skipped_paths,
      ...res.reactivated_paths,
    ]));
    await _afterRecycleRestore(ctx, changed);
    return {
      ok: true,
      restored: changed.length,
      restored_paths: res.restored_paths,
      skipped_paths: res.skipped_paths,
      failed_paths: res.failed_paths,
      reactivated_paths: res.reactivated_paths,
    };
  },

  'recycle.delete': async ({ id }, ctx) => {
    const { deleted } = await recycleBin.deleteRecycleBatch(ctx.userId, String(id || ''));
    return { deleted };
  },

  // ── Cache (clearable umbrella under `<uid>/local/cache/<bucket>/`) ──
  'cache.listClearable': async () => ({ list: await cacheClearable.listClearableBuckets() }),

  'cache.clearBucket': async ({ name }) => {
    if (!name || typeof name !== 'string') throw new Error('name required');
    return { bytes_freed: await cacheClearable.clearBucket(name) };
  },

  'cache.clearAll': async () => ({ bytes_freed: await cacheClearable.clearAllClearable() }),

  // ── Contexts (user-owned directory tree; vectorized via kb_indexer) ──
  'contexts.tree': async () => ({ tree: await contexts.listContextsTree() }),

  'contexts.read': async ({ path }) => {
    return contexts.readContextFile(path || '');
  },

  'contexts.index': async () => ({
    markdown: await contexts.getContextIndexMarkdown(),
    entries: await contexts.getContextIndexEntries(),
  }),

  // Create / overwrite a text file (md/txt/json/...).
  'contexts.write': async ({ path, content }) => {
    return contexts.writeContextFile(path || '', content || '');
  },

  // Edit an existing text file (refuses to create).
  'contexts.update': async ({ path, content }) => {
    return contexts.updateContextFile(path || '', content || '');
  },

  // Save an uploaded file (binary-safe: pdf / docx / image / text). The shim
  // encodes the target path in the `X-Filename` header and turns it into
  // `name` on this side; payload may also arrive with an explicit `path`
  // (direct programmatic callers). `data` is base64 (renderer can't cross
  // contextBridge with Buffer).
  'contexts.upload': async (payload) => {
    const target = payload?.path || payload?.name || '';
    const data = payload?.data;
    if (typeof data === 'string' && data.length > 12 * 1024 * 1024) {
      return { ok: false, error: 'large uploads require path-based import', code: 'E_IMPORT_PATH_REQUIRED' };
    }
    const buf = typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.from(data || []);
    return contexts.uploadContextFile(target, buf);
  },

  'contexts.pickAndUpload': async ({ targetDir } = {}) => {
    const picked = await _pickLocalFiles('Choose files', CONTEXT_PICK_EXTENSIONS, true, /* seedWorkspaceOnFirstOpen */ true);
    const results = [];
    for (const filePath of picked) {
      const name = path.basename(filePath);
      const ext = path.extname(name).toLowerCase();
      let bytes = 0;
      try { bytes = fs.statSync(filePath).size; } catch { bytes = 0; }
      try {
        const target = _targetInDir(targetDir, name);
        if (contexts.hasHiddenContextPathSegment(target)) {
          results.push({ ok: false, name, target, bytes, ext, reason: 'hidden' });
          continue;
        }
        if (!contexts.isSupportedContextFileName(target)) {
          results.push({ ok: false, name, target, bytes, ext, reason: 'ext' });
          continue;
        }
        const res = await contexts.importContextFileFromPath(target, filePath);
        results.push({ name, target, bytes, ext, ...res });
      } catch (err) {
        results.push({ ok: false, name, bytes, ext, error: (err as Error)?.message || String(err) });
      }
    }
    return { files: results };
  },

  'contexts.mkdir': async ({ path }) => {
    return contexts.createContextDir(path || '');
  },

  'contexts.rename': async ({ src, dst }) => {
    return contexts.renameContextEntry(src || '', dst || '');
  },

  'contexts.delete': async ({ path }, ctx) => {
    const target = path || '';
    if (!target.trim()) return contexts.deleteContextTarget(target);
    await recycleBin.createAppRecycleBatchForCloudEntry(
      ctx.userId,
      `cloud/contexts/${target}`,
      'context',
    );
    const result = contexts.deleteContextTarget(target);
    if (result.ok && result.deletedPaths.length) {
      const { recordRemovedContextFiles } = await import('../features/recall/source-removal');
      const sourceRemoval = await recordRemovedContextFiles(ctx.userId, result.deletedPaths);
      return { ...result, sourceRemoval };
    }
    return result;
  },

  // Read an image file's bytes for inline viewer display.
  'contexts.image': async ({ path }) => {
    return contexts.readContextImage(path || '');
  },

  // Render a .docx as HTML (via mammoth) for the inline preview pane.
  'contexts.docxHtml': async ({ path }) => {
    return contexts.readContextDocxHtml(path || '');
  },

  // Reveal a Library file in the OS file manager.
  'contexts.reveal': async ({ path }) => {
    return contexts.showContextFileInSystem(path || '');
  },

  // ── Library import compatibility layer ──
  // First migration step for the unified "Library" product surface. Produced
  // files import into the current project's file pool when the cid belongs to
  // a project; otherwise they import into the global contexts tree. Future
  // work will replace both backends with a single scope-aware library module.
  'library.importProduced': async (payload, ctx) => {
    return _importProducedToLibrary(payload, ctx);
  },

  'library.writeText': async (payload, ctx) => {
    return _writeTextToLibrary(payload, ctx);
  },

  // ── Knowledge base (vector store) ──
  // Snapshot of what's in `kb_files`: status summary + per-file rows.
  // Renderer subscribes to the `kb.events` stream (below) for incremental
  // updates; this endpoint is the initial-load / full-refresh fetch.
  'kb.status': async (_payload, ctx) => {
    const summary = kbVector.statusSummary(ctx.userId);
    const files = kbVector.listFiles(ctx.userId).map((r) => ({
      path: r.rel_path,
      kind: r.kind,
      status: r.status,
      chunks: r.chunks,
      bytes: r.bytes,
      mtime: r.mtime,
      error: r.error || undefined,
    }));
    return { summary, files };
  },

  // Force a disk-vs-db reconcile pass. Useful after users drop files into
  // contexts/ via Finder, or when vector.db is swapped out by sync and the
  // UI wants to catch up without restarting the app.
  'kb.reconcile': async (_payload, ctx) => {
    const r = await kbIndexer.reconcile(ctx.userId);
    return { result: r };
  },

  // Re-enqueue a single file (typically the UI's "reprocess" button after
  // a failed extraction).
  'kb.reprocess': async ({ path }, ctx) => {
    if (typeof path !== 'string' || !path) throw new Error('path required');
    kbIndexer.enqueue(ctx.userId, path, 'upsert');
    return { ok: true, path };
  },

  // ── Global search (knowledge base + chat history) ──
  'search.global': async ({ query, limit, scope, projectId }, ctx) => {
    return search.searchAll(ctx.userId, query || '', {
      limit: typeof limit === 'number' ? limit : 30,
      scope: scope || 'all',
      ...(typeof projectId === 'string' && safeId(projectId) ? { projectId } : {}),
    });
  },

  // ── UI language & locale tables (renderer i18n) ──
  'config.getLanguage': async () => ({ language: appConfig.getLanguage() }),
  'config.setLanguage': async ({ language }) => {
    if (!isLang(language)) throw new Error(`unsupported language: ${String(language)}`);
    const next = appConfig.setLanguage(language);
    markPreferencesDirty();
    return { language: next };
  },
  'config.getUiLanguage': async () => ({ uiLanguage: appConfig.getUiLanguage() }),
  'config.setUiLanguage': async ({ uiLanguage }) => {
    if (!isUiLang(uiLanguage)) throw new Error(`unsupported UI language: ${String(uiLanguage)}`);
    const next = appConfig.setUiLanguage(uiLanguage);
    markPreferencesDirty();
    return { uiLanguage: next };
  },
  'config.getLocales': async () => ({ tables: getRendererTables() }),

  // Avatar catalog (icons + colors + commander default) — single source of
  // truth lives in src/main/data/avatars.json. The renderer fetches once at
  // startup, then uses its local cache.
  'avatars.getCatalog': async () => ({ catalog: avatars.getCatalog() }),

  // Commander display/profile catalog. Static localized content lives in
  // src/main/data/commander.json; mutable state (avatar, memory, stats) is
  // stored separately.
  'commander.getProfile': async () => ({ profile: commanderProfile.getProfile() }),
  'commander.runtimeStats.get': async (_payload, ctx) => ({
    runtime_stats: await commanderRuntimeStats.readCommanderRuntimeStats(ctx.userId),
  }),

  // Commander avatar preference (cloud-synced). avatar = { icon, color };
  // tokens are validated against the catalog allow-list. When absent the
  // renderer falls back to the commander default (crown + gold).
  'prefs.getCommanderAvatar': async () => ({ avatar: appConfig.getCommanderAvatar() }),
  'prefs.setCommanderAvatar': async ({ icon, color }) => {
    const avatar = appConfig.setCommanderAvatar({ icon, color });
    markPreferencesDirty();
    return { avatar };
  },

  // Metacognition-level agent self-evolution toggle. Stored at
  // preferences.json::metacognition_enabled; the actual gate's single
  // source of truth is features/metacognition.isFeatureEnabled (with the
  // env kill switch on top). The env var `COGSEED_METACOGNITION='0'` always
  // overrides the UI setting.
  'prefs.getMetacognition': async () => ({
    enabled: appConfig.getMetacognitionEnabled(),
    envForcedOff: process.env.COGSEED_METACOGNITION === '0',
  }),
  'prefs.setMetacognition': async ({ enabled }) => {
    return { enabled: appConfig.setMetacognitionEnabled(!!enabled) };
  },

  // Thinking strength (reasoning effort) for chat model calls.
  'prefs.getThinkingLevel': async () => ({ level: appConfig.getThinkingLevel() }),
  'prefs.setThinkingLevel': async ({ level }) => ({ level: appConfig.setThinkingLevel(level) }),

  // First-run onboarding marker (machine-local, NOT cloud-synced — stored
  // under WS_ROOT/onboarding-state.json, shared across uids). The renderer's
  // boot.js checks `completed` after restoring the last view and lifts the
  // four-step walkthrough overlay only when it is false; the last step calls
  // setOnboarding to persist true so it never re-appears on this device.
  'prefs.getOnboarding': async () => ({
    completed: onboardingState.getOnboardingCompleted(),
  }),
  'prefs.setOnboarding': async ({ completed }: { completed?: unknown } = {}) => ({
    completed: onboardingState.setOnboardingCompleted(completed !== false),
  }),

  // Interactive-tour completion marker — PER-ACCOUNT (unlike onboarding,
  // which is machine-wide): stored under <uid>/local/config/tour-state.json,
  // so switching accounts does not re-trap a user who already finished or
  // skipped the tour on this device.
  'prefs.getTourCompleted': async (_payload, ctx) => ({
    completed: tourState.getTourCompleted(ctx.userId),
  }),
  'prefs.setTourCompleted': async (_payload, ctx) => ({
    completed: tourState.setTourCompleted(ctx.userId),
  }),

  // ── Commander CLI fallback (no API-key model configured) ──
  'prefs.getCliFallback': async (_payload, ctx) => ({
    cli: cliFallback.getCliFallback(ctx.userId),
    noticeShown: cliFallback.cliFallbackNoticeShown(ctx.userId),
  }),
  'prefs.setCliFallback': async ({ cli }: { cli?: unknown } = {}) => {
    const uid = _activeUserIdForPicker();
    if (!uid) throw new Error('no active user');
    return { cli: cliFallback.setCliFallback(uid, typeof cli === 'string' ? cli : '') };
  },
  'prefs.markCliFallbackNoticeShown': async (_payload, ctx) => {
    cliFallback.markCliFallbackNoticeShown(ctx.userId);
    return { ok: true };
  },

  // Whether ANY usable API-key model is configured (sync, cheap). The
  // renderer uses this before every commander send to decide whether to
  // fall back to the signed-in CLI agent.
  'model.hasConfigured': async () => auth.hasConfiguredModel(),
  'chat.executionCapability': async () => chatExecutionCapability.getChatExecutionCapability(),

  // ── Cognition extraction from sessions (onboarding) ──
  // Runs through a locally-detected CLI Agent (already authenticated on
  // the user's machine), so onboarding needs no API key. We prefer
  // `claude` when available, else fall back to the first available CLI.
  'cognition.extractFromSession': async ({ sessionFilePath }: { sessionFilePath?: unknown } = {}, ctx) => {
    if (typeof sessionFilePath !== 'string') throw new Error('session file path is required');
    const entries = await detectAll();
    const available = entries.filter(e => e.available);
    const chosen = available.find(e => e.type === 'claude') ?? available[0];
    if (!chosen) {
      throw new Error('未检测到可用的本地 CLI Agent。请先安装并登录 Claude Code 等 Agent 后重试。');
    }
    const { candidates, diagnostic } = await cognitionExtraction.extractCognitionsFromSession({
      sessionFilePath,
      uid: ctx.userId,
      cli: chosen.type,
    });
    return { ok: true, candidates, diagnostic, cli: chosen.type };
  },

  // ── Auth / model config (settings page) ──
  'auth.listProviders': async () => auth.listProviders(),
  'auth.listModels': async ({ provider }) => auth.listModels(provider),
  'auth.addApiKey': async ({ provider, apiKey, label, baseUrl, maxOutputTokens }) => auth.addApiKey(provider, apiKey, label, {
    ...(baseUrl ? { baseUrl } : {}),
    ...(maxOutputTokens !== undefined && maxOutputTokens !== null ? { maxOutputTokens } : {}),
  }),
  // Legacy alias; renderer migrated to auth.addApiKey.
  'auth.saveApiKey': async ({ provider, apiKey, label, baseUrl, maxOutputTokens }) => auth.saveApiKey(provider, apiKey, label, {
    ...(baseUrl ? { baseUrl } : {}),
    ...(maxOutputTokens !== undefined && maxOutputTokens !== null ? { maxOutputTokens } : {}),
  }),
  'auth.renameProfile': async ({ profileId, label }) => auth.renameProfile(profileId, label),
  'auth.removeCredential': async ({ profileId }) => auth.removeCredential(profileId),
  'auth.testConnection': async ({ provider, model, profileId }) => auth.testConnection(provider, model, profileId),
  'auth.getConfig': async () => auth.getConfig(),
  'auth.hasConfiguredModel': async () => auth.hasConfiguredModel(),
  'auth.getProfilesStoreStatus': async () => auth.getProfilesStoreStatus(),
  'auth.resetProfilesStoreAfterDecryptFailure': async () => auth.resetProfilesStoreAfterDecryptFailure(),
  // OAuth flow — startOAuth kicks off a background login; renderer polls
  // via pollOAuthFlow, feeds prompt answers via submitOAuthInput.
  'auth.startOAuth':       async ({ provider, label }) => auth.startOAuth(provider, label),
  'auth.pollOAuthFlow':    async ({ flowId }) => auth.pollOAuthFlow(flowId),
  'auth.submitOAuthInput': async ({ flowId, value }) => auth.submitOAuthInput(flowId, value),
  'auth.cancelOAuthFlow':  async ({ flowId }) => auth.cancelOAuthFlow(flowId),
  // Open a URL in the user's default browser (OAuth flow uses this so the
  // consent page renders where the user is already logged in).
  'auth.openExternal':     async ({ url }) => auth.openExternalUrl(url),
  // Priority list (entries) — ordered (provider, model, profile) tuples.
  'auth.listEntries':     async ({ includeUnavailable } = {}) => {
    if (includeUnavailable !== undefined && typeof includeUnavailable !== 'boolean') {
      throw new Error('includeUnavailable must be boolean');
    }
    return auth.listEntries({ includeUnavailable: includeUnavailable === true });
  },
  'auth.addEntry':        async ({ provider, model, profileId }) => auth.addEntry({ provider, model, profileId }),
  'auth.removeEntry':     async ({ entryId }) => auth.removeEntry(entryId),
  'auth.reorderEntries':  async ({ orderedIds }) => auth.reorderEntries(orderedIds || []),
  'auth.updateEntryModel':async ({ entryId, model }) => auth.updateEntryModel(entryId, model),
  'auth.revealApiKey':   async ({ profileId }) => auth.revealApiKey(profileId),
  'auth.updateApiKey':   async ({ profileId, apiKey }) => auth.updateApiKey(profileId, apiKey),

  // ── Unified model authorization workflow ──
  'modelAuthorizations.list': async (_args, ctx) =>
    auth.listAuthorizationSummaries(ctx.userId),
  'modelAuthorizations.prepareCcSwitch': async ({ externalId }, ctx) =>
    modelAuthorizationDiscovery.prepareCcSwitchAuthorization(
      ctx.userId,
      boundedText(externalId, 'externalId', 160),
    ),
  'modelAuthorizations.discover': async (args, ctx) => {
    const kind = boundedText(args?.kind, 'kind', 40);
    if (kind === 'builtin') {
      return modelAuthorizationDiscovery.discoverAuthorizationModels(ctx.userId, {
        kind,
        providerId: boundedText(args.providerId, 'providerId', 120),
      });
    }
    if (kind === 'ccswitch_draft') {
      return modelAuthorizationDiscovery.discoverAuthorizationModels(ctx.userId, {
        kind,
        draftId: boundedText(args.draftId, 'draftId', 120),
      });
    }
    if (kind === 'custom_api_key') {
      const protocol = boundedText(args.protocol, 'protocol', 20);
      if (protocol !== 'openai' && protocol !== 'openai-responses' && protocol !== 'anthropic' && protocol !== 'gemini') throw new Error('invalid protocol');
      return modelAuthorizationDiscovery.discoverAuthorizationModels(ctx.userId, {
        kind,
        protocol,
        baseUrl: boundedText(args.baseUrl, 'baseUrl', 500),
        apiKey: boundedText(args.apiKey, 'apiKey', 20_000),
      });
    }
    throw new Error('invalid discovery kind');
  },
  'modelAuthorizations.testDraft': async (args, ctx) => {
    const kind = boundedText(args?.kind, 'kind', 40);
    const model = boundedText(args?.model, 'model', 200);
    if (kind === 'ccswitch_draft') {
      return modelAuthorizationDiscovery.testPreparedAuthorizationDraft(ctx.userId, {
        kind,
        draftId: boundedText(args.draftId, 'draftId', 120),
        model,
      });
    }
    if (kind === 'oauth') {
      return modelAuthorizationDiscovery.testPreparedAuthorizationDraft(ctx.userId, {
        kind,
        providerId: boundedText(args.providerId, 'providerId', 120),
        profileId: boundedText(args.profileId, 'profileId', 180),
        model,
      });
    }
    if (kind === 'builtin_api_key') {
      return modelAuthorizationDiscovery.testPreparedAuthorizationDraft(ctx.userId, {
        kind,
        providerId: boundedText(args.providerId, 'providerId', 120),
        apiKey: boundedText(args.apiKey, 'apiKey', 20_000),
        baseUrl: boundedText(args.baseUrl, 'baseUrl', 500, false) || undefined,
        model,
      });
    }
    if (kind === 'custom_api_key') {
      const protocol = boundedText(args.protocol, 'protocol', 20);
      if (protocol !== 'openai' && protocol !== 'openai-responses' && protocol !== 'anthropic' && protocol !== 'gemini') throw new Error('invalid protocol');
      return modelAuthorizationDiscovery.testPreparedAuthorizationDraft(ctx.userId, {
        kind,
        protocol,
        baseUrl: boundedText(args.baseUrl, 'baseUrl', 500),
        apiKey: boundedText(args.apiKey, 'apiKey', 20_000),
        model,
      });
    }
    throw new Error('invalid test draft kind');
  },
  'modelAuthorizations.complete': async (args, ctx) => {
    const selectedModels = boundedModelIds(args?.selectedModels);
    const defaultModel = boundedText(args?.defaultModel, 'defaultModel', 200);
    const requestId = boundedText(args?.requestId, 'requestId', 120);
    if (args?.source === 'ccswitch') {
      return modelAuthorizationDiscovery.completePreparedCcSwitchAuthorization(ctx.userId, {
        draftId: boundedText(args.draftId, 'draftId', 120), requestId, selectedModels, defaultModel,
      });
    }
    if (args?.providerKind === 'builtin' && args?.authType === 'oauth') {
      return auth.completeAuthorization(ctx.userId, {
        requestId, selectedModels, defaultModel,
        authType: 'oauth', source: 'manual', providerKind: 'builtin',
        providerId: boundedText(args.providerId, 'providerId', 120),
        profileId: boundedText(args.profileId, 'profileId', 180),
      });
    }
    if (args?.providerKind === 'builtin' && args?.authType === 'api_key') {
      return auth.completeAuthorization(ctx.userId, {
        requestId, selectedModels, defaultModel,
        authType: 'api_key', source: 'manual', providerKind: 'builtin',
        providerId: boundedText(args.providerId, 'providerId', 120),
        label: boundedText(args.label, 'label', 40, false) || undefined,
        apiKey: boundedText(args.apiKey, 'apiKey', 20_000),
        baseUrl: boundedText(args.baseUrl, 'baseUrl', 500, false) || undefined,
      });
    }
    if (args?.providerKind === 'custom' && args?.authType === 'api_key') {
      const protocol = boundedText(args?.customProvider?.protocol, 'protocol', 20);
      if (protocol !== 'openai' && protocol !== 'openai-responses' && protocol !== 'anthropic' && protocol !== 'gemini') throw new Error('invalid protocol');
      return auth.completeAuthorization(ctx.userId, {
        requestId, selectedModels, defaultModel,
        authType: 'api_key', source: 'manual', providerKind: 'custom',
        customProvider: {
          id: boundedText(args.customProvider.id, 'id', 120, false) || undefined,
          name: boundedText(args.customProvider.name, 'name', 60),
          protocol,
          baseUrl: boundedText(args.customProvider.baseUrl, 'baseUrl', 500),
          apiKey: boundedText(args.customProvider.apiKey, 'apiKey', 20_000),
        },
      });
    }
    throw new Error('invalid authorization completion');
  },
  'modelAuthorizations.removeModel': async ({ authorizationId, entryId }, ctx) =>
    auth.removeAuthorizationModel(
      ctx.userId,
      boundedText(authorizationId, 'authorizationId', 180),
      boundedText(entryId, 'entryId', 180),
    ),
  'modelAuthorizations.remove': async ({ authorizationId }, ctx) =>
    auth.removeAuthorization(ctx.userId, boundedText(authorizationId, 'authorizationId', 180)),

  // ── Unified custom model providers ──
  'customProviders.list': async (_args, ctx) => ({
    protocols: customProviders.listCustomProviderProtocols(),
    providers: customProviders.listCustomProviders(ctx.userId).map((provider) => ({
      id: provider.id,
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      notes: provider.notes,
      websiteUrl: provider.websiteUrl,
      needsKey: !!provider.needsKey,
      needsModelMapping: !!provider.needsModelMapping,
      models: provider.models || [],
      source: provider.source,
      externalId: provider.externalId,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
      apiKeyMasked: auth.maskKey(provider.apiKey),
    })),
  }),
  'customProviders.add': async (args, ctx) => customProviders.addCustomProvider(ctx.userId, args || {}),
  'customProviders.update': async ({ id, ...updates }, ctx) => {
    if (typeof id !== 'string' || !id) throw new Error('invalid id');
    return customProviders.updateCustomProvider(ctx.userId, id, updates);
  },
  'customProviders.remove': async ({ id }, ctx) => {
    if (typeof id !== 'string' || !id) throw new Error('invalid id');
    return customProviders.removeCustomProvider(ctx.userId, id);
  },
  'customProviders.setEnabled': async (args, ctx) => {
    const id = boundedText(args?.id, 'id', 120);
    if (typeof args?.enabled !== 'boolean') throw new Error('enabled must be boolean');
    return customProviders.setCustomProviderEnabled(ctx.userId, id, args.enabled);
  },
  'customProviders.model.add': async (args, ctx) => customProviders.addCustomProviderModel(
    ctx.userId,
    boundedText(args?.providerId, 'providerId', 120),
    boundedCustomProviderModel(args.model, 'model'),
  ),
  'customProviders.model.update': async (args, ctx) => customProviders.updateCustomProviderModel(
    ctx.userId,
    boundedText(args?.providerId, 'providerId', 120),
    boundedText(args?.modelId, 'modelId', 200),
    boundedCustomProviderModel(args.model, 'model'),
  ),
  'customProviders.model.remove': async (args, ctx) => customProviders.removeCustomProviderModel(
    ctx.userId,
    boundedText(args?.providerId, 'providerId', 120),
    boundedText(args?.modelId, 'modelId', 200),
  ),
  'customProviders.model.test': async (args, ctx) => customProviders.testCustomProviderModel(
    ctx.userId,
    boundedText(args?.providerId, 'providerId', 120),
    boundedText(args?.modelId, 'modelId', 200),
  ),
  // 远端模型发现（统一执行入口配套）：调服务自己的 list-models 端点，
  // 只读不落库——渲染层展示列表，用户勾选后经 model.add 导入。
  'customProviders.fetchModels': async (args, ctx) => customProviders.fetchCustomProviderModels(
    ctx.userId,
    boundedText(args?.providerId, 'providerId', 120),
  ),
  'customProviders.ccswitch.probe': async () => {
    const probe = probeCcSwitch();
    return { available: probe.available, reason: probe.reason };
  },
  'customProviders.ccswitch.preview': async (_args, ctx) => {
    const preview = await customProviders.previewCcSwitchImport(ctx.userId);
    if (!preview.ok) return preview;
    return {
      ok: true,
      items: preview.items.map((item) => ({
        externalId: item.externalId,
        // Agent this credential belongs to — the CC Switch externalId is
        // `${appType}:${id}`, so the prefix (up to the first ':') is the
        // originating agent. appType values contain no ':', so this is exact.
        appType: item.externalId.slice(0, item.externalId.indexOf(':')) || item.externalId,
        name: item.name,
        protocol: item.protocol,
        baseUrl: item.baseUrl,
        notes: item.notes,
        websiteUrl: item.websiteUrl,
        models: item.models || [],
        modelsProbe: item.modelsProbe !== false,
        needsKey: !!item.needsKey,
        apiKeyMasked: auth.maskKey(item.apiKey),
      })),
      unsupported: preview.skipped.filter((item) => item.reason !== 'official').map((item) => ({
        externalId: item.externalId,
        name: item.name,
        appType: item.appType,
        reason: item.reason,
      })),
    };
  },
  'customProviders.ccswitch.sync': async ({ externalIds, modelsByExternalId, baseUrlsByExternalId, abilitiesByExternalId } = {}, ctx) => {
    const selected = Array.isArray(externalIds)
      ? externalIds.filter((id): id is string => typeof id === 'string' && !!id)
      : undefined;
    const models = modelsByExternalId && typeof modelsByExternalId === 'object' && !Array.isArray(modelsByExternalId)
      ? modelsByExternalId
      : undefined;
    const bases = baseUrlsByExternalId && typeof baseUrlsByExternalId === 'object' && !Array.isArray(baseUrlsByExternalId)
      ? baseUrlsByExternalId
      : undefined;
    // Probed per-model abilities (sparse; aggregator endpoints only).
    // Validate one level deep: { [externalId]: { [modelId]: { contextWindow?, vision? } } }.
    let abilities: Record<string, Record<string, { contextWindow?: number; vision?: boolean }>> | undefined;
    if (abilitiesByExternalId && typeof abilitiesByExternalId === 'object' && !Array.isArray(abilitiesByExternalId)) {
      for (const [extId, map] of Object.entries(abilitiesByExternalId)) {
        if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
        const clean: Record<string, { contextWindow?: number; vision?: boolean }> = {};
        for (const [modelId, raw] of Object.entries(map)) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
          const a: { contextWindow?: number; vision?: boolean } = {};
          const w = (raw as Record<string, unknown>).contextWindow;
          if (typeof w === 'number' && Number.isSafeInteger(w) && w > 0) a.contextWindow = w;
          const v = (raw as Record<string, unknown>).vision;
          if (typeof v === 'boolean') a.vision = v;
          if (a.contextWindow !== undefined || a.vision !== undefined) clean[modelId] = a;
        }
        if (Object.keys(clean).length) (abilities || (abilities = {}))[extId] = clean;
      }
    }
    return customProviders.syncFromCcSwitch(ctx.userId, selected, undefined, models, bases, undefined, abilities);
  },
  'customProviders.storeActiveCliConfig': async ({ cli } = {}, ctx) => {
    if (typeof cli !== 'string' || !cli) {
      return { ok: false, error: 'invalid_cli' };
    }

    const { readActiveCliConfig, readCliModelEndpoint } = await import('../features/local_agents/active_config.js');
    const config = readActiveCliConfig(cli as LocalCliType);

    if (!config) {
      return { ok: false, error: 'no_active_config' };
    }

    // 账号（OAuth）登录没有可存储的 API Key：OAuth token 不能当 API key 直连
    // 上游端点，存下去只会得到一个"配置存在但调用失败"的假配置。拒绝存储，
    // UI 端（引导下拉）也会对 OAuth 隐藏「连接并存储 API」选项。
    if (config.mode === 'oauth') {
      return { ok: false, error: 'oauth_login_no_api_key' };
    }

    // Check if this active config is already stored (avoid duplicates)
    const externalId = `${cli}:active`;
    const existing = customProviders.listCustomProviders(ctx.userId);
    const existingProvider = existing.find((p) => p.externalId === externalId);

    // Primary/fallback rule for "连接并存储 API": the FIRST stored active-CLI
    // config becomes the commander's primary chat entry; later ones are
    // appended as fallbacks (chat dispatch walks entries in order, so a
    // failed primary is retried on the next). `:active` configs already
    // present mean this is not the first one.
    const position: 'front' | 'back' =
      existing.some((p) => p.externalId && p.externalId.endsWith(':active')) ? 'back' : 'front';

    // Map CLI type to protocol
    const protocolMap: Record<string, 'anthropic' | 'openai' | 'gemini'> = {
      claude: 'anthropic',
      codex: 'openai',
      opencode: 'anthropic', // OpenCode supports multiple, default to anthropic
      hermes: 'anthropic',
      workbuddy: 'anthropic',
    };

    const protocol = protocolMap[cli] || 'anthropic';
    const name = `${cli.charAt(0).toUpperCase() + cli.slice(1)} (当前使用)`;

    // 隐层适配：baseUrl 优先取 CLI 自己配置里的真实端点（codex 读
    // config.toml 的 base_url、claude 读 settings.json、opencode 读 auth.json），
    // 而不是猜测官方端点——这样直连的用户存的就是直连地址，走本地代理的
    // 用户存的就是代理地址（与其 CLI 自身行为一致）。都没有才回退协议默认。
    let endpointBaseUrl = '';
    try {
      const endpoint = readCliModelEndpoint(cli as LocalCliType);
      if (endpoint && endpoint.baseUrl) endpointBaseUrl = endpoint.baseUrl;
    } catch {
      /* fall through */
    }
    const baseUrl = endpointBaseUrl || config.baseUrl || (protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');

    // Default model to bind as the chat entry. It MUST be present in the
    // provider's `models` list — otherwise `auth.addEntry`'s
    // isCustomProviderModelAllowed check rejects the bind, the entry silently
    // fails (only a warn log), and the stored API never shows up in settings'
    // 已配置 nor becomes usable for chat, while the connect toast still says
    // "已存储当前正在使用的 API". anthropic mirrors the historical
    // claude-sonnet-4-6 bind; openai uses codex's default (models.ts).
    const DEFAULT_MODEL_BY_PROTOCOL: Record<string, string> = {
      anthropic: 'claude-sonnet-4-6',
      openai: 'gpt-5.6-sol', // codex default (local_agents/models.ts)
    };
    const defaultModel = DEFAULT_MODEL_BY_PROTOCOL[protocol] || '';
    const models = defaultModel ? [defaultModel] : [];

    let providerId: string;

    if (existingProvider) {
      // Update existing provider (also back-fills `models` for providers
      // created before the models fix, so the entry bind below succeeds).
      const updateResult = customProviders.updateCustomProvider(ctx.userId, existingProvider.id, {
        name,
        protocol,
        baseUrl,
        apiKey: config.apiKey,
        models,
      });
      if (!updateResult.ok) return updateResult;
      providerId = existingProvider.id;
      log.info('active CLI config updated', { cli, providerId, mode: config.mode });
    } else {
      // Add new provider (front for the first stored active-CLI config, so
      // it becomes the primary; back for later ones = fallback).
      const addResult = customProviders.addCustomProvider(ctx.userId, {
        name,
        protocol,
        baseUrl,
        apiKey: config.apiKey,
        models,
        source: 'manual', // Use 'manual' as source since custom_providers doesn't recognize 'active_cli'
        externalId,
      }, position);
      if (!addResult.ok) return addResult;
      providerId = addResult.id;
      log.info('active CLI config stored', { cli, providerId, mode: config.mode, position });
    }

    // Bind a chat entry when we have a default model for this protocol —
    // anthropic AND openai (codex). The entry is what makes the stored API
    // appear in settings 已配置 and be selectable for chat.
    if (defaultModel) {
      try {
        await auth.addEntry({
          provider: `cp:${providerId}`,
          model: defaultModel,
          profileId: `cp:${providerId}`,
          position,
        });
      } catch (err) {
        log.warn('active cli auto-bind entry failed', { provider: providerId, error: (err as Error).message });
      }
    }

    return { ok: true, providerId, mode: config.mode };
  },

  // ── Commander backend binding (settings page) ──
  'settings.getCommanderBackend': async () => commanderBackend.getCommanderBackendView(),
  'settings.setCommanderBackend': async ({ settings }) => ({
    settings: commanderBackend.setCommanderBackendSettings(settings),
  }),

  // ── Image-generation API key (independent from chat entries) ──
  // `list` strips raw apiKey and replaces it with `apiKeyMasked` so
  // renderer never sees the full key (parity with chat entries' `profileMasked`).
  'imageAuth.list':     async () => ({
    ok: true,
    profiles: imageAuth.listImageProfiles().map((p) => ({
      id: p.id, provider: p.provider, label: p.label, createdAt: p.createdAt,
      apiKeyMasked: auth.maskKey(p.apiKey),
    })),
  }),
  'imageAuth.add':      async ({ provider, apiKey, label }) => imageAuth.addImageProfile({ provider, apiKey, label }),
  'imageAuth.remove':   async ({ id }) => imageAuth.removeImageProfile(id),
  'imageAuth.reorder':  async ({ orderedIds }) => imageAuth.reorderImageProfiles(orderedIds || []),
  'imageAuth.test':     async ({ id }) => imageAuth.testImageProfile(id),

  // ── Text-to-speech API key (user-owned speech providers) ──
  'ttsAuth.list':       async () => ({
    ok: true,
    presets: ttsAuth.listTtsProviderPresets(),
    profiles: ttsAuth.listTtsProfiles().map((p) => ({
      id: p.id, provider: p.provider, baseUrl: p.baseUrl, model: p.model,
      resourceId: p.resourceId,
      voice: p.voice, format: p.format, label: p.label, createdAt: p.createdAt,
      apiKeyMasked: auth.maskKey(p.apiKey),
    })),
  }),
  'ttsAuth.add':        async ({ provider, baseUrl, model, apiKey, resourceId, voice, format, label }) =>
    ttsAuth.addTtsProfile({ provider, baseUrl, model, apiKey, resourceId, voice, format, label }),
  'ttsAuth.remove':     async ({ id }) => ttsAuth.removeTtsProfile(id),
  'ttsAuth.reorder':    async ({ orderedIds }) => ttsAuth.reorderTtsProfiles(orderedIds || []),

  // ── Search-tool API key (overrides built-in keyless web_search) ──
  'searchAuth.list':    async () => ({
    ok: true,
    profiles: searchAuth.listSearchProfiles().map((p) => ({
      id: p.id, provider: p.provider, label: p.label, createdAt: p.createdAt,
      extras: p.extras, apiKeyMasked: auth.maskKey(p.apiKey),
    })),
  }),
  'searchAuth.add':     async ({ provider, apiKey, label, extras }) => searchAuth.addSearchProfile({ provider, apiKey, label, extras }),
  'searchAuth.remove':  async ({ id }) => searchAuth.removeSearchProfile(id),
  'searchAuth.reorder': async ({ orderedIds }) => searchAuth.reorderSearchProfiles(orderedIds || []),
  'searchAuth.test':    async ({ id }) => searchAuth.testSearchProfile(id),

  // ── Local-exec permission (gates bash / write_file / *_to_pdf tools) ──
  // Flat state object returned as handler result so the renderer receives
  // `{ ok: true, granted, grantedAt?, revokedAt? }` — settings.js reads
  // those fields directly off the response.
  'permissions.getLocalExec':    async () => permissions.getLocalExecState(),
  'permissions.grantLocalExec':  async () => permissions.grantLocalExec(),
  'permissions.revokeLocalExec': async () => permissions.revokeLocalExec(),
  // Three-mode setter (off / risk_prompt / allow_all). Returns the new state
  // in the same shape as getLocalExec so settings.js can read it back.
  'permissions.setLocalExecMode': async ({ mode }: { mode?: unknown }) => {
    let normalized: 'workspace_approval' | 'all_files_approval' | 'all_files_auto';
    if (mode === 'workspace_approval' || mode === 'all_files_approval' || mode === 'all_files_auto') {
      normalized = mode;
    } else if (mode === 'off') {
      normalized = 'workspace_approval';
    } else if (mode === 'risk_prompt') {
      normalized = 'all_files_approval';
    } else if (mode === 'allow_all') {
      normalized = 'all_files_auto';
    } else {
      throw new Error('invalid mode');
    }
    return permissions.setLocalExecMode(normalized);
  },

  // ── User-granted folder access (plan §B2) ──────────────────────────────
  // Extra directories the file/bash tools may touch beyond workspace +
  // attachments. Grant goes through a native folder picker; the feature
  // enforces the deny-list (credential/system dirs) + realpath.
  'grantedRoots.list': async (_payload: unknown, ctx: { userId: string }) => {
    const granted = await import('../features/granted_roots');
    return { roots: granted.listGrantedRoots(ctx.userId) };
  },
  'grantedRoots.add': async (_payload: unknown, ctx: { userId: string }) => {
    const selected = await userWorkspace.selectDirectory();
    if (!selected) return { ok: false as const, cancelled: true };
    const granted = await import('../features/granted_roots');
    try {
      const row = granted.grantRoot(ctx.userId, selected);
      return { ok: true as const, root: row };
    } catch (err) {
      const code = err instanceof granted.GrantedRootError ? err.code : 'E_UNKNOWN';
      return { ok: false as const, error: code };
    }
  },
  'grantedRoots.remove': async (payload: { path?: unknown }, ctx: { userId: string }) => {
    if (typeof payload?.path !== 'string') throw new Error('invalid path');
    const granted = await import('../features/granted_roots');
    return { ok: true as const, removed: granted.revokeRoot(ctx.userId, payload.path) };
  },

  // ── External packages management (plan §A; UI is read + manage only) ────
  // Install stays on the commander/CLI path (it needs the clone + dependency
  // consent flow). The registry's single-writer is bin/cogseed-pkg.cjs.
  'packages.list': async (_payload: unknown, ctx: { userId: string }) => {
    const pkgs = await import('../features/packages');
    return { ok: true as const, packages: pkgs.listPackagesForUi(ctx.userId) };
  },
  'packages.action': async (payload: { command?: unknown; name?: unknown }, ctx: { userId: string }) => {
    if (typeof payload?.command !== 'string' || typeof payload?.name !== 'string') {
      throw new Error('invalid command/name');
    }
    const pkgs = await import('../features/packages');
    const result = await pkgs.runPackageCommand(ctx.userId, payload.command, payload.name);
    // Skill listing reflects enable/disable + remove immediately.
    try { (await import('../model/core-agent/skill-registry')).invalidateSkills(); } catch { /* runner not loaded */ }
    return result;
  },
  // Open-tier skills (external packages + global folders) for the read-only
  // "From packages & global folders" group in the skills panel. External and
  // global are listed independently (no cross-tier display-name dedupe) so a
  // skill present in BOTH an installed package and a global folder shows under
  // each provenance. Disabled ids are NOT filtered here — the panel renders the
  // toggle state itself. (enable/disable is keyed by id, so a same-id skill in
  // both tiers shares one toggle state.)
  'skills.listOpen': async (_payload: unknown, ctx: { userId: string }) => {
    const reg = await import('../model/core-agent/skill-registry');
    const componentEnabled = await import('../features/component_enabled');
    const disabled = componentEnabled.readDisabledSets(ctx.userId).skills;
    const { external, global } = await reg.listOpenSkillsByTier(ctx.userId);
    const rows = [...external, ...global].map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      source: r.source,
      enabled: r.package_name ? r.package_enabled !== false : !disabled.has(r.id),
      ...(r.package_name ? { package_name: r.package_name } : {}),
      ...(r.package_kind ? { package_kind: r.package_kind } : {}),
      ...(typeof r.package_enabled === 'boolean' ? { package_enabled: r.package_enabled } : {}),
    }));
    return { ok: true as const, skills: rows };
  },

  // Renderer reply for the inline `delete_file` confirmation card. The
  // main-side tool is NOT blocking on this — it returned a token-bearing
  // `requires_user_confirmation` already (see core-agent/delete-file-confirm.ts).
  // This handler just flips the token state to granted / denied so the
  // LLM's NEXT delete_file call (Step 2, with the same token) can resolve
  // it. Idempotent: a second call with the same id is a no-op.
  'delete_file.respond': async ({ confirm_id, granted }: { confirm_id: string; granted: boolean }) => {
    // Static import (not dynamic) — dynamic `await import()` of a path that
    // is also reached via static `import` elsewhere can resolve to a
    // distinct module instance under tsx/ESM, yielding two independent
    // `_entries` Maps. The IPC handler then flips state on one Map while
    // the tool reads from the other → LLM Step 2 sees `pending` forever.
    const ok = resolveDeleteConfirmation(String(confirm_id || ''), !!granted);
    return { ok };
  },

  'delete_file.visible': async ({ confirm_id }: { confirm_id: string }) => {
    const ok = markDeleteConfirmationVisible(String(confirm_id || ''));
    return { ok };
  },

  // Renderer-side logs — forwarded here so all logging ends up in the
  // same daily file (with a `renderer/<module>` scope). Payload matches
  // `logFromRenderer` in main/logger.ts: { level, module, message, data }.
  'log.record': async (payload) => {
    logFromRenderer(payload || {});
    return {};
  },

  // ── User workspace (working directory) ──
  // Workspace handlers accept an optional scope hint:
  //   `{ cid }`        → main resolves cid → conv.project_id → scope
  //   `{ projectId }`  → renderer-supplied scope (commander tab project chip,
  //                      where there's no cid yet)
  //   neither          → default scope
  // When both are passed, cid takes precedence (it's the authoritative source
  // — conv.project_id is the truth). Project membership is frozen at conv
  // create time, so `cid → projectId` is a stable mapping.
  'workspace.get': async (payload, ctx) => {
    const projectId = await _resolveWorkspaceScope(ctx.userId, payload);
    return { path: userWorkspace.getWorkspacePath(ctx.userId, projectId) };
  },
  'workspace.getInfo': async (payload, ctx) => {
    const projectId = await _resolveWorkspaceScope(ctx.userId, payload);
    return userWorkspace.getWorkspaceInfo(ctx.userId, projectId);
  },
  'workspace.set': async (payload, ctx) => {
    const target = payload?.path;
    if (!target || typeof target !== 'string') throw new Error('missing path');
    const projectId = await _resolveWorkspaceScope(ctx.userId, payload);
    const result = userWorkspace.setWorkspacePath(ctx.userId, target, projectId);
    if (!result.ok) return { ok: false, error: (result as any).error };
    return { path: result.path };
  },
  'workspace.reset': async (payload, ctx) => {
    const projectId = await _resolveWorkspaceScope(ctx.userId, payload);
    const result = userWorkspace.resetWorkspacePath(ctx.userId, projectId);
    return { path: result.path };
  },
  'workspace.selectDirectory': async () => {
    const selected = await userWorkspace.selectDirectory();
    return { path: selected };
  },
  'workspace.openPath': async (payload, ctx) => {
    const projectId = await _resolveWorkspaceScope(ctx.userId, payload);
    const result = await userWorkspace.openWorkspaceInFileManager(ctx.userId, projectId);
    if (!result.ok) throw new Error((result as { ok: false; error: string }).error);
    return { path: result.path };
  },

  // Open the OS file manager focused on a single file (Finder on macOS,
  // Explorer on Windows, default file manager on Linux). The path must sit
  // inside the active user's file scope, or be an exact produced-file path
  // already recorded on the current conversation.
  // Open a produced/attached file with the OS default application. The path
  // must be a conversation-recorded file (produced[] / attachment) or inside
  // the user's file sandbox — same gate as revealPath, but opens instead of
  // revealing in the file manager.
  'workspace.openFile': async (payload, ctx) => {
    const target = payload?.path;
    if (typeof target !== 'string' || !target) {
      throw new Error('missing path');
    }
    const norm = path.resolve(target);
    if (!await _isAllowedFileActionPath(ctx.userId, payload, norm)) {
      throw new Error('path is outside the user workspace');
    }
    let st: fs.Stats;
    try { st = fs.statSync(norm); }
    catch { throw new Error('file not found'); }
    if (st.isDirectory()) {
      throw new Error('path is a directory');
    }
    const openErr = await shell.openPath(norm);
    if (openErr) throw new Error(openErr);
    return { path: norm };
  },

  'workspace.revealPath': async (payload, ctx) => {
    const target = payload?.path;
    if (typeof target !== 'string' || !target) {
      throw new Error('missing path');
    }
    const norm = path.resolve(target);
    if (!await _isAllowedFileActionPath(ctx.userId, payload, norm)) {
      throw new Error('path is outside the user workspace');
    }
    let st: fs.Stats;
    try { st = fs.statSync(norm); }
    catch { throw new Error('file not found'); }
    if (st.isDirectory()) {
      const openErr = await shell.openPath(norm);
      if (openErr) throw new Error(openErr);
    } else {
      shell.showItemInFolder(norm);
    }
    return { path: norm };
  },

  // Open one validated output with the OS default application. This is the
  // fallback for files that exist but cannot be previewed safely in-app.
  'workspace.openFileExternal': async (payload, ctx) => {
    const target = payload?.path;
    if (typeof target !== 'string' || !target) {
      throw new Error('missing path');
    }
    const norm = path.resolve(target);
    if (!await _isAllowedFileActionPath(ctx.userId, payload, norm)) {
      throw new Error('path is outside the user workspace');
    }
    let st: fs.Stats;
    try { st = fs.statSync(norm); }
    catch { throw new Error('file not found'); }
    if (!st.isFile()) throw new Error('path is not a file');
    const openErr = await shell.openPath(norm);
    if (openErr) throw new Error(openErr);
    return { ok: true, path: norm };
  },

  // Lightweight existence check for renderer previews. Same scope as
  // reveal/delete/read: workspace, current cid attachments, project library,
  // or an exact produced path already recorded on the conversation.
  'workspace.statPath': async (payload, ctx) => {
    const target = payload?.path;
    if (typeof target !== 'string' || !target) {
      throw new Error('missing path');
    }
    const norm = path.resolve(target);
    if (!await _isAllowedFileActionPath(ctx.userId, payload, norm)) {
      throw new Error('path is outside the user workspace');
    }
    let st: fs.Stats;
    try { st = fs.statSync(norm); }
    catch { return { exists: false, path: norm }; }
    return {
      exists: true,
      path: norm,
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  },

  'workspace.deletePath': async (payload, ctx) => {
    const target = payload?.path;
    if (typeof target !== 'string' || !target) {
      throw new Error('missing path');
    }
    const norm = path.resolve(target);
    if (!await _isAllowedFileActionPath(ctx.userId, payload, norm)) {
      throw new Error('path is outside the user workspace');
    }

    let st: fs.Stats;
    try { st = fs.statSync(norm); }
    catch { return { ok: false, error: 'not_found' }; }
    if (!st.isFile() && !st.isDirectory()) return { ok: false, error: 'not_supported' };

    try {
      if (typeof shell.trashItem === 'function') await shell.trashItem(norm);
      else if (st.isDirectory()) fs.rmSync(norm, { recursive: true });
      else fs.unlinkSync(norm);
    } catch (err) {
      try {
        if (st.isDirectory()) fs.rmSync(norm, { recursive: true });
        else fs.unlinkSync(norm);
      }
      catch {
        return { ok: false, error: String((err as Error).message || 'delete failed') };
      }
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const fileIndexer = require('../features/file_indexer') as { invalidateFileCache?: (userId: string, absPath: string) => void };
      fileIndexer.invalidateFileCache?.(ctx.userId, norm);
    } catch { /* cache invalidation is best-effort */ }

    return { ok: true, path: norm };
  },

  // Resolve a per-conversation attachment's absolute path. The renderer's
  // chip carries (cid, name) but the in-app file viewer's contract is
  // "abs path in"; we go through `resolveAttachmentAbsPath` so the same
  // safe-name / traversal / not-a-file gates the chat-media:// handler
  // already enforces apply here.
  'attachments.absPath': async (payload, ctx) => {
    const cid = payload?.cid;
    const name = payload?.name;
    if (typeof cid !== 'string' || !cid) throw new Error('missing cid');
    if (typeof name !== 'string' || !name) throw new Error('missing name');
    await chatAttachments.warmConversationSpace(ctx.userId, cid);
    const r = chatAttachments.resolveAttachmentAbsPath(ctx.userId, cid, name);
    if (!r.ok) {
      const err = r as { code?: string; error?: string };
      return { ok: false, error: err.error || err.code || 'failed' };
    }
    return { ok: true, path: r.absPath, kind: r.kind };
  },

  // Diagnose a failed <img>/<video> request without returning or reporting a
  // local path. Monitor uses the stable reason to distinguish missing/moved
  // files from unsupported/oversized media and browser decode/stream errors.
  'media.diagnose': async ({ url }, ctx) => {
    let parsed: URL;
    try { parsed = new URL(String(url || '')); }
    catch { return { diagnosis: 'invalid_url' }; }
    if (parsed.protocol !== 'chat-media:') return { diagnosis: 'unsupported_scheme' };
    const host = parsed.hostname.toLowerCase();
    if (host === 'local') {
      const absPath = chatMediaLocalPathFromUrl(parsed.toString());
      if (!absPath) return { diagnosis: 'invalid_url' };
      const resolved = chatAttachments.resolveLocalMediaPath(absPath);
      if (!resolved.ok) {
        return { diagnosis: (resolved as { code?: string }).code || 'unavailable' };
      }
      if (path.extname(resolved.absPath).toLowerCase() === '.svg') {
        const svg = chatAttachments.materializeLocalDisplaySvg(resolved.absPath);
        if (!svg.ok) return { diagnosis: (svg as { code?: string }).code || 'unavailable', media_kind: resolved.kind };
      }
      return { diagnosis: 'available', media_kind: resolved.kind };
    }
    if (host === 'cid') {
      let decoded = '';
      try { decoded = decodeURIComponent(parsed.pathname || '').replace(/^\/+/, ''); }
      catch { return { diagnosis: 'invalid_url' }; }
      const segments = decoded.split('/');
      const cid = segments.shift() || '';
      const name = segments.join('/');
      if (!cid || !name) return { diagnosis: 'invalid_url' };
      const resolved = chatAttachments.resolveAttachmentAbsPath(ctx.userId, cid, name);
      if (!resolved.ok) {
        return { diagnosis: (resolved as { code?: string }).code || 'unavailable' };
      }
      return { diagnosis: 'available', media_kind: resolved.kind };
    }
    return { diagnosis: 'unknown_route' };
  },

  // Read a file's text content for the in-app preview overlay
  // (markdown / plain text — pdf and html are streamed via `chat-media://`
  // instead). Same scope as the file actions above: active workspace ∪ the
  // attachment dir of the current cid ∪ exact recorded produced files. Full
  // reads keep the 2 MB cap because their contents cross IPC.
  'produced.readText': async (payload, ctx) => {
    const target = payload?.path;
    if (typeof target !== 'string' || !target) {
      throw new Error('missing path');
    }
    const norm = path.resolve(target);
    if (!await _isAllowedFileActionPath(ctx.userId, payload, norm)) {
      throw new Error('path is outside the user workspace');
    }
    let st: fs.Stats;
    try { st = fs.statSync(norm); }
    catch { return { ok: false, error: 'not_found' }; }
    if (!st.isFile()) return { ok: false, error: 'not_found' };
    const MAX_TEXT_BYTES = 2 * 1024 * 1024;
    if (st.size > MAX_TEXT_BYTES) {
      return { ok: false, error: 'too_large', size: st.size, cap: MAX_TEXT_BYTES };
    }
    let text: string;
    try {
      text = fs.readFileSync(norm, 'utf8');
    }
    catch (err) { return { ok: false, error: String((err as Error).message || 'read failed') }; }
    // Strip UTF-8 BOM so markdown / json don't render a leading invisible char.
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return { ok: true, text, size: st.size };
  },

  // Convert modern Office files into a local, sandboxed HTML preview.
  // This is a content preview, not a high-fidelity Office layout renderer.
  // It shares the same path scope as produced.readText and revealPath.
  'produced.officePreviewHtml': async (payload, ctx) => {
    const target = payload?.path;
    if (typeof target !== 'string' || !target) {
      throw new Error('missing path');
    }
    const norm = path.resolve(target);
    if (!await _isAllowedFileActionPath(ctx.userId, payload, norm)) {
      throw new Error('path is outside the user workspace');
    }
    const kind = _officePreviewKindForExt(path.extname(norm).toLowerCase());
    if (!kind) return { ok: false, error: 'unsupported' };
    let st: fs.Stats;
    try { st = fs.statSync(norm); }
    catch { return { ok: false, error: 'not_found' }; }
    if (!st.isFile()) return { ok: false, error: 'not_found' };
    const MAX_OFFICE_PREVIEW_BYTES = 50 * 1024 * 1024;
    if (st.size > MAX_OFFICE_PREVIEW_BYTES) {
      return { ok: false, error: 'too_large', size: st.size, cap: MAX_OFFICE_PREVIEW_BYTES };
    }
    const cacheKey = `${norm}:${st.size}:${st.mtimeMs}:${payload?.mode === 'card' ? 'card' : 'full'}`;
    const cached = _officePreviewCacheGet(cacheKey);
    if (cached) return { ok: true, html: cached.html, kind: cached.kind, size: st.size, cached: true };
    const compact = payload?.mode === 'card';

    try {
      const buf = fs.readFileSync(norm);
      let fragment = '';
      if (kind === 'word') {
        const { docxBufferToHtml } = await import('../util/extract-docx');
        fragment = await docxBufferToHtml(buf);
      } else if (kind === 'spreadsheet') {
        const { xlsxBufferToHtml } = await import('../util/extract-office');
        fragment = xlsxBufferToHtml(buf);
      } else {
        const { pptxBufferToHtml } = await import('../util/extract-office');
        fragment = pptxBufferToHtml(buf);
      }
      const html = _wrapOfficePreviewHtml(kind, path.basename(norm), fragment || '<p class="office-muted">(no previewable content)</p>', { compact });
      _officePreviewCachePut(cacheKey, html, kind);
      return { ok: true, html, kind, size: st.size };
    } catch (err) {
      return { ok: false, error: String((err as Error).message || 'preview failed') };
    }
  },

  // Write a UTF-8 text file into the workspace (or current cid's attachment
  // dir). Sandbox parity with `produced.readText`: same scope, same 2MB cap on
  // the resulting bytes — the chat-md drawer is the sole caller today, and
  // the file's job is "human edits the LLM's md output", so anything larger
  // belongs in the OS editor (open via reveal).
  'produced.writeText': async (payload, ctx) => {
    const target = payload?.path;
    const content = payload?.content;
    if (typeof target !== 'string' || !target) {
      throw new Error('missing path');
    }
    if (typeof content !== 'string') {
      throw new Error('missing content');
    }
    const MAX_TEXT_BYTES = 2 * 1024 * 1024;
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_TEXT_BYTES) {
      return { ok: false, error: 'too_large', size: bytes, cap: MAX_TEXT_BYTES };
    }
    const norm = path.resolve(target);
    if (!isPathAllowed(norm, await _ipcFileSandboxAllowedRoots(ctx.userId, payload))) {
      throw new Error('path is outside the user workspace');
    }

    try {
      fs.writeFileSync(norm, content, 'utf8');
    } catch (err) {
      return { ok: false, error: String((err as Error).message || 'write failed') };
    }
    return { ok: true, size: bytes };
  },

  // Read the install data root (`<container>/data`) — read-only display
  // for the settings page "Data root" row. WS_ROOT is process-stable so
  // no async work is needed.
  'app.dataRootPath': async () => ({ ok: true, path: WS_ROOT }),

  // Open the install data root in the OS file manager. WS_ROOT is the
  // only path this opens — no caller-supplied path, so no sandbox check.
  'app.openDataRoot': async () => {
    const target = WS_ROOT;
    if (!fs.existsSync(target)) throw new Error('data root not found');
    shell.openPath(target);
    return { ok: true, path: target };
  },

  // Internal debug panel data is stripped from the open-source build. Keep stable
  // handler shapes so stale renderer calls receive empty results.
  'devtools.listArchives':  async () => ({ items: [] }),
  'devtools.readArchive':   async () => ({ item: null }),
  'devtools.clearArchives': async () => ({ ok: true }),
  'devtools.getNativeSearchEnabled': async () => ({ enabled: true }),
  'devtools.setNativeSearchEnabled': async () => ({ enabled: true }),
  'devtools.skillMetricsReport': async ({ sinceDays } = {}) => {
    const { aggregateSkillMetrics } = await import('../features/skill_metrics');
    return aggregateSkillMetrics({ sinceDays: Number.isFinite(sinceDays) ? Number(sinceDays) : undefined });
  },

  // User-account login (Google OAuth). Stripped from the open-source build.

  // User feedback from Settings. Depends on the account session for Server auth.

  // Multi-device sync. Stripped from the open-source build (depends on account).

  // Local coding CLI agents (Claude Code, Codex, etc.). Kept in the open-source
  // build; the renderer's External Agent picker depends on localAgents.list.
  ...localAgentsHandlers,

  // P3394 external-agent gateways — the agent-modal 「外接」tab (P3394 way):
  // a picked CLI joins through a managed p3394-gateway instead of direct CLI
  // dispatch, so ANY agent speaks the same protocol.
  ...p3394ExternalHandlers,

  // Canonical reimbursement management surface. Its feature layer validates
  // the active user, trusted Agent identity and bounded stdio protocol.
  ...expenseWorkbenchHandlers,

  // Quality validator — renderer reads persisted ValidationReports to display
  // why a spec write / marketplace install was rejected.
  ...qualityHandlers,
  // Connectors (MCP-based). User-installed MCP servers expose tools to commander + selected
  // agents. No Server dependency, so kept in the open-source build.
  ...connectorsHandlers,

  // Local two-way messaging gateway. Platform credentials never cross this
  // handler table; the dedicated IPC module returns metadata-only DTOs.
  ...messagingHandlers,

  // Personal context connector (Feishu user OAuth + resource sync). Credential
  // material never crosses this table; status DTOs only.
  ...personalContextHandlers,
  ...touchpointHandlers,
  ...desktopWorkbenchHandlers,

  // In-app update reminders. Machine-local state; the server contract is
  // GET {COGSEED_API_BASE_URL}/updates/latest with withCommonHeaders().
  ...updatesHandlers,

  // CogSeed Hub account — desktop-side account management against the Hub
  // account service. Tokens never cross this table; renderer-safe status DTOs only.
  ...hubAccountHandlers,

  // Cross-session memory UI — view/edit/import/export over features/memory.ts.
  ...memoryHandlers,

  // Evidence-backed cognition assets. Confirmation reuses the canonical
  // memory write path; these handlers own only longitudinal evidence, review,
  // reuse, and growth state.
  //
  // `cognition.assets.list` is registered above (ability-asset semantics from
  // the recall surface); the legacy store-asset handler of the same name in
  // ipc/cognition.ts must not shadow it, so it is excluded from the spread.
  ...(({ 'cognition.assets.list': _legacyCognitionAssetsList, ...rest }) => rest)(cognitionHandlers),

  // P3394 TaskContinuationSnapshot and ContextReuseReceipt handlers for
};

// ── Stream handlers ──────────────────────────────────────────────────────
// Contract: `async function*(payload, ctx) yielding SSE-shape events`.
// The runtime ensures a terminal `{ type: 'done' }` is always sent, even on
// unexpected throws.

const streamHandlers: Record<string, StreamHandler> = {
  'stt.results': async function* ({ sessionId }, ctx, signal) {
    if (typeof sessionId !== 'string' || !safeId(sessionId)) {
      yield { type: 'error', text: 'invalid session id' };
      return;
    }
    let lastPartial = '';
    while (!signal.aborted) {
      const partial = stt.currentPartial(ctx.userId, sessionId);
      if (partial && partial !== lastPartial) {
        lastPartial = partial;
        yield { type: 'event', event: { partial } };
      }
      if (stt.isSessionDone(ctx.userId, sessionId)) {
        yield { type: 'event', event: { final: stt.currentFinal(ctx.userId, sessionId) } };
        return;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
  },
  /**
   * Read-only aside answer. Deliberately NOT routed through groupChat.send /
   * bus.enqueue: doing so would append to the main transcript and add a second
   * dispatch path. The model is called directly with no tools, so the
   * read-only property is structural rather than enforced.
   */
  'aside.askStream': async function* ({ cid, anchor_index, anchor_msg_id, question, project_id }, ctx, signal) {
    if (!safeId(cid)) {
      yield { type: 'error', text: 'invalid cid' };
      return;
    }
    const conv = await chats.getConversation(ctx.userId, cid, project_id ?? null);
    if (!conv) {
      yield { type: 'error', text: 'conversation not found' };
      return;
    }
    try {
      const events = conversationAside.askAside(ctx.userId, {
        cid,
        // Prefer the message id: a normally-opened conversation's bubbles carry
        // no global index, only an id.
        ...(anchor_msg_id ? { anchorMsgId: String(anchor_msg_id) } : { anchorIndex: Number(anchor_index) }),
        question: String(question ?? ''),
        projectHint: conv.project_id ?? null,
        boundAgentId: conv.agent_id || null,
      }, {
        getAgent: (id: string) => agents.getAgent(id) as any,
        isAgentEnabled: (id: string) => isAgentEnabled(ctx.userId, id),
        stream: (opts) => modelClient.streamChatWithModel({
          userId: opts.userId,
          message: opts.message,
          systemPrompt: opts.systemPrompt,
          sessionId: opts.sessionId,
          ...(opts.agentName ? { agentName: opts.agentName } : {}),
          // Explain-only: no skills in the prompt and NO tools at all. The
          // `disableTools` flag is what actually enforces this — `maxToolLoops: 0`
          // would be dropped as falsy and leave the full tool set attached.
          skillList: [],
          disableTools: true,
          abortSignal: signal,
        }) as AsyncIterable<{ type: string; text?: string }>,
      });
      for await (const event of events) {
        if (signal.aborted) return;
        yield event as { type: string; text?: string };
      }
    } catch (err) {
      yield { type: 'error', text: (err as Error).message };
    }
  },

  'cogseed.task.events': async function* (payload, ctx, signal) {
    yield* cogseedBackend.cogseedIpcService.streamEvents(ctx.userId, payload, signal);
  },

  'conversations.sendStream': async function* ({ cid, content, attachments, use_selections, references, recipient_agent_id, recipient_origin, execution_config, retry_message_id, edit_message_id }, ctx, signal) {
    if (!safeId(cid)) {
      yield { type: 'error', text: 'invalid cid' };
      return;
    }
    const text = (content || '').trim();
    if (!text) {
      yield { type: 'error', text: 'empty message' };
      return;
    }
    const atts = Array.isArray(attachments) ? attachments.filter((n: any) => typeof n === 'string') : [];
    const useSelections = Array.isArray(use_selections) ? use_selections : [];
    const refs = Array.isArray(references) ? references : [];
    if ((recipient_agent_id !== undefined || recipient_origin !== undefined)
      && (typeof recipient_agent_id !== 'string' || !safeId(recipient_agent_id)
        || (recipient_origin !== 'user_selection' && recipient_origin !== 'cli_fallback'))) {
      yield { type: 'error', text: 'invalid recipient route' };
      return;
    }
    // Per-task execution config (unified execution entry). Shape-check here;
    // the group-chat facade re-validates and drops stale/unknown values.
    if (execution_config !== undefined) {
      const ec: any = execution_config;
      const badShape = !ec || typeof ec !== 'object'
        || (ec.provider !== undefined && typeof ec.provider !== 'string')
        || (ec.model !== undefined && typeof ec.model !== 'string')
        || (ec.effort !== undefined && ec.effort !== 'off' && ec.effort !== 'low' && ec.effort !== 'high');
      if (badShape) {
        yield { type: 'error', text: 'invalid execution config' };
        return;
      }
    }
    // Legacy `conversations.stream` is now a thin wrapper around the
    // group_chat bus. Subscribe to the bus directly BEFORE calling
    // `groupChat.send` — `send` internally wakes the recipient worker
    // synchronously, and that worker's first state_changed / process events
    // can fire on the same microtask cycle as `send` returns. We also drain
    // the subscription while `send` is still in flight: plan-triggered runs
    // can spend real time dispatching/reconciling before `send` resolves,
    // but the bus is already carrying the agent's process/delta stream.
    //
    // We relay events until the bus is fully quiescent (no worker running
    // AND every actor's queue empty) — checked via the in-memory bus
    // state, since on-disk state.json briefly shows 'idle' in the gap
    // between an actor finishing and the next one's wake.
    const buf: GroupEvent[] = [];
    let wake: (() => void) | null = null;
    let cancelled = signal.aborted;
    const notify = () => {
      const w = wake; wake = null; w?.();
    };
    const onAbort = () => {
      cancelled = true;
      notify();
    };
    if (!cancelled) signal.addEventListener('abort', onAbort, { once: true });
    const unsub = groupChat.subscribeBus(ctx.userId, cid, (ev) => {
      buf.push(ev);
      notify();
    });
    let relayCount = 0;
    let processCount = 0;
    let firstProcessLogged = false;
    let sendDone = false;
    let sendRes: Awaited<ReturnType<typeof groupChat.send>>
      | Awaited<ReturnType<typeof groupChat.retryFailedTurn>>
      | null = null;
    let sendErr: unknown = null;
    const sendPromise = (async () => {
      try {
        const retryMessageId = typeof retry_message_id === 'string' ? retry_message_id.trim() : '';
        const editMessageId = typeof edit_message_id === 'string' ? edit_message_id.trim() : '';
        if (retryMessageId && editMessageId) {
          throw new Error('message retry and edit cannot be combined');
        }
        sendRes = editMessageId
          ? await groupChat.replaceUserMessage({
              userId: ctx.userId,
              cid,
              messageId: editMessageId,
              text,
            })
          : retryMessageId
            ? await groupChat.retryFailedTurn({
              userId: ctx.userId,
              cid,
              failedMessageId: retryMessageId,
              visibleText: text,
            })
            : await groupChat.send({
                userId: ctx.userId, cid, text,
                ...(atts.length ? { attachments: atts } : {}),
                ...(useSelections.length ? { use_selections: useSelections } : {}),
                ...(refs.length ? { references: refs } : {}),
                ...(recipient_agent_id ? { recipient_agent_id, recipient_origin } : {}),
                ...(execution_config ? { execution_config } : {}),
              });
      } catch (err) {
        sendErr = err;
      } finally {
        sendDone = true;
        notify();
      }
    })();
    void sendPromise;
    try {
      drainLoop: while (!cancelled) {
        while (buf.length) {
          const ev = buf.shift()!;
          relayCount += 1;
          if (ev.type === 'process') {
            processCount += 1;
            if (!firstProcessLogged) {
              firstProcessLogged = true;
              log.info(`sendStream first process cid=${cid} actor=${(ev as any).actor || ''} kind=${(ev as any).data?.type || ''}`);
            }
          }
          yield { type: 'event', event: { stream: 'group', data: ev } };
        }
        if (sendDone) {
          if (sendErr) {
            const errText = sendErr instanceof Error ? sendErr.message : String(sendErr || 'send failed');
            yield { type: 'error', text: errText };
            return;
          }
          if (!sendRes?.ok) {
            yield { type: 'error', text: sendRes?.error || 'send failed' };
            return;
          }
          if (groupChat.busIsQuiescent(ctx.userId, cid)) break drainLoop;
        }
        if (cancelled) break;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      log.info(`sendStream closed cid=${cid} relayed=${relayCount} process=${processCount} sendDone=${sendDone} cancelled=${cancelled}`);
      try { unsub(); } catch { /* ignore */ }
      try { signal.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
    }
  },

  'groupChat.events': async function* ({ cid, untilIdle }, ctx, signal) {
    if (!safeId(cid)) {
      yield { type: 'error', text: 'invalid cid' };
      return;
    }
    if (untilIdle) {
      const buf: GroupEvent[] = [];
      let wake: (() => void) | null = null;
      let cancelled = signal.aborted;
      let sawWorkActivity = !groupChat.busIsQuiescent(ctx.userId, cid);
      let relayCount = 0;
      let processCount = 0;
      let firstProcessLogged = false;
      const onAbort = () => { cancelled = true; const w = wake; wake = null; w?.(); };
      if (!cancelled) signal.addEventListener('abort', onAbort, { once: true });
      const unsub = groupChat.subscribeBus(ctx.userId, cid, (ev) => {
        buf.push(ev);
        const w = wake; wake = null; w?.();
      });
      try {
        while (!cancelled) {
          while (buf.length) {
            const ev = buf.shift()!;
            if (ev.type === 'process') sawWorkActivity = true;
            if (ev.type === 'artifact_created') sawWorkActivity = true;
            if (ev.type === 'message') {
              const msg = (ev as any).msg;
              if (msg && msg.from !== 'user') sawWorkActivity = true;
            }
            if (ev.type === 'state_changed') {
              const st = ev.state;
              const inFlight = Array.isArray(st?.in_flight) ? st.in_flight : [];
              if (st?.status === 'running' || inFlight.length > 0 || !groupChat.busIsQuiescent(ctx.userId, cid)) {
                sawWorkActivity = true;
              }
            }
            relayCount += 1;
            if (ev.type === 'process') {
              processCount += 1;
              if (!firstProcessLogged) {
                firstProcessLogged = true;
                log.info(`groupEvents first process cid=${cid} actor=${(ev as any).actor || ''} kind=${(ev as any).data?.type || ''}`);
              }
            }
            yield ev;
            if (sawWorkActivity && groupChat.busIsQuiescent(ctx.userId, cid)) return;
          }
          if (sawWorkActivity && groupChat.busIsQuiescent(ctx.userId, cid)) return;
          if (cancelled) break;
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      } finally {
        log.info(`groupEvents closed cid=${cid} relayed=${relayCount} process=${processCount} cancelled=${cancelled}`);
        try { unsub(); } catch { /* ignore */ }
        try { signal.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
      }
      return;
    }
    for await (const ev of groupChat.streamEvents(ctx.userId, cid, { abortSignal: signal })) {
      yield ev;
    }
  },

  // Long-lived global stream the renderer opens once on boot. Each
  // auto-task fire produces a `conv_created` event so the sidebar can
  // reload its conv list (manual runs mutate the list locally, but auto
  // fires create the conv from main with no other notification path).
  'autoTasks.events': async function* (_payload, _ctx, signal) {
    const buf: autoTasks.AutoFireEvent[] = [];
    let wake: (() => void) | null = null;
    let cancelled = signal.aborted;
    const onAbort = () => { cancelled = true; const w = wake; wake = null; w?.(); };
    if (!cancelled) signal.addEventListener('abort', onAbort, { once: true });
    const unsub = autoTasks.subscribeFires((ev) => {
      buf.push(ev);
      const w = wake; wake = null; w?.();
    });
    try {
      while (!cancelled) {
        while (buf.length) {
          const ev = buf.shift()!;
          yield { type: 'event', event: ev };
        }
        if (cancelled) break;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      try { unsub(); } catch { /* ignore */ }
      try { signal.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
    }
  },

  // B+ fast import: background extraction completion. The renderer subscribes
  // once on boot and uses these events to swap a conversation's "正在提炼"
  // placeholder for the real carry details (and toast the user).
  'sessionImport.events': async function* (_payload, _ctx, signal) {
    const buf: Array<{ type: 'extraction_done' | 'extraction_failed'; cid: string; welcome?: unknown; reason?: string }> = [];
    let wake: (() => void) | null = null;
    let cancelled = signal.aborted;
    const onAbort = () => { cancelled = true; const w = wake; wake = null; w?.(); };
    if (!cancelled) signal.addEventListener('abort', onAbort, { once: true });
    const { subscribeExtractionEvents } = await import('../features/session_import/extraction-background');
    const unsub = subscribeExtractionEvents((ev) => {
      buf.push(ev);
      const w = wake; wake = null; w?.();
    });
    try {
      while (!cancelled) {
        while (buf.length) {
          const ev = buf.shift()!;
          yield { type: 'event', event: ev };
        }
        if (cancelled) break;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      try { unsub(); } catch { /* ignore */ }
      try { signal.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
    }
  },

  'skills.chat.sendStream': async function* ({ id, content, model_text, attachments }, ctx, signal) {
    if (!skills.isValidSkillId(id)) {
      yield { type: 'error', text: 'invalid skill id' };
      return;
    }
    const text = (content || '').trim();
    if (!text) {
      yield { type: 'error', text: 'empty message' };
      return;
    }
    const modelText = typeof model_text === 'string' ? model_text.trim() : '';
    const atts = Array.isArray(attachments) ? attachments.filter((n: any) => typeof n === 'string' && n) : [];
    yield* skills.streamSendToSkillChat(ctx.userId, id, text, {
      abortSignal: signal,
      ...(atts.length ? { attachments: atts } : {}),
      ...(modelText ? { modelText } : {}),
    });
  },

  'agents.chat.sendStream': async function* ({ id, content, model_text, attachments }, ctx, signal) {
    if (!safeId(id)) {
      yield { type: 'error', text: 'invalid agent id' };
      return;
    }
    const text = (content || '').trim();
    if (!text) {
      yield { type: 'error', text: 'empty message' };
      return;
    }
    const modelText = typeof model_text === 'string' ? model_text.trim() : '';
    const atts = Array.isArray(attachments) ? attachments.filter((n: any) => typeof n === 'string' && n) : [];
    yield* agents.streamSendToAgentEditChat(ctx.userId, id, text, {
      abortSignal: signal,
      ...(atts.length ? { attachments: atts } : {}),
      ...(modelText ? { modelText } : {}),
    });
  },

  'space.kb.events': async function* ({ spaceId }, ctx, signal) {
    if (!safeId(spaceId)) {
      yield { type: 'error', text: 'invalid spaceId' };
      return;
    }
    const queue: import('../features/project_library_indexer').SpaceLibraryStatusEvent[] = [];
    let notify: (() => void) | null = null;
    const listener = (ev: import('../features/project_library_indexer').SpaceLibraryStatusEvent) => {
      if (ev.userId !== ctx.userId || ev.spaceId !== spaceId) return;
      queue.push(ev);
      notify?.();
    };
    spaceLibraryIndexer.spaceLibraryEvents.on('status', listener);
    const abortPromise = new Promise<void>((r) => {
      if (signal.aborted) r();
      else signal.addEventListener('abort', () => r(), { once: true });
    });
    try {
      while (!signal.aborted) {
        if (queue.length) {
          yield { type: 'event', event: queue.shift()! };
          continue;
        }
        await Promise.race([
          new Promise<void>((r) => { notify = () => { notify = null; r(); }; }),
          abortPromise,
        ]);
      }
    } finally {
      spaceLibraryIndexer.spaceLibraryEvents.off('status', listener);
    }
  },

  // Long-lived subscription: each kb_indexer status transition (pending →
  // processing → ready / failed, plus deletes) is pushed to the renderer so
  // UI chips update live without polling. Filter to the caller's uid — in the
  // current single-active-user world that's the only uid anyway, but the
  // guard keeps us honest when multi-uid lands.
  'kb.events': async function* (_payload, ctx, signal) {
    const queue: import('../features/kb_indexer').KbStatusEvent[] = [];
    let notify: (() => void) | null = null;
    const listener = (ev: import('../features/kb_indexer').KbStatusEvent) => {
      if (ev.userId !== ctx.userId) return;
      queue.push(ev);
      notify?.();
    };
    kbIndexer.kbEvents.on('status', listener);
    const abortPromise = new Promise<void>((r) => {
      if (signal.aborted) r();
      else signal.addEventListener('abort', () => r(), { once: true });
    });
    try {
      while (!signal.aborted) {
        if (queue.length) {
          yield { type: 'event', event: queue.shift()! };
          continue;
        }
        await Promise.race([
          new Promise<void>((r) => { notify = () => { notify = null; r(); }; }),
          abortPromise,
        ]);
      }
    } finally {
      kbIndexer.kbEvents.off('status', listener);
    }
  },

  // Streams a single PTY terminal session's output to the renderer. Opened by
  // terminal-panel.js after `terminal.create`. Filters to the owning user +
  // session id. Raw bytes (ANSI intact) are forwarded for xterm.js to render.
  'terminal.stream': async function* (
    payload: { session_id?: unknown },
    ctx,
    signal,
  ) {
    const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : '';
    if (!sessionId) {
      yield { type: 'error', error: 'invalid session_id' };
      return;
    }
    const queue: Array<{ kind: 'output'; data: string } | { kind: 'exit'; exitCode: number | null }> = [];
    let notify: (() => void) | null = null;
    const onData = (ev: { userId: string; sessionId: string; chunk: string }) => {
      if (ev.userId !== ctx.userId || ev.sessionId !== sessionId) return;
      queue.push({ kind: 'output', data: ev.chunk });
      notify?.();
    };
    const onExit = (ev: { userId: string; sessionId: string; exitCode: number | null }) => {
      if (ev.userId !== ctx.userId || ev.sessionId !== sessionId) return;
      queue.push({ kind: 'exit', exitCode: ev.exitCode });
      notify?.();
    };
    terminalEvents.on('data', onData);
    terminalEvents.on('exit', onExit);
    const abortPromise = new Promise<void>((r) => {
      if (signal.aborted) r();
      else signal.addEventListener('abort', () => r(), { once: true });
    });
    try {
      while (!signal.aborted) {
        if (queue.length) {
          const item = queue.shift()!;
          if (item.kind === 'output') yield { type: 'output', data: item.data };
          else yield { type: 'exit', exit_code: item.exitCode };
          continue;
        }
        await Promise.race([
          new Promise<void>((r) => { notify = () => { notify = null; r(); }; }),
          abortPromise,
        ]);
      }
    } finally {
      terminalEvents.off('data', onData);
      terminalEvents.off('exit', onExit);
    }
  },
};

// ── Runtime ──────────────────────────────────────────────────────────────

interface StreamState { cancelled: boolean; controller: AbortController; sender: WebContents }
const activeStreams = new Map<string, StreamState>();
/** process 事件批量窗口：16ms 内相邻 delta 打包成一条 IPC 消息。 */
const STREAM_BATCH_WINDOW_MS = 16;
/** 单条批量消息最多携带的 process 事件数（防止长时间突发时包过大）。 */
const STREAM_BATCH_MAX = 64;

/**
 * Resolve the current user context for an IPC request. `user.init` must be
 * callable without context (bootstrap); every other handler gets a resolved
 * `userId` injected.
 */
async function resolveContext(sender: WebContents): Promise<IpcContext> {
  const user = await users.getOrCreateSelfUser();
  return { userId: user.user_id, user, sender };
}

/** Send a push-event to every open renderer. Channel name must match preload's
 *  `PUSH_EVENT_PREFIXES` allow-list. Used by main-initiated status broadcasts
 *  (boot-time reconcile / sync / updater state). */
export function broadcastToRenderer(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/** P3394 Bridge IPC port (Phase 3): renderer-initiated inbound port with
 *  sender identity pinned to the local agent, and main→renderer pushes on the
 *  `p3394.bridge.push` channel. */
export const p3394BridgeIpcPort = new P3394IpcChannel('ipc', {
  sendToRenderer: (payload) => broadcastToRenderer('p3394.bridge.push', payload),
});

export function register(): void {
  // Desktop live-refresh rail: every persisted group-chat message (external
  // channel inbound included — nothing in the renderer holds a stream for
  // those conversations) is pushed to all windows so the sidebar and the
  // open conversation can refresh without a manual reload.
  setGroupChatMessageBroadcaster((info) => {
    broadcastToRenderer('conversations:updated', info);
  });

  const handleInvoke = async (event, request: unknown) => {
    if (!isTrustedIpcSender(event.sender)) {
      log.warn('rejected invoke from untrusted renderer');
      return { ok: false, error: 'untrusted ipc sender', code: 'E_IPC_SENDER' };
    }
    const envelope = parseInvokeEnvelope(request);
    if (!envelope) return { ok: false, error: 'invalid ipc request', code: 'E_IPC_REQUEST' };
    const { channel, payload } = envelope;
    const handler = invokeHandlers[channel];
    if (!handler) return { ok: false, error: `unknown channel: ${channel}` };
    try {
      const ctx = await resolveContext(event.sender);
      const result = await handler(payload || {}, ctx);
      return { ok: true, ...(result || {}) };
    } catch (err) {
      const normalized = normalizeAppError(err);
      const rawCode = (err as { code?: unknown }).code;
      const code = typeof rawCode === 'number'
        ? rawCode
        : (typeof rawCode === 'string' && /^\d+$/.test(rawCode.trim())
          ? Number(rawCode.trim())
          : (typeof rawCode === 'string' && rawCode ? rawCode : normalized.code));
      log.error(`invoke ${channel} failed`, { error: normalized.error, code });
      const out: {
        ok: false;
        error: string;
        code: string | number;
        marketplaceKind?: string;
        marketplaceId?: string;
        marketplaceName?: string;
        marketplaceReason?: string;
        marketplaceAppUpdateRequired?: boolean;
        marketplaceMinAppVersion?: string;
        marketplaceCurrentAppVersion?: string;
        qualityReport?: unknown;
        promotionReasons?: string[];
        securityBlocked?: boolean;
        securityUnavailable?: boolean;
        securityOverridable?: boolean;
        securityScan?: unknown;
        securityRuleIds?: string[];
      } = {
        ok: false,
        error: normalized.error,
        code,
      };
      const qualityReport = (err as { qualityReport?: unknown }).qualityReport;
      if (qualityReport) out.qualityReport = qualityReport;
      // 晋升闸门的拦截原因（PromotionBlockedError.reasons）。message 只是把它们
      // 拼成一句内部英文；渲染层要按原因逐条翻译，就必须拿到码本身。
      const promotionReasons = (err as { reasons?: unknown }).reasons;
      if (Array.isArray(promotionReasons) && promotionReasons.every((reason) => typeof reason === 'string')) {
        out.promotionReasons = promotionReasons as string[];
      }
      const installInfo = marketplace.getMarketplaceInstallErrorInfo(err);
      if (installInfo.kind) {
        out.marketplaceKind = installInfo.kind;
        if (installInfo.id) out.marketplaceId = installInfo.id;
        if (installInfo.name) out.marketplaceName = installInfo.name;
        if (installInfo.reason) out.marketplaceReason = installInfo.reason;
      }
      if (installInfo.appUpdateRequired) {
        out.marketplaceAppUpdateRequired = true;
        out.marketplaceMinAppVersion = installInfo.minAppVersion || '';
        out.marketplaceCurrentAppVersion = installInfo.currentAppVersion || '';
      }
      // Security verdict fields, mirrored so the renderer's risk card can fire.
      // Dropped here by a refactor once before; the card code below it kept
      // reading these fields and silently never matched.
      if (installInfo.securityBlocked === true) out.securityBlocked = true;
      if (installInfo.securityUnavailable === true) out.securityUnavailable = true;
      if (installInfo.securityOverridable === true) out.securityOverridable = true;
      if (installInfo.securityScan) out.securityScan = installInfo.securityScan;
      if (Array.isArray(installInfo.securityRuleIds) && installInfo.securityRuleIds.length) {
        out.securityRuleIds = installInfo.securityRuleIds;
      }
      return out;
    }
  };

  // File objects cannot cross the regular JSON invoke envelope without being
  // copied into base64. Preload resolves only genuine user-selected DOM File
  // objects through Electron `webUtils.getPathForFile` and sends their paths
  // on this private channel; the renderer never receives a raw local path.
  const handleImportLocalFiles = async (event, request: unknown) => {
    if (!isTrustedIpcSender(event.sender)) {
      log.warn('rejected local file import from untrusted renderer');
      return { ok: false, error: 'untrusted ipc sender', code: 'E_IPC_SENDER' };
    }
    if (!request || typeof request !== 'object') {
      return { ok: false, error: 'invalid import request', code: 'E_IPC_REQUEST' };
    }
    try {
      const ctx = await resolveContext(event.sender);
      const result = await _importLocalFileEntries(request, ctx);
      return { ok: true, ...result };
    } catch (err) {
      const normalized = normalizeAppError(err);
      log.warn('local file import request failed', {
        code: normalized.code,
        error: normalized.error,
      });
      return { ok: false, error: normalized.error, code: normalized.code };
    }
  };
  ipcMain.handle('cogseed.invoke', handleInvoke);

  const handleStreamStart = async (event, request: unknown) => {
    if (!isTrustedIpcSender(event.sender)) return;
    const envelope = parseStreamEnvelope(request);
    if (!envelope) return;
    const { requestId, channel, payload } = envelope;
    // 逐 token 的 process 事件每发一条都是一次 IPC 序列化 + 渲染层一次
    // SSE 解析，流式高峰期（~50 事件/秒 × 若干并发流）会淹没主→渲染
    // 通道。把相邻的 process 事件打包成数组一次发送，preload 拆包后
    // 逐个回调 —— 渲染层事件语义与顺序完全不变，只减少消息数。
    // 非 process 事件（message / turn_end / done / error 等结构事件）
    // 立即发送，不引入可感知延迟。
    const pending: unknown[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    const flushBatch = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!pending.length) return;
      if (event.sender.isDestroyed()) return;
      const batch = pending.splice(0, pending.length);
      event.sender.send(`stream:${requestId}`, batch);
    };
    const out = (ev: unknown) => {
      if (event.sender.isDestroyed()) return;
      if (ev && typeof ev === 'object' && (ev as { type?: string }).type === 'process') {
        pending.push(ev);
        if (pending.length >= STREAM_BATCH_MAX) {
          flushBatch();
        } else if (!flushTimer) {
          flushTimer = setTimeout(flushBatch, STREAM_BATCH_WINDOW_MS);
        }
        return;
      }
      flushBatch();
      event.sender.send(`stream:${requestId}`, ev);
    };

    const handler = streamHandlers[channel];
    if (!handler) {
      out({ type: 'error', text: `unknown stream channel: ${channel}` });
      out({ type: 'done' });
      return;
    }

    if (activeStreams.has(requestId)) {
      out({ type: 'error', text: 'duplicate stream request id' });
      out({ type: 'done' });
      return;
    }
    const controller = new AbortController();
    const state: StreamState = { cancelled: false, controller, sender: event.sender };
    activeStreams.set(requestId, state);
    log.info(`streamStart channel=${channel} requestId=${requestId} cid=${payload?.cid || payload?.id || payload?.agent_id || ''}`);
    try {
      const ctx = await resolveContext(event.sender);
      for await (const ev of handler(payload || {}, ctx, controller.signal)) {
        if (state.cancelled) break;
        if (ev && ev.type === 'done') continue; // normalize below
        out(ev);
      }
    } catch (err) {
      log.error(`stream ${channel} failed`, { error: (err as Error)?.message || String(err) });
      out({ type: 'error', text: (err as Error).message || String(err) });
    } finally {
      activeStreams.delete(requestId);
      log.info(`streamDone channel=${channel} requestId=${requestId} cancelled=${state.cancelled}`);
      out({ type: 'done' });
    }
  };
  ipcMain.on('cogseed.streamStart', handleStreamStart);

  const handleStreamCancel = (event, rawRequestId: unknown) => {
    if (!isTrustedIpcSender(event.sender)) return;
    const requestId = parseStreamRequestId(rawRequestId);
    if (!requestId) return;
    const state = activeStreams.get(requestId);
    if (!state) {
      log.warn(`streamCancel: unknown requestId=${requestId}`);
      return;
    }
    if (state.sender !== event.sender) {
      log.warn(`streamCancel: sender mismatch requestId=${requestId}`);
      return;
    }
    log.info(`streamCancel requestId=${requestId}`);
    state.cancelled = true;
    // Propagate the cancel into the generator's async work — in particular
    // the in-flight LLM HTTP call inside `streamChatWithModel`. Without this
    // the `for await` loop above only breaks on the *next* yield, which can
    // be minutes away while the provider is blocked on network I/O, and the
    // `processing` flag stays pinned until the generator's finally runs.
    try { state.controller.abort(); } catch (_) { /* already aborted */ }
  };
  ipcMain.on('cogseed.streamCancel', handleStreamCancel);
}
