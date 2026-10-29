/**
 * 接访回合里的逐次写入与 shell 审批（设计 §3.6 L3）。
 *
 * 设计把「写/执行/连接器」都放进同一个审批弹窗，并路由给接收方本人。执行（bash）与
 * 连接器在隔离运行时内核里自带审批客户端，**SDK shell 只有风险分类审批**，写工具只跑
 * `beforeAction` 预检。所以接待会话一旦允许写（L2 = `explicit_writable_roots`），
 * 就必须在宿主预检这一层补一次逐次审批，否则「能写」等于「不问就写」。
 *
 * SDK 从宿主入站来源绑定到具体回合；同一双向会话里的本人回合不注入审批。
 */

import * as crypto from 'node:crypto';
import { createLogger } from '../../logger';
import { t } from '../../i18n';
import { recordActionApprovalExecution, requestActionApproval, type ActionApprovalResult } from '../action_approval';
import { isA2AReceptionRequest } from '../cogseed_backend/runtime-tool-policy';
import { isInboundMarker, parseA2AConversationMarker } from './conversation-marker';
import type { ChatOptions, ShellApprovalInput, ShellApprovalDecision } from '../../model/client';

const log = createLogger('a2a-reception-approval');

/** Only host-owned external inbound provenance (also carried into nested turns)
 * may select this gate. A CID's inbound marker alone cannot identify the turn. */
export async function receptionApprovalsForTurn(
  userId: string,
  conversationId: string,
  turnId: string,
  receptionSourceActorId?: string,
): Promise<Pick<ChatOptions, 'beforeWriteApproval' | 'beforeShellApproval'> | null> {
  if (!receptionSourceActorId) return null;
  const { getConversation } = await import('../chats');
  const { a2aPeerActorId } = await import('./reception-run');
  const conversation = await getConversation(userId, conversationId);
  const marker = parseA2AConversationMarker(conversation?.a2a);
  if (!marker || !isInboundMarker(marker) || marker.state !== 'active'
    || a2aPeerActorId(marker.peer_user_id) !== receptionSourceActorId) {
    throw new Error('E_ACTION_APPROVAL_UNAVAILABLE');
  }
  const identity = { userId, runtimeSessionId: `gchat:${conversationId}`, requestId: turnId };
  return {
    beforeWriteApproval: input => requestReceptionWriteApproval({
      ...identity, ...input, ...(marker.workspace ? { workingDir: marker.workspace } : {}),
    }, { isReception: async () => true }),
    beforeShellApproval: input => requestReceptionShellApproval({ ...identity, ...input }),
  };
}

export interface ReceptionShellApprovalInput extends ShellApprovalInput {
  userId: string;
  requestId: string;
  runtimeSessionId: string;
}

/** A fresh unified approval for every SDK shell invocation, including low-risk
 * commands. No risk-category grants or conversation permission mode apply. */
export async function requestReceptionShellApproval(
  input: ReceptionShellApprovalInput,
  deps: Pick<ReceptionWriteApprovalDeps, 'request'> = {},
): Promise<ShellApprovalDecision> {
  const actor = t('a2a.reception.shell_actor');
  const scope = t('a2a.reception.shell_scope', { workspace: input.workingDir });
  const fingerprint = crypto.createHash('sha256').update(canonical({
    actor, action: 'bash', target: input.command, scope,
    execution: { toolName: input.toolName, command: input.command, workingDir: input.workingDir },
  })).digest('hex');
  try {
    const result = await (deps.request ?? requestActionApproval)({
      userId: input.userId,
      runtimeSessionId: input.runtimeSessionId,
      runtimeRequestId: input.requestId,
      actor,
      action: 'bash',
      target: input.command,
      verbatimTarget: true,
      scope,
      auditTarget: 'Reception shell command',
      auditScope: `tool: ${input.toolName}`,
      risk: 'high',
      reasons: ['a2a_reception_shell'],
      fingerprint,
      signal: input.signal,
    });
    if (result.approved === true && result.requestId) {
      return {
        requestId: result.requestId,
        async record(requestId, phase, resultCode) {
          const recorded = await recordActionApprovalExecution({
            userId: input.userId, runtimeSessionId: input.runtimeSessionId,
            runtimeRequestId: input.requestId, requestId, phase, resultCode,
          });
          if (phase === 'started' && !recorded.handled) throw new Error('E_ACTION_APPROVAL_NOT_ACTIVE');
        },
      };
    }
    return result.approved === false ? result.code : 'E_ACTION_APPROVAL_UNAVAILABLE';
  } catch {
    log.warn('reception shell approval unavailable', { tool: input.toolName });
    return 'E_ACTION_APPROVAL_UNAVAILABLE';
  }
}

