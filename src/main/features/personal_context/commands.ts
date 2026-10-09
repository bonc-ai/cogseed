/**
 * 个人上下文治理命令（/权限、/遗忘）——messaging 入站 slash 命令业务层。
 *
 * 接线：本模块把 handler 注册进 `messaging/commands.ts` 注册表（由
 * boot_init 的 deferred 阶段调用 `installPersonalContextCommands`），
 * messaging 入站链路识别命令后经注册表分发到这里，回复走 ledger-backed
 * 投递（manager.ts 命令分支），不消耗 agent turn。
 *
 * - /权限：只读展示授权全景（连接状态 / 已接入资源数 / 待审批候选数）；
 * - /遗忘 <scope>：预览（不执行）→ 快照进内存（TTL 10 分钟）→
 *   /遗忘 确认 执行快照 / /遗忘 取消 放弃。快照绑定预览时刻，确认期间
 *   新同步到达的数据不会扩大执行面（草案 §4.1）。
 */

import { registerInboundCommand, type InboundCommandContext, type InboundCommandOutcome } from '../messaging/commands';
import { getStatus } from './manager';
import { PersonalContextRegistry } from './registry';
import { listCandidates } from '../personal_ontology_candidates';
import {
  parseForgetScope,
  previewForget,
  executeForget,
  describeScope,
  type ForgetPreview,
  type ForgetScope,
} from './forget';
import { createLogger } from '../../logger';
import { registerDeferred } from '../../util/boot_init';

const log = createLogger('personal-context:commands');

const registryStore = new PersonalContextRegistry();

/** 遗忘预览快照（确认期间 scope 固定，防新数据扩大执行面） */
interface ForgetSnapshot {
  scope: ForgetScope;
  preview: ForgetPreview;
  previewedAt: number;
}

const FORGET_PREVIEW_TTL_MS = 10 * 60 * 1000;
const forgetSnapshots = new Map<string, ForgetSnapshot>();

function snapshotKey(uid: string, ctx: InboundCommandContext): string {
  return `${uid}\u0000${ctx.instance.id}\u0000${ctx.envelope.externalChatId}`;
}

function takeSnapshot(uid: string, ctx: InboundCommandContext, scope: ForgetScope, preview: ForgetPreview): void {
  forgetSnapshots.set(snapshotKey(uid, ctx), { scope, preview, previewedAt: Date.now() });
}

function readSnapshot(uid: string, ctx: InboundCommandContext): ForgetSnapshot | null {
  const snap = forgetSnapshots.get(snapshotKey(uid, ctx));
  if (!snap) return null;
  if (Date.now() - snap.previewedAt > FORGET_PREVIEW_TTL_MS) {
    forgetSnapshots.delete(snapshotKey(uid, ctx));
    return null;
  }
  return snap;
}

function clearSnapshot(uid: string, ctx: InboundCommandContext): void {
  forgetSnapshots.delete(snapshotKey(uid, ctx));
}

// ── /权限 ────────────────────────────────────────────────────────────────

export interface PermissionViewData {
  statusText: string;
  resourceCount: number;
  calendarEventCount: number;
  pendingCandidateCount: number;
  forgetInFlight: boolean;
}

/** 只读展示文本组装（纯函数，可单测）。 */
export function formatPermissionView(data: PermissionViewData): string {
  const lines = [
    '【个人上下文 · 授权全景】',
    `• 飞书连接：${data.statusText}`,
    `• 已接入资源：${data.resourceCount} 个（其中日历事件 ${data.calendarEventCount} 条）`,
    `• 待审批候选：${data.pendingCandidateCount} 条`,
  ];
  if (data.forgetInFlight) {
    lines.push(`• 有进行中的遗忘预览：回复 /遗忘 确认 执行，/遗忘 取消 放弃`);
  }
  return lines.join('\n');
}

