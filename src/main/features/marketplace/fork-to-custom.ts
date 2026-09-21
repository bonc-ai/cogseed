/**
 * 「转为我的版本」—— 把一份 Hub 官方副本派生为用户自定义 Skill。
 *
 * 契约：specs/010 `data-model.md` §7｜需求：FR-054～FR-060（`[FROZEN]` 为主）
 *
 * 本模块只做**编排**：卸载、墓碑、内容复制、自定义 Skill 落地全部复用既有能力
 * （`marketplace.ts::uninstallMarketplaceSkill`、`marketplace_installs.ts` 的墓碑、
 * `skills.ts::adoptCustomSkillFromStagedTree`）。**不新增第二套 Skill 身份或命名空间。**
 *
 * ## 顺序是硬要求（FR-055）
 *
 * ```
 * ① 提示后果 → 用户确认        ← 未确认不动任何磁盘状态
 * ② 记派生意图（intent journal） ← 只记意图，不记内容
 * ③ 卸载官方副本（记 tombstone） ← current install 被删，版本副本保留
 * ④ 从【版本副本】复制内容树     ← FR-056：③已删 current install，无处可读
 * ⑤ 原子提升为自定义 Skill      ← 同名禁止在此把关：官方副本还在就拒绝
 * ⑥ 清除派生意图
 * ```
 *
 * ## 为什么不会出现「两份」或「零份」
 *
 * - **两份**：⑤ 之前自定义副本根本不存在（内容停在 `cloud/skills/.fork-*`，点号前缀对
 *   列表不可见），而 ⑤ 会在官方安装目录仍存在时直接拒绝。因此官方副本与派生副本
 *   **不可能同时存在**。
 * - **零份**：③ 与 ⑤ 之间崩溃会短暂两头都没有。意图记录在 ② 就已落盘，且版本副本按
 *   FR-048 不随卸载删除（卸载后 current 判不出，回收的三条件第二条即不满足），
 *   所以下次启动的恢复扫描能**接着把 ④⑤ 做完**。版本副本也不在了才放弃，此时
 *   如实记日志并清除意图——用户仍可重新安装官方版（显式安装会清墓碑）。
 *
 * ## 派生之后与 Hub 的隔离（FR-059）
 *
 * 隔离是**结构性**的，不靠调用方记得跳过：派生副本的 id 是新生成的自定义 id，
 * 与 `content_id` 不同名，因此 `isHubManagedContent()` 对它恒为 false —— 更新、停用、
 * pin 来源分派与 `hub_content_used` 全都判定不到它。这也是派生 id **必须**不同于
 * `content_id` 的原因：若沿用 `content_id`，版本副本仍在的事实会让它继续被判为 Hub 内容。
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { t } from '../../i18n';
import { createLogger } from '../../logger';
import {
  userMarketplaceDir,
  userMarketplaceForkIntentFile,
  userMarketplaceSkillDir,
  userSkillsDir,
} from '../../paths';
import { installedVersionOf } from './installed-version';
import { resolveVersionCopy, verifyVersionCopy } from './version-store';

const log = createLogger('marketplace/fork-to-custom');

/**
 * FR-054 的后果提示文案键。**由调用方（UI）展示并取得确认**，本模块只校验确认已给出——
 * 主进程不弹窗，也不替用户确认。
 */
export const FORK_CONSEQUENCE_I18N_KEY = 'skills.fork.consequence';

export interface ForkedFrom {
  content_id: string;
  version: string;
}

export interface ForkToCustomResult {
  ok: true;
  /** 新生成的自定义 id。**恒不等于 `content_id`**（见文件头 FR-059 一节）。 */
  customId: string;
  /** 沿用的原名称；`renamed` 为 true 时是去重后的名称。 */
  name: string;
  forkedFrom: ForkedFrom;
  /** 原名称已被别的自定义 Skill 占用，按现有同名规则去重过。 */
  renamed: boolean;
}

/**
 * 同名冲突 —— 需要**先改名**才能继续（FR-060）。
 *
 * 带上冲突方与建议名称，让上层能按客户端现有同名规则提示改名，而不是只给一句失败。
 */
export class SkillNameConflictError extends Error {
  conflictingSkillIds: string[];

  suggestedName: string;

  constructor(message: string, conflictingSkillIds: string[], suggestedName: string) {
    super(message);
    this.name = 'SkillNameConflictError';
    this.conflictingSkillIds = conflictingSkillIds;
    this.suggestedName = suggestedName;
  }
}

