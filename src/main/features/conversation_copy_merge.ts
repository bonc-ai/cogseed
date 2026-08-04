/**
 * Main-side conversation copy/merge workflows.
 *
 * This module deliberately owns the filesystem orchestration so a later IPC
 * layer can remain a thin validator/dispatcher. Copy preserves the durable
 * conversation shape and session history; merge creates a deterministic,
 * source-indexed Markdown context instead of concatenating raw sessions.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { t } from '../i18n';
import { createLogger } from '../logger';
import { logErrorRef, maskId } from '../util/log-redact';
import {
  appendJsonlAtomic,
  genId12,
  nowIso,
  safeId,
  writeJson,
} from '../storage';
import {
  conversationLayout,
  conversationMessageFile,
  conversationMessageReadFile,
} from '../util/project-layout';
import {
  createConversation,
  deleteConversation,
  getConversation,
  updateConversation,
  type Conversation,
  type MessageRecord,
} from './chats';
import {
  actorSessionId,
  buildGconvSessionId,
  buildGmemberSessionId,
  readMembers,
  readState,
  type Actor,
  type MembersFile,
  type StateFile,
} from './group_chat/state';
import { appendVisible, readSlice } from './group_chat/visibility';
import {
  collaborationPaths,
  readActiveCollaborationState,
  type CollaborationSnapshot,
} from './group_chat/collaboration';
import {
  cloneSessionForUser,
  readSessionMessagesForUser,
  writeMergedSessionSummaryForUser,
  type SessionMessageRecord,
} from '../model/core-agent/session-store';

const log = createLogger('conversation_copy_merge');

export interface CloneConversationResult {
  newConversation: Conversation;
  commanderSessionId: string;
  memberSessionIds: string[];
}

export interface AgentSummary {
  sourceCids: string[];
  markdown: string;
}

export interface MergeConversationResult {
  newConversation: Conversation;
  summaryMessage: string;
  agentSummaries: Record<string, AgentSummary>;
}

type ProjectHint = string | null | undefined;

function destinationProjectId(
  source: Conversation | undefined,
  opts: { projectIdHint?: string | null } | undefined,
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(opts || {}, 'projectIdHint')) {
    return opts?.projectIdHint || undefined;
  }
  return source?.project_id;
}

function mergeDestinationProjectId(
  sources: Conversation[],
  opts: { projectIdHint?: string | null },
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(opts, 'projectIdHint')) {
    return opts.projectIdHint || undefined;
  }
  const sourceProjects = new Set(sources.map((source) => source.project_id ?? null));
  if (sourceProjects.size > 1) {
    throw new Error('source conversations must share the same project when projectIdHint is not provided');
  }
  return sources[0]?.project_id;
}

function requireConversation(
  conversation: Conversation | null,
  cid: string,
): Conversation {
  if (!conversation) throw new Error(`conversation not found: ${cid}`);
  return conversation;
}

function copyTitle(title: string): string {
  return t('conversation.copy.title', { title: title || t('chat.default_title') });
}

function cloneConversationMetadata(source: Conversation, newCid: string, projectId?: string): Parameters<typeof createConversation>[1] {
  return {
    conversationId: newCid,
    kind: source.kind,
    agentId: source.agent_id,
    skillId: source.skill_id,
    title: copyTitle(source.title),
    ...(projectId ? { projectId } : {}),
    ...(source.origin_auto_task_id ? { originAutoTaskId: source.origin_auto_task_id } : {}),
  };
}

function cloneMembers(members: MembersFile): MembersFile {
  return {
    version: 1,
    actors: members.actors.map((actor) => ({ ...actor })),
  };
}

function cloneStateForNewConversation(state: StateFile): StateFile {
  // Whitelist durable workspace choices. New StateFile fields are transient by
  // default so authorization/workflow state cannot silently cross a cid.
  return {
    version: 1,
    status: 'idle',
    in_flight: [],
    last_active_at: nowIso(),
    ...(typeof state.workspace_dir === 'string' && state.workspace_dir
      ? { workspace_dir: state.workspace_dir }
      : {}),
    ...(typeof state.coding_project_dir === 'string' && state.coding_project_dir
      ? { coding_project_dir: state.coding_project_dir }
      : {}),
    ...(state.coding_project_dir && state.coding_project_dir_explicit === true
      ? { coding_project_dir_explicit: true }
      : {}),
  };
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const item = block as Record<string, unknown>;
    if (typeof item.text === 'string') parts.push(item.text);
    else if (typeof item.content === 'string') parts.push(item.content);
    else if (item.type === 'image') parts.push('[image reference omitted]');
  }
  return parts.join('\n').replace(/\s+/g, ' ').trim();
}

function compact(value: string, max = 800): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sourceMessageText(message: MessageRecord): string {
  const refs = [
    ...(message.attachments || []).map((name) => `[attachment: ${name}]`),
    ...(message.produced || []).map((name) => `[produced-file: ${name}]`),
    ...(message.artifacts || []).map((artifact) => `[artifact: ${artifact.title || artifact.id}]`),
  ];
  return compact([message.text, ...refs].filter(Boolean).join(' '));
}

function sourceSessionText(messages: SessionMessageRecord[]): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    const text = compact(textFromContent(message.content), 900);
    if (!text) continue;
    lines.push(`${message.role}: ${text}`);
  }
  return lines.slice(-24);
}

async function readAllJsonl<T>(file: string): Promise<T[]> {
  if (!fs.existsSync(file)) return [];
  const raw = await fsp.readFile(file, 'utf8');
  const records: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as T); } catch { /* ignore malformed legacy lines */ }
  }
  return records;
}

