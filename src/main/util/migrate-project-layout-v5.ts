/**
 * v5 migration: 空间化重构（删项目层）— 阶段 0 地基。
 *
 * v4 把会话/任务/附件/产物从顶层搬进 `cloud/projects/<pid>/`；
 * v5 把 `conversation.project_id` 迁移为 `conversation.space_id`，并把项目内
 * 字节搬到 `cloud/spaces/<sid>/`（T0.3 实现搬移执行，T0.4 注册 + 幂等）。
 *
 * 本文件当前（T0.1）只含**只读存量统计**（`collectProjectSpaceStats`）：
 * 列出所有 project → 其 space_id → 其会话数。不写盘、不建 marker、不加锁。
 * 这是 T0.3 搬移前「迁移前备份统计」的数据源，也是 T0.4 幂等版本标记的地基。
 *
 * 顺序纪律：必须先落地 `Conversation.space_id` 字段（T0.2）+ 本统计（T0.1），
 * 才能做搬移（T0.3），否则中间态执行路径会断。
 */

import {
  projectMetaFile,
  projectChatIndexFile,
} from '../paths';
import { readJsonSync, safeId } from '../storage';
import { createLogger } from '../logger';
import { listProjectIds } from './project-layout';

const log = createLogger('migrate-project-layout-v5');

export const MIGRATION_VERSION = 5;

/** 存量统计结果（T0.1 只读）。字段命名对齐 v4 的统计惯例，便于 smoke/日志。 */
export interface ProjectSpaceMigrationStats {
  projects_total: number;
  /** 项目里 project.json 带有效 space_id 的数量 */
  projects_with_space: number;
  /** 项目里缺失/空 space_id 的数量（迁移后其会话→orphan） */
  projects_orphan: number;
  conversations_total: number;
  conversations_with_space: number;
  conversations_orphan: number;
  /** 逐项目明细：project_id / space_id(null=orphan) / name / 会话数 */
  by_project: Array<{
    project_id: string;
    space_id: string | null;
    name: string;
    conversations: number;
  }>;
  warnings: string[];
}

function emptyStats(): ProjectSpaceMigrationStats {
  return {
    projects_total: 0,
    projects_with_space: 0,
    projects_orphan: 0,
    conversations_total: 0,
    conversations_with_space: 0,
    conversations_orphan: 0,
    by_project: [],
    warnings: [],
  };
}

function readJsonArray(file: string): any[] {
  const raw: any = readJsonSync(file);
  return Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : []);
}

/**
 * T0.1 只读存量统计：遍历所有 project 目录，读其 `project.json` 的 `space_id`
 * 与 `chats/_index.json` 的会话数（排除 deleted_at 墓碑）。不写盘。
 *
 * 读不到 meta 的项目仍计入 projects_total，space_id 记 null，并追加 warning。
 */
export function collectProjectSpaceStats(uid: string): ProjectSpaceMigrationStats {
  const stats = emptyStats();
  if (!safeId(uid)) {
    stats.warnings.push(`invalid uid: ${String(uid)}`);
    return stats;
  }

  for (const pid of listProjectIds(uid)) {
    stats.projects_total += 1;

    const meta: any = readJsonSync(projectMetaFile(uid, pid));
    const rawSpaceId = typeof meta?.space_id === 'string' ? meta.space_id : '';
    const spaceId = safeId(rawSpaceId) ? rawSpaceId : null;

    let convCount = 0;
    for (const row of readJsonArray(projectChatIndexFile(uid, pid))) {
      const cid = typeof row?.conversation_id === 'string' ? row.conversation_id : '';
      if (!safeId(cid)) continue;
      if (typeof row?.deleted_at === 'string' && row.deleted_at) continue; // 墓碑不计
      convCount += 1;
    }

    if (spaceId) {
      stats.projects_with_space += 1;
      stats.conversations_with_space += convCount;
    } else {
      stats.projects_orphan += 1;
      stats.conversations_orphan += convCount;
    }
    stats.conversations_total += convCount;

    stats.by_project.push({
      project_id: pid,
      space_id: spaceId,
      name: typeof meta?.name === 'string' ? meta.name : '',
      conversations: convCount,
    });
  }

  return stats;
}

/**
 * T0.1 skeleton 入口：只做存量统计并打日志，不写盘、不建 marker、不加锁。
 * T0.3 补搬移执行（project_id→space_id + `cloud/projects/`→`cloud/spaces/`）；
 * T0.4 在 activateUser 注册并加锁 + 版本标记，实现幂等。
 */
export function migrateProjectLayoutV5(uid: string): ProjectSpaceMigrationStats {
  const stats = collectProjectSpaceStats(uid);
  if (stats.by_project.length || stats.warnings.length) {
    log.info('project layout v5 (space) stats', {
      uid,
      projects_total: stats.projects_total,
      projects_with_space: stats.projects_with_space,
      projects_orphan: stats.projects_orphan,
      conversations_total: stats.conversations_total,
      conversations_with_space: stats.conversations_with_space,
      conversations_orphan: stats.conversations_orphan,
      warnings: stats.warnings.length,
    });
  }
  return stats;
}
