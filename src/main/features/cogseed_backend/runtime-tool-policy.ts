/**
 * 主进程侧的「本次运行工具策略」推导。与 capabilities 同一条纪律：
 * 只从持久化记录（conversation / task → session）推导，worker 与模型都不得自述；
 * host 侧每次需要时重新推导，而不是相信请求里的值。
 *
 * 口径（方案 A）：
 *   - 来源是会话的 `permission_mode`（'full' | 'auto_approve' | 'ask'，由用户在
 *     对话框权限选择器里设定，和 CLI 路径用的是同一个值）。缺省/未知按 'ask'。
 *   - fileRead  explicit_roots；fileWrite explicit_writable_roots（只写自己的工作区，
 *     没有工作区就退回 none）
 *   - shell     allow_with_confirmation：低风险命令直接跑，高风险走既有
 *               action-approval 确认通道；'full' / 'auto_approve' 由
 *               shouldAutoApproveRuntimeAction() 判定为「无需弹窗直接放行」。接访低风险
 *               命令也必须经宿主 preflight 逐次审批，不能走普通低风险直通。
 *   - skillRun  维持既有语义（仅当 Agent 带 skill 白名单时在 executor 升级），
 *               这里保持 none，不放大能力。
 */
import { COGSEED_RUNTIME_TOOL_POLICY } from '../cogseed_runtime/kernel/config';
import type { RuntimeToolPolicy } from '../cogseed_runtime/kernel/types';
import { getConversation } from '../chats';
import { isReceptionRun, toolPolicyForConversation } from '../a2a/reception-scope';
import { readCogSeedSession } from './session-store';
import { readCogSeedTaskByRequestId } from './task-store';

export type PersistedPermissionMode = 'full' | 'auto_approve' | 'ask' | 'danger_full_access';

/** 纯函数：权限模式 + 工作区 → 工具策略。三种模式在 shell 上都走
 *  allow_with_confirmation，差异只体现在「高风险是否还需要人点确认」，
 *  那一步由 shouldAutoApproveRuntimeAction() 在宿主侧决定。 */
export function deriveRuntimeToolPolicy(
  mode: PersistedPermissionMode,
  workingDir?: string | null,
): RuntimeToolPolicy {
  if (mode === 'danger_full_access') {
    return {
      fileRead: 'all',
      fileWrite: 'all',
      shell: 'allow_with_confirmation',
      skillRun: 'none',
      network: 'none',
      connectors: 'enabled',
    };
  }
  return {
    fileRead: 'explicit_roots',
    fileWrite: workingDir ? 'explicit_writable_roots' : 'none',
    shell: 'allow_with_confirmation',
    skillRun: 'none',
    network: 'none',
    connectors: 'enabled',
  };
}

/** 会话级推导：legacy 会话没有该字段时与 CLI 路径一致地按 'ask' 处理；
 *  完全没有会话时保持最保守的 deny-all 默认。 */
export async function resolveRuntimeToolPolicyForRun(
  userId: string,
  conversationId?: string | null,
  workingDir?: string | null,
): Promise<RuntimeToolPolicy> {
  if (!conversationId) return COGSEED_RUNTIME_TOOL_POLICY;
  const conversation = await getConversation(userId, conversationId).catch(() => null);
  // A2A 接待只在授权工作区内读写；写与命令逐次审批，网络/连接器/技能关闭。
  const raw = conversation?.permission_mode;
  const mode: PersistedPermissionMode = raw === 'full' || raw === 'auto_approve' || raw === 'danger_full_access'
    ? raw
    : 'ask';
  const derived = deriveRuntimeToolPolicy(mode, workingDir);
  return toolPolicyForConversation(derived, conversation?.a2a ?? null) || derived;
}

/** 从持久化链路推导该次运行所属会话的权限模式；任何一环对不上就返回 null。 */
async function persistedPermissionMode(
  userId: string,
  requestId: string,
  runtimeSessionId: string,
): Promise<PersistedPermissionMode | null> {
  const task = await readCogSeedTaskByRequestId(userId, requestId);
  if (!task || task.runtimeSessionId !== runtimeSessionId) return null;
  const session = await readCogSeedSession(userId, task.sessionId);
  if (!session
    || session.ownerId !== userId
    || session.lifecycleState !== 'active'
    || session.runtimeSessionId !== runtimeSessionId) {
    return null;
  }
  if (!task.conversationId) return null;
  const conversation = await getConversation(userId, task.conversationId);
  const mode = conversation?.permission_mode;
  return mode === 'full' || mode === 'auto_approve' || mode === 'ask' || mode === 'danger_full_access' ? mode : 'ask';
}

/** 'full' / 'auto_approve' / 'danger_full_access' 表示用户已经选择「不用逐条问我」，高风险动作直接放行。 */
export async function shouldAutoApproveRuntimeAction(
  userId: string,
  requestId: string,
  runtimeSessionId: string,
): Promise<boolean> {
  const mode = await persistedPermissionMode(userId, requestId, runtimeSessionId);
  if (mode !== 'full' && mode !== 'auto_approve' && mode !== 'danger_full_access') return false;
  // A2A 接待（R-03）：接访会话即便设了 full/auto_approve/danger_full_access，写文件、
  // 执行命令、调连接器也必须由接收方本人逐次批准——对端的请求不是本人授权。
  if (await isA2AReceptionRequest(userId, requestId, runtimeSessionId)) return false;
  return true;
}

/** 这次运行是否属于一个「进行中的接访会话」。任何一环对不上都按否处理。 */
export async function isA2AReceptionRequest(
  userId: string,
  requestId: string,
  runtimeSessionId: string,
): Promise<boolean> {
  const task = await readCogSeedTaskByRequestId(userId, requestId);
  if (!task || task.runtimeSessionId !== runtimeSessionId || !task.conversationId) return false;
  // 一个联系人一条会话之后，会话本身不再区分「这次运行是回答来访，还是我在提问」。
  // 判据回到这次运行的来源消息：来自对端 actor（a2a_*，且不是对方的助理）才是接待。
  if (task.groupChatSourceMessageId) {
    try {
      const { getMessages } = await import('../chats');
      const rows = await getMessages(userId, task.conversationId, 500);
      const source = rows.find((row) => String((row as { id?: string }).id || '') === task.groupChatSourceMessageId);
      const from = String((source as { from?: string } | undefined)?.from || '');
      if (from) return from.startsWith('a2a_') && !from.endsWith('_assistant');
    } catch { /* 读不到来源消息就退回 marker 判定 */ }
  }
  const conversation = await getConversation(userId, task.conversationId);
  return isReceptionRun(conversation?.a2a ?? null);
}
