import { createLogger } from '../../logger';
import { readJsonl, rewriteJsonlLine, safeId, nowIso } from '../../storage';
import { mainJsonlFile, send } from './index.js';
import type { GroupMessage } from './visibility';

/**
 * Artifact 确认卡片专用通道（2026-09-14 Bug3 修复 + 评审补强）。
 *
 * 设计要点：
 * - 不经渲染层 FIFO 队列：主进程直达总线发送，避免 busy 标记死锁导致
 *   「待发送」卡死；
 * - 幂等：confirm / cancel 共用同一 in-flight 互斥（同 key 并发复用同一
 *   Promise），发送成功后才在消息体 artifacts[] 上落 confirm_state
 *   （confirmed / cancelled）——失败可重试，历史重渲染按状态回放只读卡；
 * - 已确认/已取消互斥：终态后再来任何动作一律返回对应 ALREADY_* 码，
 *   杜绝重复提交与「确认后又取消」的歧义。
 */

const log = createLogger('group_chat.confirm-cards');

export type ConfirmCardAction = 'confirm' | 'cancel';

export interface SendConfirmInput {
  userId: string;
  cid: string;
  artifactId: string;
  op: string;
  payload?: unknown;
  action?: ConfirmCardAction;
}

export interface SendConfirmResult {
  ok: boolean;
  code?: 'ALREADY_CONFIRMED' | 'ALREADY_CANCELLED' | 'CONFLICT';
  error?: string;
  confirm_state?: 'confirmed' | 'cancelled';
  confirmed_at?: string;
}

/** 并发互斥：同 key 的进行中请求复用同一 Promise（评审意见 #3）。 */
const inFlight = new Map<string, Promise<SendConfirmResult>>();

function flightKey(userId: string, cid: string, artifactId: string): string {
  return `${userId}:${cid}:${artifactId}`;
}

export async function sendConfirmAndMark(input: SendConfirmInput): Promise<SendConfirmResult> {
  const key = flightKey(input.userId, input.cid, input.artifactId);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const task = runConfirmTask(input).finally(() => { inFlight.delete(key); });
  inFlight.set(key, task);
  return task;
}

async function runConfirmTask(input: SendConfirmInput): Promise<SendConfirmResult> {
  const { userId, cid, artifactId, op } = input;
  const action: ConfirmCardAction = input.action === 'cancel' ? 'cancel' : 'confirm';
  if (!safeId(cid) || !safeId(artifactId)) return { ok: false, error: 'invalid cid/artifactId' };

  const file = mainJsonlFile(userId, cid);
  const all = await readJsonl<GroupMessage>(file, 100_000);
  // 按行索引定位（消息行可能没有 id 字段——历史/合成数据），
  // 写回时再按 artifactId 复核，防并发追加导致行位移。
  let ownerIdx = -1;
  let artIdx = -1;
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    if (!m || !Array.isArray(m.artifacts)) continue;
    const j = m.artifacts.findIndex((a) => a && a.id === artifactId);
    if (j >= 0) { ownerIdx = i; artIdx = j; break; }
  }
  if (ownerIdx < 0 || artIdx < 0) return { ok: false, error: 'artifact not found' };
  const ownerMsg = all[ownerIdx];
  const art = ownerMsg.artifacts![artIdx];

  // 终态互斥：confirmed / cancelled 后不再接受任何动作
  if (art.confirm_state === 'confirmed') {
    return { ok: false, code: 'ALREADY_CONFIRMED', error: '该确认卡片已提交过' };
  }
  if (art.confirm_state === 'cancelled') {
    return { ok: false, code: 'ALREADY_CANCELLED', error: '该确认卡片已取消' };
  }

  // 编码与渲染层 encodeArtifactResult 同构；agent_id 决定回路由
  const agentId = String(art.agent_id || '').trim();
  const routeToAgent = agentId && agentId !== 'commander';
  const mention = routeToAgent ? `@${agentId} ` : '';
  let json = '';
  try {
    json = action === 'cancel'
      ? JSON.stringify({ action: 'plugin-cancel', op })
      : JSON.stringify({ action: 'plugin-confirm', op, payload: input.payload });
  } catch { json = '"<unserialisable>"'; }
  const title = String(art.title || 'Interactive app');
  const text = `${mention}Result from "${title}"\n\n<artifact-result artifact_id="${artifactId}" agent_id="${agentId}">\n${json}\n</artifact-result>`;

  const sendRes = await send({
    userId,
    cid,
    text,
    ...(routeToAgent ? { recipient_agent_id: agentId, recipient_origin: 'user_selection' as const } : {}),
  });
  if (!sendRes.ok) return { ok: false, error: sendRes.error || 'send failed' };

  // 成功后才落标记（先标记后发送会让失败永久拒重试——WIP 缺陷修正）
  const state = action === 'cancel' ? 'cancelled' as const : 'confirmed' as const;
  const r = await rewriteJsonlLine<GroupMessage>(file, ownerIdx, (rec) => {
    if (!rec || !Array.isArray(rec.artifacts)) return null;
    const j = rec.artifacts.findIndex((a) => a && a.id === artifactId);
    if (j < 0) return null;
    const arts = rec.artifacts.map((a, i) =>
      i === j ? { ...a, confirm_state: state, confirm_op: op, confirmed_at: nowIso() } : a);
    return { ...rec, artifacts: arts };
  });
  if (r.ok === false) {
    log.warn(`confirm mark failed user=${userId} cid=${cid} artifactId=${artifactId} state=${state}: ${r.error}`);
  }
  log.info(`artifact-${state} user=${userId} cid=${cid} artifactId=${artifactId} op=${op}`);
  return { ok: true, confirm_state: state, confirmed_at: nowIso() };
}
