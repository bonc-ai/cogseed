/**
 * 贡献会话注册表 —— 把无状态的 IPC 调用串成一次贡献动作。
 *
 * ## 为什么需要它
 *
 * 一次贡献要经过「建副本 → 检查 → 补齐 → 重检 → 预览 → 确认 → 提交」多个来回，
 * 而 IPC 每次调用都是独立的。副本目录、上次预览摘要、上次准入结论必须跨调用保持，
 * 否则「补齐后是否重跑过检查」这种判定无从做起（`C-FR-004c`）。
 *
 * ## 为什么按 uid 分桶
 *
 * `C-FR-003` 边界情况：「贡献过程中账号登出或切换：进行中的检查/预览**立即终止**，
 * 不发出提交；重新登录后不得沿用旧账号的预览与声明」。按 uid 分桶使"终止该账号的
 * 全部会话"成为一次 O(1) 的删除，而不是遍历时逐个比对——后者漏一个就是跨账号泄漏。
 *
 * ## 为什么在内存里
 *
 * 会话含贡献者补齐时填入的真实声明内容。落盘会让一次未完成的贡献在磁盘上留下痕迹，
 * 而这些内容本就只该存在于"决定要发"之前。进程重启后副本由
 * `staging.cleanupOrphanedStaging` 清理，会话自然消失——这是期望行为，不是缺陷：
 * 重启后贡献者本就该重新确认预览。
 */
import { createLogger } from '../../logger';
import { destroyStaging, type ContributionStaging } from './staging';
import type { ContributionAdmission } from './admission';
import type { PreviewManifest } from './preview';
import type { PackageSnapshot } from './package';
import { emptyDeclarations, type Declarations } from './declarations';

const log = createLogger('contribution/session');

export interface ContributionSession {
  token: string;
  uid: string;
  staging: ContributionStaging;
  /** 最近一次准入结论。补齐后须重跑，`null` 表示尚未检查或已因变更作废。 */
  admission: ContributionAdmission | null;
  /** 最近一次贡献者确认过的预览。`null` 表示尚未确认或已因变更作废。 */
  confirmedPreview: PreviewManifest | null;
  /** Exact ZIP bytes bound to the confirmed preview; never crosses IPC. */
  confirmedPackage: PackageSnapshot | null;
  /** One key per confirmed contribution intent; transport retries reuse it. */
  idempotencyKey: string | null;
  /** 当前上传尝试；取消只中止传输，保留同键同字节供不确定结果重试。 */
  uploadController: AbortController | null;
  /**
   * 三项声明。与预览分开作废：改了内容要重看预览，但**已接受的条款不必重签**
   * （`C-FR-007`：条款改版后既有贡献不重签；这里指同一次会话内改内容不该
   * 让贡献者重勾条款）。来源声明同理——它描述的是内容的出处，不随文件改动失效。
   */
  declarations: Declarations;
  createdAt: number;
}

/** uid → token → session。分桶见模块文档。 */
const _sessions = new Map<string, Map<string, ContributionSession>>();

export function createSession(uid: string, staging: ContributionStaging): ContributionSession {
  const session: ContributionSession = {
    token: staging.token,
    uid,
    staging,
    admission: null,
    confirmedPreview: null,
    confirmedPackage: null,
    idempotencyKey: null,
    uploadController: null,
    declarations: emptyDeclarations(),
    createdAt: Date.now(),
  };
  let bucket = _sessions.get(uid);
  if (!bucket) { bucket = new Map(); _sessions.set(uid, bucket); }
  bucket.set(session.token, session);
  return session;
}

/**
 * 取会话。**uid 必须匹配**——不做跨账号查找。
 *
 * 只按 token 查会让一个账号用另一个账号的 token 拿到副本。token 虽是随机的，
 * 但"不可猜"不等于"可作为授权凭据"。
 */
export function getSession(uid: string, token: string): ContributionSession | null {
  return _sessions.get(uid)?.get(token) ?? null;
}

/** 结束一次会话并销毁副本。幂等——重复调用不抛错。 */
export async function endSession(uid: string, token: string): Promise<void> {
  const bucket = _sessions.get(uid);
  const session = bucket?.get(token);
  if (!session) return;
  session.uploadController?.abort();
  bucket!.delete(token);
  if (bucket!.size === 0) _sessions.delete(uid);
  await destroyStaging(session.staging);
}

/**
 * 终止某账号的全部会话。
 *
 * 登出、账号切换、以及贡献者显式取消时调用。副本一并销毁：里面可能含已填入的
 * 真实声明内容，留着既无意义又扩大暴露面。
 */
export async function endAllSessions(uid: string): Promise<number> {
  const bucket = _sessions.get(uid);
  if (!bucket) return 0;
  const sessions = [...bucket.values()];
  _sessions.delete(uid);
  for (const session of sessions) session.uploadController?.abort();
  await Promise.all(sessions.map((s) => destroyStaging(s.staging)));
  if (sessions.length) log.info('ended contribution sessions', { uid, count: sessions.length });
  return sessions.length;
}

/**
 * 副本变化后作废既有结论。
 *
 * `C-FR-004c`：补齐或更改副本任一文件后，MUST 重新执行全套检查并重新确认预览；
 * 之前的检查结果**不可沿用**。把作废做成一个显式动作，而不是指望每个调用方
 * 记得清——漏清一次就是"拿旧结论发了新内容"。
 */
export function invalidate(session: ContributionSession): void {
  session.admission = null;
  session.confirmedPreview = null;
  session.confirmedPackage = null;
  session.idempotencyKey = null;
  session.uploadController?.abort();
  session.uploadController = null;
  // **不清 declarations**：内容变了要重检重看，但不该让贡献者把条款重勾一遍。
  // 条款若在此期间改版，由 `termsStale` 单独判定，那是另一回事。
}

/** 仅供测试：清空全部会话。 */
export function _resetForTest(): void {
  _sessions.clear();
}
