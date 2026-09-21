/**
 * 全仓**唯一**的非终态 Task pin 扫描。
 *
 * 契约：specs/010 `contracts/pin-dispatch.md`｜需求：FR-050 / FR-051 / FR-053
 *
 * ⚠️ **唯一性是结构性约束**：`hasActivePins`（Phase 6）与保守回收（Phase 11）
 * **共用本模块的同一份扫描**，不各建一份，也不引入与 pin 平行的 active-use state。
 *
 * ⚠️ **为什么是扫描而不是引用计数**：引用是**扫出来的，不是维护的**——Task 转终态后
 * 自然不再计入，无需显式释放；内存计数在崩溃后会丢，磁盘上的 Task 记录不会。
 */

import { createLogger } from '../../logger';
import { listCogSeedTasks } from '../cogseed_backend/task-store';
import type { CogSeedTaskRecord, CogSeedTaskStatus } from '../cogseed_backend/types';

const log = createLogger('marketplace/pin-scan');

/**
 * 终态**只有三种**。转入其一之后该 Task 的 pin 不再计入在用集合。
 *
 * ⚠️ `recoverable` **不是终态**——它可被恢复继续执行，其 pin 必须保留。
 * （既有 ADR 草案记为「八种状态」，**已勘误**：基线 `cogseed_backend/types.ts:24-33`
 * 实为 9 种。写错即直接踩中 must-not-happen 第 6 条。）
 */
export const TERMINAL_TASK_STATUSES: readonly CogSeedTaskStatus[] = [
  'completed', 'failed', 'cancelled',
];

/** 非终态六种。其 pin 全部计入在用集合。 */
export const NON_TERMINAL_TASK_STATUSES: readonly CogSeedTaskStatus[] = [
  'planned', 'created', 'queued', 'running', 'waiting_user', 'recoverable',
];

const TERMINAL = new Set<string>(TERMINAL_TASK_STATUSES);

/**
 * 是否终态。
 *
 * ⚠️ **未知状态一律按非终态处理**（返回 `false`）。新增状态时保守侧是「留着」，
 * 不是「删掉」——判错方向会删掉仍在用的版本副本。
 */
export function isTerminalTaskStatus(status: string | undefined | null): boolean {
  return typeof status === 'string' && TERMINAL.has(status);
}

/**
 * 在用集合的键。
 *
 * 用 JSON 数组而不是字符拼接：`content_id` 与 `version` 都来自外部，任何单字符
 * 分隔符都可能在其中出现并造成歧义（`a|b` + `c` 与 `a` + `b|c` 会撞键）。
 */
export function pinKey(contentId: string, version: string): string {
  return JSON.stringify([contentId, version]);
}

export interface PinScanResult {
  /**
   * 本轮扫描是否可信。
   *
   * ⚠️ `false` 时调用方 **MUST NOT** 据此删除任何东西——空集与「扫不出来」
   * 在磁盘上长得一样，但含义相反。任何异常都会把它置为 `false`（FR-053）。
   */
  trustworthy: boolean;
  /** 在用的 `(content_id, version)` 集合，键由 `pinKey()` 生成。 */
  inUse: Set<string>;
  /** 实际读到的 Task 数量。 */
  scannedTasks: number;
  /** 计入在用集合的非终态 Task 数量。 */
  activeTasks: number;
  /** 不可信时的原因，供日志与诊断。 */
  reason?: string;
}

function emptyResult(overrides: Partial<PinScanResult> = {}): PinScanResult {
  return { trustworthy: true, inUse: new Set(), scannedTasks: 0, activeTasks: 0, ...overrides };
}

/**
 * 扫描全部**非终态** Task 的 pin，返回在用集合。
 *
 * 不抛错：失败一律以 `trustworthy: false` 表达，让调用方在「拿不准」时保守处理。
 *
 * 📌 pin 形状不含来源字段（`contracts/pin-dispatch.md` 的不变量），因此创作流 Skill 的
 * pin 也会进入集合。这只会让回收**更保守**（多留，不会多删），故不做来源过滤——
 * 过滤所需的来源判定一旦出现在这里，就是「来源判定扩散」。
 */
export async function scanActivePins(userId: string): Promise<PinScanResult> {
  let tasks: CogSeedTaskRecord[];
  try {
    tasks = await listCogSeedTasks(userId);
  } catch (err) {
    // 典型场景：扫描中途某个 Task 文件被删除，`listCogSeedTasks` 直接抛错。
    // 此时**绝不能**返回空集——那会被回收读成「没有任何版本在用」。
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('pin scan failed; result is not trustworthy', { reason });
    return emptyResult({ trustworthy: false, reason });
  }

  const result = emptyResult({ scannedTasks: tasks.length });
  for (const task of tasks) {
    try {
      if (isTerminalTaskStatus(task.status)) continue;
      result.activeTasks += 1;
      const pins = Array.isArray(task.skillVersionPins) ? task.skillVersionPins : [];
      for (const pin of pins) {
        if (!pin || typeof pin.skillId !== 'string' || typeof pin.version !== 'string') continue;
        if (!pin.skillId || !pin.version) continue;
        result.inUse.add(pinKey(pin.skillId, pin.version));
      }
    } catch (err) {
      // 单条记录异常同样让整轮不可信：局部跳过会让集合少内容，方向恰好是危险的那侧。
      const reason = err instanceof Error ? err.message : String(err);
      log.warn('pin scan hit a malformed task; result is not trustworthy', { reason });
      return emptyResult({ trustworthy: false, reason, scannedTasks: tasks.length });
    }
  }

  log.info('pin scan complete', {
    scanned_tasks: result.scannedTasks, active_tasks: result.activeTasks, in_use: result.inUse.size,
  });
  return result;
}

/**
 * 某个 `{content_id, version}` 是否被非终态 Task 钉住。
 *
 * ⚠️ 扫描不可信时返回 `true`——「拿不准就当它在用」。这是保守侧。
 */
export async function hasActivePin(userId: string, contentId: string, version: string): Promise<boolean> {
  const scan = await scanActivePins(userId);
  if (!scan.trustworthy) return true;
  return scan.inUse.has(pinKey(contentId, version));
}

/**
 * 某个 `content_id` 是否有**任意版本**被非终态 Task 钉住。
 *
 * 供停用判定（Phase 6 的 `hasActivePins`）使用。同样地，不可信即返回 `true`。
 */
export async function hasActivePinsForContent(userId: string, contentId: string): Promise<boolean> {
  const scan = await scanActivePins(userId);
  if (!scan.trustworthy) return true;
  for (const key of scan.inUse) {
    try {
      const [id] = JSON.parse(key) as [string, string];
      if (id === contentId) return true;
    } catch {
      // 键由 pinKey() 生成，解析失败说明集合被污染；保守侧是当作在用。
      return true;
    }
  }
  return false;
}