async function handlePermission(ctx: InboundCommandContext): Promise<InboundCommandOutcome> {
  const { uid } = ctx;
  let statusText = '未连接';
  try {
    const status = await getStatus(uid, 'feishu');
    if (status.kind === 'connected') statusText = '已连接';
    else if (status.kind === 'error') statusText = `异常（${status.error || '未知原因'}）`;
    else if (status.kind === 'connecting') statusText = '连接中';
    else statusText = '未连接（可用 /权限 查看接入指引，或在设置中发起连接）';
    if (status.kind === 'connected' && status.needsReauth) statusText = '令牌已失效，需要重新授权';
  } catch (err) {
    log.warn('permission status lookup failed', { error: (err as Error).message });
  }

  let resourceCount = 0;
  let calendarEventCount = 0;
  try {
    resourceCount = await registryStore.count(uid);
    calendarEventCount = await registryStore.count(uid, { types: ['calendar_event'] });
  } catch (err) {
    log.warn('permission registry count failed', { error: (err as Error).message });
  }

  let pendingCandidateCount = 0;
  try {
    const pending = await listCandidates(uid);
    pendingCandidateCount = pending.candidate_updates.length;
  } catch (err) {
    log.warn('permission candidate count failed', { error: (err as Error).message });
  }

  const text = formatPermissionView({
    statusText,
    resourceCount,
    calendarEventCount,
    pendingCandidateCount,
    forgetInFlight: !!readSnapshot(uid, ctx),
  });
  return { consumed: true, replyText: text };
}

// ── /遗忘 ────────────────────────────────────────────────────────────────

function formatPreviewText(preview: ForgetPreview): string {
  const lines = [
    `【遗忘预览 · ${preview.scopeKey}】`,
    `将影响：注册表资源 ${preview.counts.resources} 个、候选 ${preview.counts.candidates} 条、同步游标 ${preview.counts.cursorProviders} 个`,
    '本体已确认事实将保留（来源标记失效由本体管线处理）。',
    '回复 /遗忘 确认 执行；回复 /遗忘 取消 放弃。',
  ];
  return lines.join('\n');
}

async function handleForgetPreview(ctx: InboundCommandContext): Promise<InboundCommandOutcome> {
  const { uid } = ctx;
  const parsed = parseForgetScope(ctx.command.args);
  // strict:false 下需用字面量比较收窄判别联合。
  if (parsed.ok === false) {
    return { consumed: true, replyText: parsed.error };
  }
  const preview = await previewForget(uid, parsed.scope);
  takeSnapshot(uid, ctx, parsed.scope, preview);
  return { consumed: true, replyText: formatPreviewText(preview) };
}

async function handleForgetConfirm(ctx: InboundCommandContext): Promise<InboundCommandOutcome> {
  const { uid } = ctx;
  const snap = readSnapshot(uid, ctx);
  if (!snap) {
    return { consumed: true, replyText: '没有进行中的遗忘预览。先发送 /遗忘 <范围> 发起预览。' };
  }
  clearSnapshot(uid, ctx);
  const result = await executeForget(uid, snap.scope);
  const lines = [
    `【遗忘完成 · ${result.scopeKey}】`,
    `• 注册表资源失效 ${result.invalidatedResources} 个`,
    `• 候选驳回 ${result.rejectedCandidates} 条`,
    ...(result.resetCursors.length ? [`• 同步游标重置 ${result.resetCursors.join('、')}`] : ['• 无同步游标需要重置']),
    '如需恢复：重新授权后增量回填。',
  ];
  return { consumed: true, replyText: lines.join('\n') };
}

async function handleForgetCancel(ctx: InboundCommandContext): Promise<InboundCommandOutcome> {
  const { uid } = ctx;
  const had = readSnapshot(uid, ctx) !== null;
  clearSnapshot(uid, ctx);
  return { consumed: true, replyText: had ? '已取消遗忘预览。' : '没有进行中的遗忘预览。' };
}

async function handleForget(ctx: InboundCommandContext): Promise<InboundCommandOutcome> {
  switch (ctx.command.action) {
    case 'confirm': return handleForgetConfirm(ctx);
    case 'cancel': return handleForgetCancel(ctx);
    default: return handleForgetPreview(ctx);
  }
}

// ── 安装 ─────────────────────────────────────────────────────────────────

let installed = false;

/** 注册 /权限 /遗忘 handler。幂等；由 boot_init deferred 阶段调用。 */
export function installPersonalContextCommands(): void {
  if (installed) return;
  installed = true;
  registerInboundCommand('permission', handlePermission);
  registerInboundCommand('forget', handleForget);
  log.info('personal-context commands installed (/permission /forget)');
}

/** 测试辅助：重置安装状态并清理快照。 */
export function _resetPersonalContextCommandsForTest(): void {
  installed = false;
  forgetSnapshots.clear();
}

export { describeScope };

// boot 的 deferred 阶段安装命令 handler（注册表全局，与用户无关）。
registerDeferred('personal-context-commands-install', async () => {
  installPersonalContextCommands();
});