function sourceReferences(messages: MessageRecord[]): string[] {
  const refs = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments || []) refs.add(`attachment: ${attachment}`);
    for (const produced of message.produced || []) refs.add(`produced-file: ${produced}`);
    for (const artifact of message.artifacts || []) {
      refs.add(`artifact: ${artifact.title || artifact.id} (${artifact.id})`);
    }
  }
  return [...refs];
}

function cloneMessageWithSourceReferences(
  message: MessageRecord,
  sourceCid: string,
  sourceTitle: string,
): MessageRecord {
  const attachments = (message.attachments || []).map((name) => ({ name }));
  const produced = [...(message.produced || [])];
  const resourceReference = attachments.length || produced.length
    ? {
        source_cid: sourceCid,
        source_title: sourceTitle || sourceCid,
        source_msg_id: message.id,
        from_actor: message.from,
        source_ts: message.ts,
        text: message.text,
        ...(attachments.length ? { attachments } : {}),
        ...(produced.length ? { produced } : {}),
      }
    : null;
  const {
    attachments: _discardedAttachments,
    produced: _discardedProduced,
    artifacts,
    references,
    ...durableMessage
  } = message;
  return {
    ...durableMessage,
    ...(references?.length || resourceReference
      ? { references: [...(references || []), ...(resourceReference ? [resourceReference] : [])] }
      : {}),
    ...(artifacts?.length
      ? {
          artifacts: artifacts.map((artifact) => ({
            ...artifact,
            source_cid: artifact.source_cid || sourceCid,
          })),
        }
      : {}),
  };
}

async function rollbackDestination(
  userId: string,
  cid: string,
  projectIdHint: ProjectHint,
  originalError: unknown,
): Promise<never> {
  try {
    await deleteConversation(userId, cid, projectIdHint);
  } catch (rollbackError) {
    log.error('conversation copy/merge rollback failed', {
      user_id: maskId(userId),
      cid: maskId(cid),
      error: logErrorRef(rollbackError),
    });
  }
  throw originalError;
}

function collectAgentIds(source: Conversation, members: MembersFile): string[] {
  const ids = new Set<string>();
  if (source.agent_id) ids.add(source.agent_id);
  for (const actor of members.actors) {
    if (actor.kind === 'agent' && safeId(actor.id)) ids.add(actor.id);
  }
  return [...ids];
}

