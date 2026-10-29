/**
 * 用新版本替换一个已安装的市场 Agent —— 失败时旧版原样保留（产品 2026-10-13：更新失败保留旧版继续可用）。
 *
 * 做法：开始前把现有目录整体改名成同级的点号前缀备份 `.prev-<id>-<hex>`（点号前缀对 Agent 列表不可见，
 * 见 `agents.ts::_childDirectoryIds`），新版本写在原路径上；全部成功才 {@link AgentReplace.commit} 删备份，
 * 任何一步失败 {@link AgentReplace.rollback} 删掉写了一半的新目录并把备份改名换回。
 *
 * 以前的写法是先 `rm` 再写，更新途中失败（比如私有 Skill 的深扫被拒）就把旧版一起删了——对"安装新 Agent"
 * 无所谓，对"更新已装 Agent"等于把用户能用的东西弄丢。
 *
 * 进程在改名与提交之间被杀时备份会残留，{@link recoverInterruptedAgentReplaces} 在启动时善后：
 * 能证明新目录不是完整安装（没有 `_install.json` 成功标记）就换回备份，否则只是残留，删掉。
 *
 * 叶模块：只用 `node:fs`，路径由调用方传入。
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export const AGENT_BACKUP_PREFIX = '.prev-';
/** 写完才有的成功标记（见 `marketplace.ts` 写入 `_install.json` 的位置）。 */
const INSTALL_MARKER = '_install.json';

export interface AgentReplace {
  /** 新版本全部写好、检查通过后调用：删除备份。 */
  commit(): Promise<void>;
  /** 任何一步失败时调用：删掉写了一半的新目录，把旧版换回来。 */
  rollback(): Promise<void>;
  /** 有旧版被备份时为 true（即这是一次更新而不是全新安装）。 */
  readonly hadPrevious: boolean;
}

const backupName = (agentId: string): string => `${AGENT_BACKUP_PREFIX}${agentId}-${randomBytes(4).toString('hex')}`;

/**
 * 开始替换：`target` 是 Agent 的最终目录。若它已存在，改名成备份；返回的句柄负责提交或回滚。
 * `target` 不存在（全新安装）时句柄只负责在失败时清掉残留。
 */
export async function beginAgentReplace(target: string, agentId: string): Promise<AgentReplace> {
  let backup: string | null = null;
  if (fs.existsSync(target)) {
    backup = path.join(path.dirname(target), backupName(agentId));
    await fsp.rename(target, backup);
  }
  let settled = false;
  return {
    hadPrevious: backup !== null,
    async commit() {
      if (settled) return;
      settled = true;
      if (backup) await fsp.rm(backup, { recursive: true, force: true }).catch(() => undefined);
    },
    async rollback() {
      if (settled) return;
      settled = true;
      await fsp.rm(target, { recursive: true, force: true });
      if (backup) await fsp.rename(backup, target);
    },
  };
}

/** `.prev-<id>-<hex>` → `<id>`；不是这个形态返回 null。 */
export function agentIdFromBackupName(name: string): string | null {
  if (!name.startsWith(AGENT_BACKUP_PREFIX)) return null;
  const m = /^(.+)-[0-9a-f]{8}$/.exec(name.slice(AGENT_BACKUP_PREFIX.length));
  return m ? m[1] : null;
}

/**
 * 启动时善后被中断的替换：
 * - 对应的 Agent 目录缺失、或没有成功标记（写了一半）→ 删掉半成品，把备份换回；
 * - 对应的 Agent 目录是完整安装 → 备份只是残留，删掉；
 * - 名字认不出是谁的备份 → 删掉（不猜）。
 * 返回被换回的 Agent id。
 */
export function recoverInterruptedAgentReplaces(agentsDir: string): string[] {
  const restored: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch { return restored; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(AGENT_BACKUP_PREFIX)) continue;
    const backup = path.join(agentsDir, entry.name);
    const agentId = agentIdFromBackupName(entry.name);
    try {
      if (!agentId) { fs.rmSync(backup, { recursive: true, force: true }); continue; }
      const target = path.join(agentsDir, agentId);
      const complete = fs.existsSync(path.join(target, INSTALL_MARKER));
      if (complete) { fs.rmSync(backup, { recursive: true, force: true }); continue; }
      // 备份本身也得是一份能用的安装，否则换回去没意义
      if (!fs.existsSync(path.join(backup, 'agent.json'))) { fs.rmSync(backup, { recursive: true, force: true }); continue; }
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(backup, target);
      restored.push(agentId);
    } catch {
      // 善后失败不该让启动失败；下次启动再试
    }
  }
  return restored;
}
