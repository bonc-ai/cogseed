/**
 * 提交副本暂存区 —— 贡献流程的地基。
 *
 * ## 为什么必须有副本
 *
 * `C-FR-004b` 要求「补齐**不得静默修改本机原 Skill**」。贡献流程要做的事（补名称、
 * 补说明、填版本、补安全声明）全都是写文件，直接写在 `userSkillsDir(uid)/<id>` 上
 * 就把用户的原件改了——而用户只是想贡献，没同意改本机内容。
 *
 * ## 为什么不复用 `admitCustomSkill`
 *
 * `security/custom-skill-admission.ts` 的 `admitCustomSkill` 看起来正合适，但它
 * 第 ③ 步 `ensureSkillSkeleton(dir, skillId)` 写文件、第 ⑤ 步 `writeInstallReceipt`
 * 写 receipt，且直接操作原件目录。它的设计目的是「准入并**落地**」，与贡献要的
 * 「判定但**不落地**」方向相反。本模块只复用它的**判定部件**
 * （`validateSkillDir` + `scanSkillDir`），对副本跑。
 *
 * ## 目录名为什么这么挑
 *
 * 扫描器有**上下文降级**（`resources/guardrail/skill-sentry/engine/scanner_core/context.py`）：
 * 路径里出现 `test` / `tests` / `spec` / `specs` / `fixture` / `fixtures` / `testdata` /
 * `e2e`、`vendor` / `third_party`、`doc` / `docs` / `examples` / `samples` 等词，命中项
 * 会被降 1–2 档。`marketplace.ts` 的 `quarantineStagingName` 被专门导出，就是为了让测试
 * 钉住这个名字不撞降级词——注释原话是「a future absolute-path classifier would otherwise
 * silently demote the whole scan, **laundering a payload parked in the staging dir name**」。
 *
 * 本模块沿用同一纪律：目录名固定 `.contrib-<hex>`，`CONTRIB_STAGING_PREFIX` 导出供测试钉死。
 * 「contrib」不在任何一张降级词表里。
 *
 * ## 放在哪
 *
 * `userCloudRoot(uid)/skills` 之外，走 `marketplaceCacheSkillsDir(uid)`——那里已经是
 * 「未通过门禁的内容」的既有归宿（`.staging-*` 就在那儿），且不在 Skill 注册表的扫描
 * 范围内，副本不会被误当成一个真的已安装 Skill 加载。
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import { createLogger } from '../../logger';
import { marketplaceCacheSkillsDir, userSkillsDir } from '../../paths';
import { safeId } from '../../storage';

const log = createLogger('contribution/staging');

/**
 * 贡献暂存目录前缀。
 *
 * 导出供测试钉死：这个名字**不得**包含扫描器的上下文降级词
 * （`test*` / `spec*` / `fixture*` / `vendor` / `third_party` / `doc*` / `example*` / `sample*`），
 * 否则把内容停进来就等于给整次扫描打了折。
 */
export const CONTRIB_STAGING_PREFIX = '.contrib-';

/** 一次贡献动作的提交副本。 */
export interface ContributionStaging {
  /** 副本根目录的绝对路径。 */
  dir: string;
  /** 来源的本机自定义 Skill id。 */
  sourceSkillId: string;
  /** 本次暂存的随机后缀，用于日志与清理。 */
  token: string;
}
function stagingName(token: string): string {
  return `${CONTRIB_STAGING_PREFIX}${token}`;
}

/**
 * 从本机自定义 Skill 建立一份提交副本。
 *
 * 复制而非硬链接：后续补齐会写副本内的文件，硬链接会把写回传导到原件——那正是
 * `C-FR-004b` 禁止的。
 *
 * 不复制 sidecar 之外的隐藏文件：`_install.json` / `_cache.json` 等是本机安装态，
 * 不属于「将要发出的内容」，带上去既无意义又扩大了外发面。
 */
export async function createStaging(uid: string, sourceSkillId: string): Promise<ContributionStaging> {
  if (!safeId(sourceSkillId)) throw new Error('invalid_skill_id');
  const src = path.join(userSkillsDir(uid), sourceSkillId);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('artifact_missing');

  const root = marketplaceCacheSkillsDir(uid);
  await fsp.mkdir(root, { recursive: true });
  const token = randomBytes(6).toString('hex');
  const dir = path.join(root, stagingName(token));

  await fsp.cp(src, dir, { recursive: true, filter: _copyFilter });
  log.info('contribution staging created', { sourceSkillId, token });
  return { dir, sourceSkillId, token };
}

/**
 * 本机安装态文件不进副本。
 *
 * 与 `skills.ts` 的 `HIDDEN_SKILL_ENTRIES` 保持同一意图，但**只排除安装态**：
 * `_meta.json` 是内容的一部分（描述、分类、`forked_from`），必须保留，否则预览
 * 与实际发出的内容对不上。
 */
const _INSTALL_STATE_FILES = new Set(['_install.json', '_cache.json', '_resource_manifest.json']);

function _copyFilter(src: string): boolean {
  return !_INSTALL_STATE_FILES.has(path.basename(src));
}

/**
 * 销毁副本。
 *
 * 贡献流程的每个终点都必须调用——取消、阻断、提交成功、提交失败。副本里可能含
 * 贡献者补齐时填入的真实声明内容，留在盘上没有意义且扩大暴露面。
 *
 * 不抛错：清理失败不该把一个已经结束的流程变成错误。
 */
export async function destroyStaging(staging: ContributionStaging): Promise<void> {
  try {
    await fsp.rm(staging.dir, { recursive: true, force: true });
  } catch (err) {
    log.warn('failed to destroy contribution staging', { token: staging.token, error: (err as Error).message });
  }
}

/**
 * 清理孤儿暂存目录。
 *
 * 进程在贡献流程中途被杀时副本会留下。与 `.staging-*` 同样**无条件删除**：副本从未
 * 通过任何门禁，恢复它没有意义。
 *
 * 与 marketplace 的 `cleanupOrphanedStagingDirs` 分开而不是合并：那个函数扫的是
 * `userMarketplaceSkillsDir`（已安装区）并且带 `.trash-*` 的崩溃恢复逻辑；贡献副本
 * 在 cache 区且**不需要**恢复。合并会把「可恢复」和「不可恢复」两种语义混在一个循环里。
 */
export function cleanupOrphanedStaging(uid: string): void {
  const root = marketplaceCacheSkillsDir(uid);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(CONTRIB_STAGING_PREFIX)) continue;
    try {
      fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
      log.info('cleaned orphaned contribution staging', { dir: e.name });
    } catch (err) {
      log.warn('failed to clean contribution staging', { dir: e.name, error: (err as Error).message });
    }
  }
}
