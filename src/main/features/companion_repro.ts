/**
 * Companion Research Repro.
 *
 * Formal fixed-scene entry for Paper + GitHub repro work.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { conversationLayout } from '../util/project-layout';
import { appendJsonlAtomic, genId12, nowIso, readJsonSync, readJsonl, safeId, writeJsonSync } from '../storage';

export interface CompanionReproDraft {
  paper_title?: string;
  paper_selection: string;
  repo_url: string;
  commit: string;
  workspace_path: string;
  user_intent: string;
}

export interface ReferenceManifestFile {
  path: string;
  reason: string;
  size: number;
}

export interface ReferenceManifestSkippedFile {
  path: string;
  reason: string;
}

export interface ReferenceManifest {
  version: 1;
  repo_url: string;
  commit: string;
  paper_title?: string;
  paper_selection: string;
  included_files: ReferenceManifestFile[];
  skipped_files: ReferenceManifestSkippedFile[];
  sensitive_boundary: string[];
  workspace_path: string;
  read_time: string;
}

export interface ProjectContextKeyFile {
  path: string;
  reason: string;
  source: string;
}

export interface ProjectContextRevision {
  id: string;
  before: string;
  after: string;
  reason: string;
  decided_at: string;
}

export interface ProjectContext {
  version: 1;
  project_goal: string;
  tech_stack: string[];
  key_files: ProjectContextKeyFile[];
  sources: string[];
  uncertainties: string[];
  review_decisions: ProjectContextRevision[];
  updated_at: string;
}

export interface TaskContract {
  version: 1;
  goal: string;
  success_criteria: string[];
  context_refs: string[];
  plan: string[];
  risks: string[];
  requires_user_confirmation: true;
  confirmed_by: string | null;
  confirmed_at: string | null;
  updated_at: string;
}

export interface ReproExecutionState {
  status: 'not_started' | 'started' | 'failed_to_start';
  started_at?: string;
  message_cid?: string;
  sent_prompt?: string;
  error?: string;
  evidence_refs: string[];
}

export interface CompanionGuideMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  created_at: string;
}

export interface CompanionReproState {
  version: 1;
  cid: string;
  updated_at: string;
  draft: CompanionReproDraft | null;
  reference_manifest: ReferenceManifest | null;
  project_context: ProjectContext | null;
  task_contract: TaskContract | null;
  execution: ReproExecutionState | null;
  guide_messages: CompanionGuideMessage[];
}

export interface EvidenceEvent {
  version: 1;
  id: string;
  cid: string;
  type:
    | 'draft_saved'
    | 'reference_manifest_created'
    | 'project_context_generated'
    | 'project_context_revised'
    | 'task_contract_generated'
    | 'task_contract_confirmed'
    | 'guide_message_recorded'
    | 'execution_started'
    | 'execution_start_failed';
  summary: string;
  payload?: Record<string, unknown>;
  created_at: string;
}

export interface ReproExecutionAdapter {
  send(input: { text: string }): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface CompanionReproPaths {
  rootDir: string;
  stateFile: string;
  evidenceFile: string;
}

const VERSION = 1 as const;
const MAX_INCLUDED_FILES = 40;
const MAX_SCAN_DEPTH = 3;
const MAX_FILE_BYTES = 256 * 1024;
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build']);

function conversationRoot(uid: string, cid: string): string {
  return conversationLayout(uid, cid).groupDir;
}

export function companionReproPaths(uid: string, cid: string): CompanionReproPaths {
  const rootDir = path.join(conversationRoot(uid, cid), 'companion_repro');
  return {
    rootDir,
    stateFile: path.join(rootDir, 'state.json'),
    evidenceFile: path.join(rootDir, 'evidence.jsonl'),
  };
}

function ensureDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readStateFile(uid: string, cid: string): CompanionReproState | null {
  const { stateFile } = companionReproPaths(uid, cid);
  if (!fs.existsSync(stateFile)) return null;
  const raw = readJsonSync<unknown>(stateFile);
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<CompanionReproState>;
  if (value.version !== VERSION) return null;
  return {
    version: VERSION,
    cid,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : nowIso(),
    draft: value.draft && typeof value.draft === 'object' ? value.draft as CompanionReproDraft : null,
    reference_manifest: value.reference_manifest && typeof value.reference_manifest === 'object' ? value.reference_manifest as ReferenceManifest : null,
    project_context: value.project_context && typeof value.project_context === 'object' ? value.project_context as ProjectContext : null,
    task_contract: value.task_contract && typeof value.task_contract === 'object' ? value.task_contract as TaskContract : null,
    execution: value.execution && typeof value.execution === 'object' ? value.execution as ReproExecutionState : null,
    guide_messages: Array.isArray(value.guide_messages) ? value.guide_messages as CompanionGuideMessage[] : [],
  };
}

function writeStateFile(uid: string, cid: string, state: CompanionReproState): void {
  const { stateFile } = companionReproPaths(uid, cid);
  ensureDir(stateFile);
  writeJsonSync(stateFile, state);
}

async function appendEvidence(uid: string, cid: string, event: Omit<EvidenceEvent, 'version' | 'id' | 'cid' | 'created_at'>): Promise<EvidenceEvent> {
  const record: EvidenceEvent = {
    version: VERSION,
    id: `cevt-${genId12()}`,
    cid,
    created_at: nowIso(),
    ...event,
  };
  const { evidenceFile } = companionReproPaths(uid, cid);
  ensureDir(evidenceFile);
  await appendJsonlAtomic(evidenceFile, record);
  return record;
}

export async function readEvidence(uid: string, cid: string, limit = 50): Promise<EvidenceEvent[]> {
  const { evidenceFile } = companionReproPaths(uid, cid);
  const rows = await readJsonl<unknown>(evidenceFile, limit);
  return rows.filter((row): row is EvidenceEvent => {
    const item = row as EvidenceEvent;
    return !!item
      && item.version === VERSION
      && typeof item.id === 'string'
      && typeof item.cid === 'string'
      && typeof item.type === 'string'
      && typeof item.summary === 'string'
      && typeof item.created_at === 'string';
  });
}

export async function readCompanionReproState(uid: string, cid: string): Promise<CompanionReproState | null> {
  return readStateFile(uid, cid);
}

function createEmptyState(cid: string): CompanionReproState {
  return {
    version: VERSION,
    cid,
    updated_at: nowIso(),
    draft: null,
    reference_manifest: null,
    project_context: null,
    task_contract: null,
    execution: null,
    guide_messages: [],
  };
}

function guideMessage(role: CompanionGuideMessage['role'], text: string): CompanionGuideMessage {
  return { id: `cmsg-${genId12()}`, role, text, created_at: nowIso() };
}

function extractRepoUrl(text: string): string {
  return (text.match(/https?:\/\/[^\s]+/i)?.[0] || '').replace(/[),.;，。]+$/, '');
}

function extractCommit(text: string): string {
  const explicit = text.match(/(?:commit|版本|提交)\s*(?:是|:|=)?\s*([a-f0-9]{6,40})/i)?.[1];
  if (explicit) return explicit;
  return text.match(/\b[a-f0-9]{7,40}\b/i)?.[0] || '';
}

function looksLikeWorkspacePath(text: string): string {
  const trimmed = text.trim();
  if (path.isAbsolute(trimmed)) return trimmed;
  return text.match(/\/[^\s]+/)?.[0] || '';
}

function guideAssistantText(state: CompanionReproState): string {
  const draft = state.draft || { paper_selection: '', repo_url: '', commit: '', workspace_path: '', user_intent: '' };
  if (!draft.paper_selection) {
    return '可以。我先帮你建立论文复现任务。请把论文选区或你关心的实验段落贴过来，这会成为后续 ProjectContext 的依据。';
  }
  if (!draft.repo_url || !draft.commit) {
    return '收到论文选区。接下来请给我 GitHub 仓库地址和固定 commit，这样 ReferenceManifest 才能追溯到确定版本。';
  }
  if (!draft.workspace_path) {
    return '收到仓库和 commit。现在请给我本地 workspace 路径。我会读取 README、依赖和 examples，并跳过 .env、node_modules 等敏感或无关内容。';
  }
  if (!state.reference_manifest) {
    return '信息已齐。我会保存导入并生成 ReferenceManifest，记录读了哪些文件、跳过了哪些文件。';
  }
  if (!state.project_context) {
    return 'ReferenceManifest 已生成。下一步我可以生成 ProjectContext，请你检查系统理解是否正确。';
  }
  if (!state.task_contract) {
    return 'ProjectContext 已就绪。下一步我会生成 TaskContract，明确目标、成功标准、计划和风险。';
  }
  if (!state.task_contract.confirmed_at) {
    return 'TaskContract 已生成。请确认后再执行；确认前我不会启动 Commander / Hermes / Codex。';
  }
  return '任务契约已确认，可以开始交给 Commander / Hermes / Codex 执行。';
}

function isSensitivePath(rel: string): boolean {
  const parts = rel.split('/');
  return parts.some((part) => part.startsWith('.env') || part === '.git' || part === 'node_modules');
}

function shouldSkipDir(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

function fileReason(file: string): string {
  const lower = file.toLowerCase();
  if (lower.startsWith('readme')) return 'project entrypoint';
  if (lower === 'package.json') return 'node manifest';
  if (lower === 'pyproject.toml' || lower.startsWith('requirements')) return 'python manifest';
  if (lower === 'cargo.toml') return 'rust manifest';
  if (lower.startsWith('example')) return 'example';
  if (lower.startsWith('script') || lower.includes('/script')) return 'script';
  if (lower.startsWith('test') || lower.includes('/test')) return 'test';
  return 'workspace file';
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function inferTechStack(includedPaths: string[]): string[] {
  const tech = new Set<string>();
  for (const rel of includedPaths) {
    const base = path.basename(rel).toLowerCase();
    if (base === 'package.json') tech.add('Node.js');
    if (base === 'pyproject.toml' || base.startsWith('requirements')) tech.add('Python');
    if (base === 'cargo.toml') tech.add('Rust');
    if (base === 'go.mod') tech.add('Go');
  }
  return Array.from(tech);
}

function inferKeyFiles(included: ReferenceManifestFile[]): ProjectContextKeyFile[] {
  const priority: ProjectContextKeyFile[] = [];
  for (const item of included) {
    const lower = item.path.toLowerCase();
    if (lower.startsWith('readme') || lower === 'package.json' || lower === 'pyproject.toml' || lower.startsWith('requirements') || lower === 'cargo.toml') {
      priority.push({ path: item.path, reason: item.reason, source: 'reference_manifest' });
      continue;
    }
    if (lower.startsWith('examples/') || lower.startsWith('scripts/') || lower.startsWith('test/')) {
      priority.push({ path: item.path, reason: item.reason, source: 'reference_manifest' });
    }
  }
  return priority.slice(0, 8);
}

function summarizeGoal(draft: CompanionReproDraft, manifest: ReferenceManifest): string {
  const paper = draft.paper_title ? `${draft.paper_title}: ` : '';
  return `${paper}${draft.user_intent || 'Run the selected repro'} using ${path.basename(manifest.workspace_path) || 'workspace'}.`;
}

function summarizeDraftToTask(draft: CompanionReproDraft): string {
  return draft.user_intent || 'Run the selected reproduction task.';
}

function createUncertainty(manifest: ReferenceManifest): string[] {
  const uncertainties = [
    'README instructions may differ from the current local environment.',
    'The selected files may not contain the entire reproduction path.',
  ];
  if (!manifest.included_files.length) uncertainties.push('No workspace files were included in the manifest scan.');
  return uncertainties;
}

function scanWorkspace(workspacePath: string): { included: ReferenceManifestFile[]; skipped: ReferenceManifestSkippedFile[]; sensitiveBoundary: string[] } {
  const included: ReferenceManifestFile[] = [];
  const skipped: ReferenceManifestSkippedFile[] = [];
  const sensitiveBoundary = new Set<string>();

  const visit = (dir: string, relDir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir ? path.posix.join(relDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) {
          skipped.push({ path: `${rel}/`, reason: 'ignored directory' });
          continue;
        }
        visit(path.join(dir, entry.name), rel, depth + 1);
        continue;
      }
      if (included.length >= MAX_INCLUDED_FILES) break;
      if (isSensitivePath(rel)) {
        skipped.push({ path: rel, reason: 'sensitive' });
        sensitiveBoundary.add(path.posix.dirname(rel) === '.' ? rel : path.posix.dirname(rel));
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(path.join(dir, entry.name));
      } catch {
        skipped.push({ path: rel, reason: 'unreadable' });
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        skipped.push({ path: rel, reason: 'too_large' });
        continue;
      }
      included.push({ path: rel, reason: fileReason(rel), size: stat.size });
    }
  };

  visit(workspacePath, '', 0);
  return { included, skipped, sensitiveBoundary: Array.from(sensitiveBoundary) };
}

export async function saveDraft(uid: string, cid: string, draft: CompanionReproDraft): Promise<CompanionReproState> {
  if (!safeId(uid) || !safeId(cid)) throw new Error('invalid conversation identity');
  const state = readStateFile(uid, cid) || createEmptyState(cid);
  const scanned = scanWorkspace(draft.workspace_path);
  const manifest: ReferenceManifest = {
    version: VERSION,
    repo_url: draft.repo_url,
    commit: draft.commit,
    paper_title: draft.paper_title,
    paper_selection: draft.paper_selection,
    included_files: scanned.included,
    skipped_files: scanned.skipped,
    sensitive_boundary: scanned.sensitiveBoundary,
    workspace_path: draft.workspace_path,
    read_time: nowIso(),
  };
  const next: CompanionReproState = {
    ...state,
    draft,
    reference_manifest: manifest,
    updated_at: nowIso(),
  };
  writeStateFile(uid, cid, next);
  await appendEvidence(uid, cid, {
    type: 'draft_saved',
    summary: 'draft saved',
    payload: { repo_url: draft.repo_url, commit: draft.commit },
  });
  await appendEvidence(uid, cid, {
    type: 'reference_manifest_created',
    summary: 'reference manifest created',
    payload: { included_count: manifest.included_files.length, skipped_count: manifest.skipped_files.length },
  });
  return next;
}

function mergeGuideDraft(previous: CompanionReproDraft | null, text: string): CompanionReproDraft {
  const repoUrl = extractRepoUrl(text);
  const commit = extractCommit(text);
  const workspacePath = looksLikeWorkspacePath(text);
  const next: CompanionReproDraft = {
    paper_title: previous?.paper_title || '',
    paper_selection: previous?.paper_selection || '',
    repo_url: previous?.repo_url || '',
    commit: previous?.commit || '',
    workspace_path: previous?.workspace_path || '',
    user_intent: previous?.user_intent || '',
  };
  if (!next.user_intent) next.user_intent = text.trim();
  if (repoUrl) next.repo_url = repoUrl;
  if (commit) next.commit = commit;
  if (workspacePath && fs.existsSync(workspacePath)) next.workspace_path = workspacePath;
  const looksLikePaperSelection = !repoUrl
    && !workspacePath
    && text.trim().length >= 40
    && !/帮我|请帮|run|github|repo|commit|workspace|路径/i.test(text);
  if (!next.paper_selection && looksLikePaperSelection) next.paper_selection = text.trim();
  return next;
}

function draftReadyForManifest(draft: CompanionReproDraft | null): draft is CompanionReproDraft {
  return !!draft
    && !!draft.paper_selection?.trim()
    && !!draft.repo_url?.trim()
    && !!draft.commit?.trim()
    && !!draft.workspace_path?.trim()
    && !!draft.user_intent?.trim();
}

export async function submitGuideMessage(uid: string, cid: string, text: string): Promise<CompanionReproState> {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('empty guide message');
  let state = readStateFile(uid, cid) || createEmptyState(cid);
  const userMessage = guideMessage('user', trimmed);
  const draft = mergeGuideDraft(state.draft, trimmed);
  state = {
    ...state,
    draft,
    guide_messages: [...state.guide_messages, userMessage],
    updated_at: nowIso(),
  };
  writeStateFile(uid, cid, state);
  await appendEvidence(uid, cid, {
    type: 'guide_message_recorded',
    summary: 'guide user message recorded',
    payload: { role: 'user' },
  });
  if (draftReadyForManifest(draft) && !state.reference_manifest) {
    state = await saveDraft(uid, cid, draft);
  }
  const assistantMessage = guideMessage('assistant', guideAssistantText(state));
  const next: CompanionReproState = {
    ...state,
    guide_messages: [...state.guide_messages, assistantMessage],
    updated_at: nowIso(),
  };
  writeStateFile(uid, cid, next);
  await appendEvidence(uid, cid, {
    type: 'guide_message_recorded',
    summary: 'guide assistant message recorded',
    payload: { role: 'assistant' },
  });
  return next;
}

export async function generateProjectContext(uid: string, cid: string): Promise<ProjectContext> {
  const state = readStateFile(uid, cid);
  if (!state?.draft || !state.reference_manifest) throw new Error('draft not saved');
  const manifest = state.reference_manifest;
  const tech_stack = inferTechStack(manifest.included_files.map((item) => item.path));
  const key_files = inferKeyFiles(manifest.included_files);
  const context: ProjectContext = {
    version: VERSION,
    project_goal: summarizeGoal(state.draft, manifest),
    tech_stack,
    key_files,
    sources: [manifest.repo_url, manifest.workspace_path],
    uncertainties: createUncertainty(manifest),
    review_decisions: state.project_context?.review_decisions ? [...state.project_context.review_decisions] : [],
    updated_at: nowIso(),
  };
  const next: CompanionReproState = { ...state, project_context: context, updated_at: nowIso() };
  writeStateFile(uid, cid, next);
  await appendEvidence(uid, cid, {
    type: 'project_context_generated',
    summary: 'project context generated',
    payload: { tech_stack, key_files: key_files.map((item) => item.path) },
  });
  return context;
}

export async function applyProjectContextRevision(
  uid: string,
  cid: string,
  revision: { before: string; after: string; reason: string },
): Promise<ProjectContext> {
  const state = readStateFile(uid, cid);
  if (!state?.project_context) throw new Error('project context not generated');
  const nextRevision: ProjectContextRevision = {
    id: `crev-${genId12()}`,
    before: revision.before,
    after: revision.after,
    reason: revision.reason,
    decided_at: nowIso(),
  };
  const nextContext: ProjectContext = {
    ...state.project_context,
    review_decisions: [...state.project_context.review_decisions, nextRevision],
    updated_at: nowIso(),
  };
  const next: CompanionReproState = { ...state, project_context: nextContext, updated_at: nowIso() };
  writeStateFile(uid, cid, next);
  await appendEvidence(uid, cid, {
    type: 'project_context_revised',
    summary: 'project context revised',
    payload: { ...nextRevision },
  });
  return nextContext;
}

export async function generateTaskContract(uid: string, cid: string): Promise<TaskContract> {
  const state = readStateFile(uid, cid);
  if (!state?.draft || !state.project_context || !state.reference_manifest) throw new Error('project context not ready');
  const contract: TaskContract = {
    version: VERSION,
    goal: summarizeDraftToTask(state.draft),
    success_criteria: [
      'The selected repro command exits successfully.',
      'The run leaves a readable artifact or log.',
      'The execution evidence can be traced back to the manifest and project context.',
    ],
    context_refs: [state.reference_manifest.repo_url, state.reference_manifest.workspace_path],
    plan: [
      'Review the manifest and project context.',
      'Run the smallest reproducible command.',
      'Record the output and artifact evidence.',
    ],
    risks: [
      'Workspace dependency mismatch on this Mac.',
      'The minimal repro command may fail without extra setup.',
    ],
    requires_user_confirmation: true,
    confirmed_by: state.task_contract?.confirmed_by ?? null,
    confirmed_at: state.task_contract?.confirmed_at ?? null,
    updated_at: nowIso(),
  };
  const next: CompanionReproState = { ...state, task_contract: contract, updated_at: nowIso() };
  writeStateFile(uid, cid, next);
  await appendEvidence(uid, cid, {
    type: 'task_contract_generated',
    summary: 'task contract generated',
    payload: { goal: contract.goal },
  });
  return contract;
}

export async function confirmTaskContract(uid: string, cid: string, confirmedBy: string): Promise<TaskContract> {
  const state = readStateFile(uid, cid);
  if (!state?.task_contract) throw new Error('task contract not generated');
  const nextContract: TaskContract = {
    ...state.task_contract,
    confirmed_by: confirmedBy,
    confirmed_at: nowIso(),
    updated_at: nowIso(),
  };
  const next: CompanionReproState = { ...state, task_contract: nextContract, updated_at: nowIso() };
  writeStateFile(uid, cid, next);
  await appendEvidence(uid, cid, {
    type: 'task_contract_confirmed',
    summary: 'task contract confirmed',
    payload: { confirmed_by: confirmedBy },
  });
  return nextContract;
}

function renderExecutionPrompt(state: CompanionReproState): string {
  const draft = state.draft!;
  const context = state.project_context!;
  const contract = state.task_contract!;
  const refs = [
    `Repo: ${draft.repo_url}`,
    `Commit: ${draft.commit}`,
    `Workspace: ${draft.workspace_path}`,
    `Goal: ${context.project_goal}`,
    `Success criteria: ${contract.success_criteria.join(' | ')}`,
    `Plan: ${contract.plan.join(' | ')}`,
    `Risks: ${contract.risks.join(' | ')}`,
  ];
  return refs.join('\n');
}

export async function startExecution(
  uid: string,
  cid: string,
  adapter?: ReproExecutionAdapter,
): Promise<{ ok: true; execution: ReproExecutionState } | { ok: false; error: string }> {
  const state = readStateFile(uid, cid);
  if (!state?.draft || !state.reference_manifest || !state.project_context || !state.task_contract) {
    return { ok: false, error: 'task_contract_not_ready' };
  }
  if (!state.task_contract.confirmed_at) {
    return { ok: false, error: 'task_contract_not_confirmed' };
  }
  const prompt = renderExecutionPrompt(state);
  const execution: ReproExecutionState = {
    status: 'started',
    started_at: nowIso(),
    sent_prompt: prompt,
    evidence_refs: [],
  };
  const next: CompanionReproState = { ...state, execution, updated_at: nowIso() };
  writeStateFile(uid, cid, next);
  await appendEvidence(uid, cid, {
    type: 'execution_started',
    summary: 'execution started',
    payload: { prompt },
  });
  if (!adapter) return { ok: true, execution };
  try {
    const res = await adapter.send({ text: prompt });
    if (!res.ok) {
      const sendError = 'error' in res ? res.error : 'send_failed';
      execution.status = 'failed_to_start';
      execution.error = sendError;
      next.execution = execution;
      next.updated_at = nowIso();
      writeStateFile(uid, cid, next);
      await appendEvidence(uid, cid, {
        type: 'execution_start_failed',
        summary: 'execution start failed',
        payload: { error: sendError },
      });
      return { ok: false, error: sendError };
    }
    return { ok: true, execution };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    execution.status = 'failed_to_start';
    execution.error = error;
    next.execution = execution;
    next.updated_at = nowIso();
    writeStateFile(uid, cid, next);
    await appendEvidence(uid, cid, {
      type: 'execution_start_failed',
      summary: 'execution start failed',
      payload: { error },
    });
    return { ok: false, error };
  }
}

export async function readCompanionReproStateOrCreate(uid: string, cid: string): Promise<CompanionReproState> {
  return readStateFile(uid, cid) || createEmptyState(cid);
}