function agentWorkstreamMarkdown(
  agentId: string,
  sourceCid: string,
  sourceTitle: string,
  messages: SessionMessageRecord[],
  uiMessages: MessageRecord[],
  collaboration: CollaborationSnapshot | null,
): string {
  const sessionLines = sourceSessionText(messages);
  const uiLines = uiMessages
    .filter((message) => message.from === agentId || message.to.includes(agentId) || message.mentions?.includes(agentId))
    .map(sourceMessageText)
    .filter(Boolean)
    .slice(-12);
  const facts = collaboration?.facts_preview.map((item) => item.text).filter(Boolean) || [];
  const decisions = collaboration?.decisions_preview.map((item) => item.text).filter(Boolean) || [];
  const questions = collaboration?.open_questions_preview.map((item) => item.text).filter(Boolean) || [];
  const risks = collaboration?.risks_preview.map((item) => item.text).filter(Boolean) || [];
  const refs = sourceReferences(uiMessages);

  return [
    `### ${sourceTitle || sourceCid} (${sourceCid})`,
    '',
    '#### Source Workstreams',
    `- Agent: ${agentId}`,
    `- Source conversation: ${sourceCid}`,
    sessionLines.length ? sessionLines.map((line) => `- ${line}`).join('\n') : '- No private session transcript.',
    '',
    '#### Cross-cutting Facts',
    (facts.length ? facts : uiLines.slice(0, 4)).map((item) => `- ${compact(item)}`).join('\n') || '- None recorded.',
    '',
    '#### Current Responsibility',
    decisions.length ? decisions.map((item) => `- ${compact(item)}`).join('\n') : '- Preserve the source workstream responsibility and continue from its latest context.',
    '',
    '#### Open Questions',
    questions.map((item) => `- ${compact(item)}`).join('\n') || '- None recorded.',
    '',
    '#### Conflicts / Risks',
    risks.map((item) => `- ${compact(item)}`).join('\n') || '- None recorded.',
    '',
    '#### Resource Index',
    refs.map((item) => `- ${item} (source ${sourceCid}; body not copied)`).join('\n') || '- No source file bodies copied.',
  ].join('\n');
}

function buildAgentMarkdown(
  agentId: string,
  workstreams: Array<{
    cid: string;
    title: string;
    session: SessionMessageRecord[];
    messages: MessageRecord[];
    collaboration: CollaborationSnapshot | null;
  }>,
): string {
  return [
    `# Private Context: ${agentId}`,
    '',
    'This context preserves separate workstreams for the same agent. Source file bodies are not copied.',
    '',
    workstreams.map((workstream) => agentWorkstreamMarkdown(
      agentId,
      workstream.cid,
      workstream.title,
      workstream.session,
      workstream.messages,
      workstream.collaboration,
    )).join('\n\n'),
  ].join('\n');
}

function buildMergeSummary(
  title: string,
  sources: Conversation[],
  agentSummaries: Record<string, AgentSummary>,
  messagesByCid: Map<string, MessageRecord[]>,
): string {
  const sourceLines = sources.map((source) => `- ${source.title || source.conversation_id} (${source.conversation_id})`);
  const agentLines = Object.entries(agentSummaries).map(([agentId, summary]) => (
    `- ${agentId}: ${summary.sourceCids.join(', ')}`
  ));
  const risks = sources.flatMap((source) => (messagesByCid.get(source.conversation_id) || [])
    .filter((message) => /conflict|risk|冲突|风险/i.test(message.text))
    .map((message) => compact(message.text, 240)))
    .slice(0, 8);

  return [
    t('conversation.merge.heading', { count: sources.length, title }),
    '',
    `## ${t('conversation.merge.section.sources')}`,
    sourceLines.join('\n'),
    '',
    `## ${t('conversation.merge.section.decisions')}`,
    `- ${t('conversation.merge.decisions.merged')}`,
    '',
    `## ${t('conversation.merge.section.current_state')}`,
    `- ${t('conversation.merge.current_state.fresh_sessions')}`,
    '',
    `## ${t('conversation.merge.section.agent_context')}`,
    agentLines.join('\n') || `- ${t('conversation.merge.none_recorded')}`,
    '',
    `## ${t('conversation.merge.section.references')}`,
    `- ${t('conversation.merge.references.not_copied')}`,
    '',
    `## ${t('conversation.merge.section.open_questions')}`,
    `- ${t('conversation.merge.open_questions.review')}`,
    '',
    `## ${t('conversation.merge.section.risks')}`,
    risks.map((risk) => `- ${risk}`).join('\n') || `- ${t('conversation.merge.risks.none')}`,
  ].join('\n');
}

async function copyCollaborationTree(userId: string, sourceCid: string, destinationCid: string, sourceProject?: string | null, destinationProject?: string | null): Promise<void> {
  const sourceRoot = collaborationPaths(userId, sourceCid, sourceProject).rootDir;
  if (!fs.existsSync(sourceRoot)) return;
  const destinationRoot = collaborationPaths(userId, destinationCid, destinationProject).rootDir;
  await fsp.cp(sourceRoot, destinationRoot, { recursive: true, force: true });

  // Run/context files carry the source cid. Rewrite only JSON object fields;
  // event and context ids remain stable within the copied collaboration set.
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) files.push(full);
    }
  }
  await visit(destinationRoot);
  for (const file of files) {
    const raw = await fsp.readFile(file, 'utf8');
    const rewritten = raw.replaceAll(`"cid":"${sourceCid}"`, `"cid":"${destinationCid}"`)
      .replaceAll(`"cid": "${sourceCid}"`, `"cid": "${destinationCid}"`);
    if (rewritten !== raw) await fsp.writeFile(file, rewritten, 'utf8');
  }
}

