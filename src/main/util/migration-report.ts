/**
 * 启动期迁移的**统一结果上报**。
 *
 * 背景：`features/users.ts` 里 7 个迁移各自 `try/catch`，失败只打一行 warn，
 * 于是"这次启动到底跑了哪些迁移、哪些跳过、哪些留下了失败项"没有任何单一事实来源。
 * 排查只能靠翻日志里的零散 warn，也无法回答"v5 迁移是不是还有项目没搬成功"。
 *
 * 本模块给出一个咽喉点：驱动侧只调 `runBootMigration(uid, id, fn)`，
 * 由它统一分类（成功 / 跳过 / 部分失败 / 抛错），最后一次落成
 * `<uid>/local/migrations-report.json` 并打**一条**摘要日志。
 *
 * 分类依据是迁移自身的返回值（不强求改造）：
 *   - 抛错                        → failed（记 error 文本）
 *   - 返回 `{ warnings: [...] }`  → partial（failedItems = warnings，v5 的形状）
 *   - 返回 `{ skipped: true }` / `{ migrated: false }` / `{ applied: false }` → skipped
 *   - 其余返回值 / void           → applied（本次调用跑通；"是否真的改了东西"由各自 marker 回答）
 *
 * 报告写在 `local/`（机器私有）而不是 `cloud/`：它是本机启动过程的观测数据，
 * 不该参与多设备同步。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userLocalRoot } from '../paths';
import { createLogger } from '../logger';

const log = createLogger('migration-report');

export type MigrationStatus = 'applied' | 'skipped' | 'partial' | 'failed';

export interface MigrationOutcome {
  /** 稳定标识，例如 `project-layout-v5`。 */
  id: string;
  status: MigrationStatus;
  /** `partial` 时列出未完成的条目（项目 id / 路径等），便于下次启动只重试这些。 */
  failedItems?: string[];
  /** 自由格式补充（计数、原因），仅用于排查。 */
  detail?: string;
  /** `failed` 时的错误文本。 */
  error?: string;
}

export interface MigrationReport {
  version: 1;
  uid: string;
  ranAt: string;
  outcomes: MigrationOutcome[];
}

interface InFlightRun {
  uid: string;
  outcomes: MigrationOutcome[];
}

/** 同一次启动内的进行中集合；uid 变化（切换用户）时重置。 */
let inflight: InFlightRun | null = null;

function reportFile(uid: string): string {
  return path.join(userLocalRoot(uid), 'migrations-report.json');
}

/** 从迁移返回值里判定状态。见文件头部的分类表。 */
export function classifyMigrationResult(result: unknown): Pick<MigrationOutcome, 'status' | 'failedItems' | 'detail'> {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const warnings = Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === 'string' && !!w) : [];
    if (warnings.length) return { status: 'partial', failedItems: warnings };
    if (r.skipped === true || r.migrated === false || r.applied === false) return { status: 'skipped' };
    const detailKeys = ['moved', 'failed', 'failedProjects', 'count', 'total'].filter((k) => typeof r[k] === 'number');
    if (detailKeys.length) {
      return { status: 'applied', detail: detailKeys.map((k) => `${k}=${String(r[k])}`).join(' ') };
    }
  }
  return { status: 'applied' };
}

/**
 * 跑一个启动期迁移并记录结果。**绝不抛出**：迁移失败不得阻断用户激活，
 * 这与驱动侧原先的 `try/catch` 语义一致，只是把结果留了下来。
 */
export function runBootMigration<T>(uid: string, id: string, fn: () => T): MigrationOutcome {
  if (!inflight || inflight.uid !== uid) inflight = { uid, outcomes: [] };
  let outcome: MigrationOutcome;
  try {
    outcome = { id, ...classifyMigrationResult(fn()) };
  } catch (err) {
    outcome = { id, status: 'failed', error: (err as Error).message };
    log.warn('boot migration failed', { uid: maskUid(uid), migration: id, error: (err as Error).message });
  }
  inflight.outcomes.push(outcome);
  return outcome;
}

/** 单行摘要，既是日志内容也是测试断言对象。 */
export function summarizeMigrationReport(outcomes: readonly MigrationOutcome[]): string {
  const by = (s: MigrationStatus) => outcomes.filter((o) => o.status === s).map((o) => o.id);
  const parts = [`${outcomes.length} migrations`];
  for (const status of ['applied', 'skipped', 'partial', 'failed'] as const) {
    const ids = by(status);
    if (ids.length) parts.push(`${status}=${ids.length} [${ids.join(', ')}]`);
  }
  return parts.join(' | ');
}

/**
 * 收尾：落盘 + 打**一条**摘要。干净时 info；有 partial/failed 时 warn
 * （可恢复失败 = warn，符合日志分级约定）。
 */
export function finishBootMigrationRun(uid: string): MigrationReport {
  const outcomes = inflight && inflight.uid === uid ? inflight.outcomes : [];
  const report: MigrationReport = { version: 1, uid, ranAt: new Date().toISOString(), outcomes };
  inflight = null;

  const summary = summarizeMigrationReport(outcomes);
  const trouble = outcomes.filter((o) => o.status === 'partial' || o.status === 'failed');
  if (trouble.length) {
    log.warn('boot migrations finished with issues', {
      uid: maskUid(uid),
      summary,
      issues: trouble.map((o) => ({ id: o.id, status: o.status, items: o.failedItems?.length ?? 0, error: o.error })),
    });
  } else {
    log.info('boot migrations finished', { uid: maskUid(uid), summary });
  }

  try {
    const file = reportFile(uid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch (err) {
    // 报告是观测数据：写不进去不影响启动。
    log.warn('migration report write failed', { uid: maskUid(uid), error: (err as Error).message });
  }
  return report;
}

/** 诊断用读取（缺失/损坏返回 null，不抛）。 */
export function readMigrationReport(uid: string): MigrationReport | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(reportFile(uid), 'utf8')) as MigrationReport;
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.outcomes) ? parsed : null;
  } catch {
    return null;
  }
}

function maskUid(uid: string): string {
  const s = String(uid || '');
  if (s.length <= 4) return '***';
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}
