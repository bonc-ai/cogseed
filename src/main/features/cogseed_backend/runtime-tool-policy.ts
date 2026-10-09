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
 *               shouldAutoApproveRuntimeAction() 判定为「无需弹窗直接放行」。
 *   - skillRun  维持既有语义（仅当 Agent 带 skill 白名单时在 executor 升级），
 *               这里保持 none，不放大能力。
 */
import { COGSEED_RUNTIME_TOOL_POLICY } from '../cogseed_runtime/kernel/config';
import type { RuntimeToolPolicy } from '../cogseed_runtime/kernel/types';
import { getConversation } from '../chats';
import { readCogSeedSession } from './session-store';
import { readCogSeedTaskByRequestId } from './task-store';

export type PersistedPermissionMode = 'full' | 'auto_approve' | 'ask';

/** 纯函数：权限模式 + 工作区 → 工具策略。三种模式在 shell 上都走
 *  allow_with_confirmation，差异只体现在「高风险是否还需要人点确认」，
 *  那一步由 shouldAutoApproveRuntimeAction() 在宿主侧决定。 */
export function deriveRuntimeToolPolicy(
  _mode: PersistedPermissionMode,
  workingDir?: string | null,
): RuntimeToolPolicy {
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
  const raw = conversation?.permission_mode;
  const mode: PersistedPermissionMode = raw === 'full' || raw === 'auto_approve' ? raw : 'ask';
  return deriveRuntimeToolPolicy(mode, workingDir);
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
  return mode === 'full' || mode === 'auto_approve' || mode === 'ask' ? mode : 'ask';
}

/** 'full' / 'auto_approve' 表示用户已经选择「不用逐条问我」，高风险动作直接放行。 */
export async function shouldAutoApproveRuntimeAction(
  userId: string,
  requestId: string,
  runtimeSessionId: string,
): Promise<boolean> {
  const mode = await persistedPermissionMode(userId, requestId, runtimeSessionId);
  return mode === 'full' || mode === 'auto_approve';
}