async function writeMembersAndState(
  userId: string,
  cid: string,
  projectHint: ProjectHint,
  members: MembersFile,
  state: StateFile,
): Promise<void> {
  const layout = conversationLayout(userId, cid, projectHint);
  await fsp.mkdir(layout.groupDir, { recursive: true });
  await writeJson(layout.membersFile, members);
  await writeJson(layout.stateFile, state);
}

async function copyVisibleHistory(
  userId: string,
  destinationCid: string,
  messages: MessageRecord[],
  actorIds: string[],
  projectIdHint?: string | null,
): Promise<void> {
  for (const message of messages) {
    await appendVisible(userId, destinationCid, message, actorIds, projectIdHint);
  }
}

export async function cloneConversation(
  userId: string,
  sourceCid: string,
  opts: { projectIdHint?: string | null } = {},
): Promise<CloneConversationResult> {
  if (!safeId(sourceCid)) throw new Error('invalid source conversation id');
  const source = requireConversation(await getConversation(userId, sourceCid), sourceCid);
  const sourceProject = source.project_id ?? null;
  const destinationProject = destinationProjectId(source, opts);
  const sourceMessages = await readAllJsonl<MessageRecord>(
    conversationMessageReadFile(userId, sourceCid, sourceProject),
  );
  const messages = sourceMessages.map((message) => (
    cloneMessageWithSourceReferences(message, sourceCid, source.title)
  ));
  const members = cloneMembers(await readMembers(userId, sourceCid, sourceProject));
  const state = cloneStateForNewConversation(await readState(userId, sourceCid, sourceProject));
  const copiedAgentIds = members.actors
    .filter((actor) => actor.kind === 'agent')
    .map((actor) => actor.id);

  const destinationCid = genId12();
  const destination = await createConversation(
    userId,
    cloneConversationMetadata(source, destinationCid, destinationProject),
  );
  const destinationLayout = conversationLayout(userId, destinationCid, destinationProject);
  const sourceSessions = [
    source.session_id || buildGconvSessionId(sourceCid),
    ...members.actors
      .filter((actor) => actor.kind === 'agent')
      .map((actor) => actorSessionId(sourceCid, actor)),
  ];
  const destinationSessions = [
    buildGconvSessionId(destinationCid),
    ...members.actors
      .filter((actor) => actor.kind === 'agent')
      .map((actor) => buildGmemberSessionId(destinationCid, actor.id)),
  ];

  try {
    if (messages.length) {
      await fsp.writeFile(
        destinationLayout.messageFile,
        `${messages.map((item) => JSON.stringify(item)).join('\n')}\n`,
        'utf8',
      );
    }
    await writeMembersAndState(userId, destinationCid, destinationProject, members, state);
    await copyVisibleHistory(
      userId,
      destinationCid,
      messages,
      members.actors.map((actor) => actor.id),
      destinationProject,
    );
    await copyCollaborationTree(
      userId,
      sourceCid,
      destinationCid,
      sourceProject,
      destinationProject,
    );

    const enrichedDestination = await updateConversation(userId, destinationCid, {
      ...(source.pinned_at ? { pinned_at: source.pinned_at } : {}),
      ...(source.pin_state_updated_at ? { pin_state_updated_at: source.pin_state_updated_at } : {}),
      ...(source.title_manually_set ? { title_manually_set: true } : {}),
      agent_ids: [...new Set([...(source.agent_ids || []), ...copiedAgentIds])],
      commander_in_chat: source.commander_in_chat === true,
    }, destinationProject);

    for (let i = 0; i < sourceSessions.length; i++) {
      await cloneSessionForUser(userId, sourceSessions[i], destinationSessions[i]);
    }

    return {
      newConversation: enrichedDestination || destination,
      commanderSessionId: buildGconvSessionId(destinationCid),
      memberSessionIds: destinationSessions.slice(1),
    };
  } catch (err) {
    return rollbackDestination(userId, destinationCid, destinationProject, err);
  }
}