export interface ReceptionWriteApprovalInput {
  userId: string;
  requestId: string;
  runtimeSessionId: string;
  toolName: 'write_file' | 'edit_file';
  path: string;
  content: string;
  workingDir?: string;
}

/**
 * 会话级入口：只有「接收方 + active」的接访会话才需要逐次审批。
 * 返回 null 表示这次运行不是接访运行（普通会话的写路径保持不变）。
 */
export async function receptionWriteApprovalForConversation(
  userId: string,
  conversationId: string | null | undefined,
): Promise<((input: { toolName: 'write_file' | 'edit_file'; path: string; content: string }) => Promise<string | null>) | null> {
  const cid = String(conversationId || '').trim();
  if (!cid) return null;
  const { getConversation } = await import('../chats');
  const conversation = await getConversation(userId, cid).catch(() => null);
  const marker = parseA2AConversationMarker(conversation?.a2a);
  if (!marker || !isInboundMarker(marker) || marker.state !== 'active') return null;
  return (input) => requestReceptionWriteApproval({
    userId,
    // 群聊回合没有 runtime request/session id：用会话 id 拼一个稳定值，只用于审计。
    runtimeSessionId: `gchat:${cid}`,
    requestId: `gchat:${cid}`,
    toolName: input.toolName,
    path: input.path,
    content: input.content,
    ...(marker.workspace ? { workingDir: marker.workspace } : {}),
  }, {
    // 这里已经按会话 marker 判定过是接访运行；不能再走任务/会话表的二次判定
    // （群聊回合没有对应的 CogSeed task，二次判定会把接访误判成普通会话）。
    isReception: async () => true,
  });
}

export interface ReceptionWriteApprovalDeps {
  isReception?: typeof isA2AReceptionRequest;
  request?: (input: Parameters<typeof requestActionApproval>[0]) => Promise<ActionApprovalResult>;
  now?: () => number;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

/** 这次写要不要先问接收方。只有接访会话要。 */
export async function needsReceptionWriteApproval(
  input: Pick<ReceptionWriteApprovalInput, 'userId' | 'requestId' | 'runtimeSessionId'>,
  deps: ReceptionWriteApprovalDeps = {},
): Promise<boolean> {
  const isReception = deps.isReception ?? isA2AReceptionRequest;
  try {
    return await isReception(input.userId, input.requestId, input.runtimeSessionId);
  } catch {
    // 判定不了就按"不是接访"处理：这是普通会话的正常路径，不能因为一次查询失败
    // 就给所有人都弹审批；接访侧另有 L2 收紧兜底。
    return false;
  }
}

/**
 * 在接访会话里为一次写操作请求本人批准。
 *
 * 返回 `null` 表示可以继续写；返回字符串表示拒绝原因（直接交给内核作为工具错误）。
 */
export async function requestReceptionWriteApproval(
  input: ReceptionWriteApprovalInput,
  deps: ReceptionWriteApprovalDeps = {},
): Promise<string | null> {
  if (!(await needsReceptionWriteApproval(input, deps))) return null;

  const actor = 'A2A 接待助理';
  const scope = input.workingDir
    ? `仅在接待工作区 ${input.workingDir} 内写这一个文件，本次有效`
    : '仅写这一个文件，本次有效';
  const fingerprint = crypto.createHash('sha256').update(canonical({
    actor,
    action: input.toolName,
    target: input.path,
    scope,
    execution: { path: input.path, content: input.content },
  })).digest('hex');

  const request = deps.request ?? requestActionApproval;
  const result = await request({
    userId: input.userId,
    runtimeSessionId: input.runtimeSessionId,
    runtimeRequestId: input.requestId,
    actor,
    action: input.toolName,
    target: input.path,
    scope,
    // 审计只留类型，不留路径与内容。
    auditTarget: 'Sensitive file write',
    auditScope: `tool: ${input.toolName}`,
    risk: 'high',
    reasons: ['file_write'],
    fingerprint,
  });
  if ('requestId' in result) return null;
  log.info('reception write was not approved', { tool: input.toolName, code: result.code });
  return result.code;
}