/** 派生意图记录。**只记意图，不记内容。** */
interface ForkIntent {
  content_id: string;
  version: string;
  name: string;
  created_at: number;
}

/**
 * 暂存目录名。点号前缀 —— `cloud/skills/` 的枚举一律跳过以点开头的目录，
 * 因此提升之前的内容对技能列表与运行时**完全不可见**。
 */
function forkStagingName(hex: string): string {
  return `.fork-${hex}`;
}

/** 原名称取自内容包自身的 SKILL.md（包是内容 SoT），不取目录页 metadata。 */
function readSkillNameFromTree(treeDir: string): string {
  const raw = fs.readFileSync(path.join(treeDir, 'SKILL.md'), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const frontmatter = match ? match[1] : '';
  const nameLine = /^name:\s*(.+)$/m.exec(frontmatter);
  const value = (nameLine ? nameLine[1] : '').trim();
  return value.replace(/^["']|["']$/g, '').trim();
}

function readForkIntent(uid: string, contentId: string): ForkIntent | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(userMarketplaceForkIntentFile(uid, contentId), 'utf8')) as ForkIntent;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.content_id !== 'string' || typeof parsed.version !== 'string') return null;
    if (!parsed.content_id || !parsed.version) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeForkIntent(uid: string, intent: ForkIntent): void {
  const file = userMarketplaceForkIntentFile(uid, intent.content_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(intent, null, 2), 'utf8');
}

function clearForkIntent(uid: string, contentId: string): void {
  try { fs.rmSync(userMarketplaceForkIntentFile(uid, contentId), { force: true }); }
  catch (err) { log.warn('failed to clear fork intent', { contentId, error: String(err) }); }
}

/**
 * ⑤ 的前半：同名禁止把关。**导出以便测试直接验证「顺序不可颠倒」。**
 *
 * ⚠️ **顺序不可颠倒的落点就在这里**：官方安装目录仍存在即抛出客户端既有的同名禁止错误。
 * 先复制后卸载会在这一步被拒绝，因此不存在「官方副本与派生副本同时存在」的中间态。
 *
 * 官方安装目录名是 `content_id`，而派生副本的 id 是新生成的自定义 id —— 两者不在同一
 * 命名空间，`skills.ts` 的既有 id 级把关**看不到**这组冲突，故在此按同一条规则、
 * 用同一条错误文案补上 `content_id` 侧的判定。
 */
export function assertOfficialCopyAbsent(uid: string, contentId: string, desiredId: string): void {
  if (fs.existsSync(userMarketplaceSkillDir(uid, contentId))) {
    throw new Error(t('skills.errors.builtin_conflict', { name: desiredId }));
  }
}

/** ⑤ 提升：把关通过后原子落地为自定义 Skill，并写入 `forked_from`。 */
async function promoteForkStaging(
  uid: string,
  contentId: string,
  stagingDir: string,
  desiredId: string,
  forkedFrom: ForkedFrom,
): Promise<void> {
  assertOfficialCopyAbsent(uid, contentId, desiredId);
  const skills = await import('../skills');
  const adopted = await skills.adoptCustomSkillFromStagedTree({ stagingDir, desiredId, forkedFrom });
  if (!adopted) throw new Error(t('skills.errors.create_failed'));
}

/** ④ 复制：源**必须**是版本副本。返回暂存目录。 */
async function stageForkTree(uid: string, treeDir: string, desiredId: string): Promise<string> {
  const root = userSkillsDir(uid);
  await fsp.mkdir(root, { recursive: true });
  const staging = path.join(root, forkStagingName(randomBytes(6).toString('hex')));
  await fsp.cp(treeDir, staging, { recursive: true });
  // 名称与 id 必须一致：客户端的自定义 Skill 以「id 即 frontmatter name」为不变量
  // （`_renameSkillByFrontmatterIfNeeded` 会按 frontmatter 自动纠正目录名）。去重改名时
  // 同步改写 frontmatter，否则落地后会被自动改名逻辑反复拉扯。
  const staged = readSkillNameFromTree(staging);
  if (staged !== desiredId) rewriteStagedSkillName(staging, desiredId);
  return staging;
}

/** 只改 frontmatter 的 `name:` 一行，内容树其余部分逐字保留（包是内容 SoT）。 */
function rewriteStagedSkillName(stagingDir: string, name: string): void {
  const file = path.join(stagingDir, 'SKILL.md');
  const raw = fs.readFileSync(file, 'utf8');
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(raw);
  if (!match) return;
  const patched = match[2].replace(/^name:\s*.*$/m, `name: "${name.replace(/"/g, '\\"')}"`);
  fs.writeFileSync(file, raw.replace(match[0], `${match[1]}${patched}${match[3]}`), 'utf8');
}

/**
 * 把一份 Hub 官方副本派生为自定义 Skill。
 *
 * @param opts.confirmed 用户已看过 {@link FORK_CONSEQUENCE_I18N_KEY} 的后果提示并确认（FR-054）。
 */
export async function forkOfficialSkillToCustom(
  uid: string,
  contentId: string,
  opts: { confirmed?: boolean } = {},
): Promise<ForkToCustomResult> {
  if (!uid) throw new Error('uid required');
  if (!contentId) throw new Error('contentId required');
  // ① 未确认：不动任何磁盘状态。
  if (opts.confirmed !== true) throw new Error(t('skills.errors.fork_not_confirmed'));

  // 版本取**本机实际已安装版本**（FR-056 的复制源身份）——走 `installed-version.ts` 单一入口，
  // 读的是已成功原子落盘的本地事实。**绝不取目录页/清单里的目标版本**：那可能领先于本机内容，
  // 会把用户没有的版本写进 `forked_from`，也会指向一份本机不存在的副本。
  const version = installedVersionOf(uid, contentId);
  if (!version) throw new Error(t('skills.errors.fork_source_unavailable'));
  if (!verifyVersionCopy(uid, contentId, version)) throw new Error(t('skills.errors.fork_source_unavailable'));
  const treeDir = resolveVersionCopy(uid, contentId, version);
  if (!treeDir) throw new Error(t('skills.errors.fork_source_unavailable'));

  let originalName = '';
  try { originalName = readSkillNameFromTree(treeDir); }
  catch { throw new Error(t('skills.errors.fork_source_unavailable')); }
  if (!originalName) throw new Error(t('skills.errors.fork_source_unavailable'));

  const skills = await import('../skills');
  const nameError = skills.validateSkillName(originalName);
  if (nameError) throw new Error(nameError);
  // 沿用原名称（FR-057）。被别的自定义 Skill 占用时按**现有同名规则**去重，
  // 并在结果里如实报告改过名。
  const customId = skills.reserveFreeCustomSkillId(originalName);
  const forkedFrom: ForkedFrom = { content_id: contentId, version };

  // ② 意图先落盘，③④⑤ 之间崩溃才有恢复依据。
  writeForkIntent(uid, { ...forkedFrom, name: customId, created_at: Date.now() });

  let staging = '';
  try {
    // ③ 卸载官方副本（内部记 tombstone；版本副本按 FR-048 保留）。
    const marketplace = await import('../marketplace');
    await marketplace.uninstallMarketplaceSkill(contentId);

    // ④ 复制源是版本副本 —— ③ 之后 current install 已不存在。
    staging = await stageForkTree(uid, treeDir, customId);
    // ⑤ 原子提升 + 写 forked_from。
    await promoteForkStaging(uid, contentId, staging, customId, forkedFrom);
    staging = '';
  } catch (err) {
    // 暂存残留一律删：它不是「上一个可用版本」，重做一遍即可从版本副本再复制。
    if (staging) await fsp.rm(staging, { recursive: true, force: true }).catch(() => { /* residue */ });
    log.warn('fork to custom failed; intent journal kept for boot recovery', {
      contentId, version, error: (err as Error).message,
    });
    throw err;
  }

  // ⑥ 派生已完成，意图不再需要。
  clearForkIntent(uid, contentId);
  log.info('forked official copy to custom skill', { contentId, version, customId });
  return { ok: true, customId, name: customId, forkedFrom, renamed: customId !== originalName };
}

/**
 * 重新安装官方版前的同名检查（FR-060）。
 *
 * 只在**显式重装**时判定：自动撒种与周期更新不受影响。命中时抛
 * {@link SkillNameConflictError}，让上层按客户端现有同名规则**先提示为派生副本改名**。
 *
 * ⚠️ 判据是**显示名称**，不是 `forked_from`——`forked_from` 在迭代一**只写不读**（FR-057）。
 */
export async function assertOfficialReinstallNameIsFree(officialName: string): Promise<void> {
  const name = (officialName || '').trim();
  if (!name) return;
  const skills = await import('../skills');
  const conflicts = skills.findCustomSkillIdsByDisplayName(name);
  if (conflicts.length === 0) return;
  throw new SkillNameConflictError(
    t('skills.errors.fork_rename_required', { name }),
    conflicts,
    skills.reserveFreeCustomSkillId(name),
  );
}

/** 按客户端现有改名能力为派生副本改名（FR-060 的执行侧）。 */
export async function renameForkedCustomSkill(skillId: string, newName: string): Promise<string> {
  const skills = await import('../skills');
  const error = skills.validateSkillName(newName);
  if (error) throw new Error(error);
  skills.assertCustomSkillIdAvailable(newName);
  const updated = await skills.updateCustomSkill(skillId, { name: newName });
  if (!updated) throw new Error(t('skills.errors.skill_not_found', { id: skillId }));
  return updated.id;
}

export interface ForkRecoveryReport {
  completed: string[];
  discarded: string[];
}

/**
 * 启动期恢复被打断的派生。
 *
 * 四种处置，都是「能证明什么就做什么」：
 *   - 派生副本已存在 → 派生其实已完成，只是意图没来得及清 → 清意图；
 *   - 官方副本仍在 → 崩在卸载之前，什么都没丢 → 清意图，用户可重试；
 *   - 版本副本仍可校验 → **接着把复制与提升做完**（用户已确认过的意图）；
 *   - 版本副本也没了 → 无从完成 → 清意图并如实记日志（用户仍可重新安装官方版）。
 *
 * 形态参照 `marketplace.ts::cleanupOrphanedStagingDirs`：只碰点号前缀的残留，
 * 任何一条失败都不影响其余，也不抛给启动流程。
 */
export async function recoverInterruptedForks(uid: string): Promise<ForkRecoveryReport> {
  const report: ForkRecoveryReport = { completed: [], discarded: [] };
  if (!uid) return report;

  // 暂存残留先清：意图记录才是完成派生的依据，残留的半份复制没有价值。
  const skillsRoot = userSkillsDir(uid);
  try {
    for (const e of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('.fork-')) continue;
      try { fs.rmSync(path.join(skillsRoot, e.name), { recursive: true, force: true }); }
      catch (err) { log.warn('failed to clean fork staging residue', { dir: e.name, error: String(err) }); }
    }
  } catch { /* 目录还不存在 */ }

  let intents: string[];
  try {
    intents = fs.readdirSync(userMarketplaceDir(uid))
      .filter((n) => n.startsWith('.fork-intent-') && n.endsWith('.json'));
  } catch {
    return report;
  }

  const skills = await import('../skills');
  for (const file of intents) {
    const contentId = file.slice('.fork-intent-'.length, -'.json'.length);
    const intent = readForkIntent(uid, contentId);
    if (!intent || intent.content_id !== contentId) {
      clearForkIntent(uid, contentId);
      report.discarded.push(contentId);
      continue;
    }
    try {
      if (await skills.getCustomSkill(intent.name)) {
        clearForkIntent(uid, contentId);
        continue;
      }
      if (fs.existsSync(userMarketplaceSkillDir(uid, contentId))) {
        clearForkIntent(uid, contentId);
        report.discarded.push(contentId);
        continue;
      }
      const treeDir = verifyVersionCopy(uid, contentId, intent.version)
        ? resolveVersionCopy(uid, contentId, intent.version)
        : null;
      if (!treeDir) {
        log.warn('cannot finish interrupted fork: no verifiable version copy left', {
          contentId, version: intent.version,
        });
        clearForkIntent(uid, contentId);
        report.discarded.push(contentId);
        continue;
      }
      const customId = skills.reserveFreeCustomSkillId(intent.name);
      const staging = await stageForkTree(uid, treeDir, customId);
      try {
        await promoteForkStaging(uid, contentId, staging, customId, {
          content_id: contentId, version: intent.version,
        });
      } catch (err) {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => { /* residue */ });
        throw err;
      }
      clearForkIntent(uid, contentId);
      report.completed.push(contentId);
      log.info('finished interrupted fork at startup', { contentId, version: intent.version, customId });
    } catch (err) {
      // 意图**保留**：这一轮没做成不代表下一轮做不成，丢掉意图才是真的丢掉用户的决定。
      log.warn('fork recovery failed for this content; intent kept', {
        contentId, error: (err as Error).message,
      });
    }
  }
  return report;
}