export async function mergeConversations(
  userId: string,
  sourceCids: string[],
  opts: { title: string; projectIdHint?: string | null },
): Promise<MergeConversationResult> {
  const uniqueCids = [...new Set(sourceCids)];
  if (uniqueCids.some((cid) => !safeId(cid))) {
    throw new Error('all source conversation ids must be valid');
  }
  if (uniqueCids.length < 2) {
    throw new Error('at least two distinct source conversations are required');
  }
  const sources = await Promise.all(uniqueCids.map(async (cid) => (
    requireConversation(await getConversation(userId, cid), cid)
  )));
  const destinationProject = mergeDestinationProjectId(sources, opts);

  const messagesByCid = new Map<string, MessageRecord[]>();
  const workstreams = new Map<string, Array<{
    cid: string;
    title: string;
    session: SessionMessageRecord[];
    messages: MessageRecord[];
    collaboration: CollaborationSnapshot | null;
  }>>();
  const mergedActors = new Map<string, Actor>();

  for (const source of sources) {
    const project = source.project_id ?? null;
    const messages = await readAllJsonl<MessageRecord>(
      conversationMessageReadFile(userId, source.conversation_id, project),
    );
    messagesByCid.set(source.conversation_id, messages);
    const members = await readMembers(userId, source.conversation_id, project);
    for (const actor of members.actors) {
      if (!mergedActors.has(actor.id)) mergedActors.set(actor.id, { ...actor });
    }
    const collaboration = await readActiveCollaborationState(
      userId,
      source.conversation_id,
      project,
    );
    for (const agentId of collectAgentIds(source, members)) {
      const sessionId = buildGmemberSessionId(source.conversation_id, agentId);
      const session = await readSessionMessagesForUser(userId, sessionId);
      const visibleMessages = await readSlice(
        userId,
        source.conversation_id,
        agentId,
        10_000,
        project,
      );
      const list = workstreams.get(agentId) || [];
      list.push({
        cid: source.conversation_id,
        title: source.title,
        session,
        messages: visibleMessages,
        collaboration: collaboration?.snapshot || null,
      });
      workstreams.set(agentId, list);
    }
  }

  const agentSummaries: Record<string, AgentSummary> = {};
  for (const [agentId, streams] of workstreams) {
    agentSummaries[agentId] = {
      sourceCids: streams.map((stream) => stream.cid),
      markdown: buildAgentMarkdown(agentId, streams),
    };
  }
  const summaryMessage = buildMergeSummary(opts.title, sources, agentSummaries, messagesByCid);
  const allActors = [...mergedActors.values()];
  if (!allActors.some((actor) => actor.kind === 'commander')) {
    allActors.unshift({ kind: 'commander', id: 'commander', name: 'Commander', joined_at: nowIso() });
  }
  if (!allActors.some((actor) => actor.kind === 'user')) {
    allActors.push({ kind: 'user', id: 'user', name: 'User', joined_at: nowIso() });
  }
  const state = cloneStateForNewConversation(
    await readState(userId, sources[0].conversation_id, sources[0].project_id ?? null),
  );

  const destination = await createConversation(userId, {
    title: opts.title,
    ...(destinationProject ? { projectId: destinationProject } : {}),
  });
  const destinationCid = destination.conversation_id;

  try {
    await writeMembersAndState(
      userId,
      destinationCid,
      destinationProject,
      { version: 1, actors: allActors },
      state,
    );
    const summaryRecord: MessageRecord = {
      id: `msg-${genId12()}`,
      ts: nowIso(),
      from: 'commander',
      to: allActors.map((actor) => actor.id),
      text: summaryMessage,
    };
    await appendJsonlAtomic(
      conversationMessageFile(userId, destinationCid, destinationProject),
      summaryRecord,
    );
    await appendVisible(
      userId,
      destinationCid,
      summaryRecord,
      allActors.map((actor) => actor.id),
      destinationProject,
    );

    await writeMergedSessionSummaryForUser(userId, buildGconvSessionId(destinationCid), [{
      role: 'system',
      content: [{ type: 'text', text: summaryMessage }],
    }], summaryMessage);
    for (const [agentId, summary] of Object.entries(agentSummaries)) {
      await writeMergedSessionSummaryForUser(userId, buildGmemberSessionId(destinationCid, agentId), [{
        role: 'system',
        content: [{ type: 'text', text: summary.markdown }],
      }], summary.markdown);
    }

    return { newConversation: destination, summaryMessage, agentSummaries };
  } catch (err) {
    return rollbackDestination(userId, destinationCid, destinationProject, err);
  }
}
