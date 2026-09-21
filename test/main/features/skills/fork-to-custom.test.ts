/**
 * Phase 9：派生为自定义 Skill（PRD §7.7 / specs/010 FR-054–FR-060，判据 `C10` `C11` `SC-007`）。
 *
 * 用合成夹具（`test/fixtures/make-skill-packages.ts`），不接触真实发布物或账号。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import AdmZip from 'adm-zip';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CogSeedTaskRecord } from '../../../../src/main/features/cogseed_backend/types';
import { FIXTURE_SKILL_ID, makeCompliantSkillPackage } from '../../../fixtures/make-skill-packages';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-fork-'));
process.env.COGSEED_WORKSPACE_ROOT = workspace;

const listCogSeedTasks = vi.fn<(userId: string) => Promise<CogSeedTaskRecord[]>>();

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => workspace), isPackaged: false, getVersion: vi.fn(() => '1.1.2') },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));
vi.mock('../../../../src/main/features/cogseed_backend/task-store', () => ({
  listCogSeedTasks: (userId: string) => listCogSeedTasks(userId),
}));
vi.mock('../../../../src/main/model/client', () => ({
  streamChatWithModel: () => (async function* () { /* unused */ })(),
  chatWithModel: vi.fn(async () => ({ ok: true, text: 'ok', error: '', aborted: false })),
}));

const fork = await import('../../../../src/main/features/marketplace/fork-to-custom');
const store = await import('../../../../src/main/features/marketplace/version-store');
const gc = await import('../../../../src/main/features/marketplace/version-gc');
const usage = await import('../../../../src/main/features/marketplace/usage-event');
const skills = await import('../../../../src/main/features/skills');
const installs = await import('../../../../src/main/features/marketplace_installs');
const users = await import('../../../../src/main/features/users');
const paths = await import('../../../../src/main/paths');

const SRC = path.resolve(__dirname, '../../../../src');
const CONTENT_ID = 'a1b2c3d4e5f6';
/** 夹具包的 `SKILL.md` 里 `name: fixture0skill0id` —— 派生后沿用的原名称。 */
const ORIGINAL_NAME = FIXTURE_SKILL_ID;

let uidSeq = 0;
let UID = '';

beforeEach(() => {
  uidSeq += 1;
  UID = `u_fork_${uidSeq}`;
  users.activateUser(UID);
  skills.clearSkillListCache();
  listCogSeedTasks.mockReset();
  listCogSeedTasks.mockResolvedValue([]);
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/** 解出夹具包的内容树（`SKILL.md` 在根），形状与安装后的 current install 一致。 */
function extractFixtureTree(version: string): string {
  const pkg = makeCompliantSkillPackage(undefined, version);
  const out = path.join(workspace, 'sources', UID, version);
  fs.mkdirSync(out, { recursive: true });
  new AdmZip(pkg.bytes).extractAllTo(out, true);
  return path.join(out, FIXTURE_SKILL_ID);
}

/** 落一份不可变版本副本。 */
async function landVersionCopy(version: string): Promise<void> {
  const pkg = makeCompliantSkillPackage(undefined, version);
  await store.writeVersionCopy(
    UID,
    { contentId: CONTENT_ID, version, sha256: pkg.sha256, sizeBytes: pkg.sizeBytes },
    extractFixtureTree(version),
  );
}

/**
 * 落一份 current install。
 *
 * `manifestVersion` 刻意可与 `_install.json` 的版本不同 —— 清单里的是**目标版本**，
 * 更新失败时会领先于本机内容。派生必须取后者。
 */
async function landCurrentInstall(version: string, manifestVersion = version): Promise<void> {
  const dir = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(extractFixtureTree(version), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify({
    version, published_at: 1, installed_at: Date.now(),
  }));
  // `_isSkillRow` 要求这几项齐备，否则读清单时该行会被过滤掉。
  // `bundle_url` 恒为空串：Hub 内容不再下发下载地址（`installed-version.ts` 的明确禁止项）。
  await installs.addSkillInstall(UID, {
    id: CONTENT_ID,
    version: manifestVersion,
    name: ORIGINAL_NAME,
    published_at: 1,
    bundle_url: '',
    installed_at: Date.now(),
  } as never);
}

async function landOfficialCopy(version = '1.0.0', manifestVersion = version): Promise<void> {
  await landVersionCopy(version);
  await landCurrentInstall(version, manifestVersion);
}

function customDir(id: string): string {
  return path.join(paths.userSkillsDir(UID), id);
}

function sidecarOf(id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(customDir(id), '_meta.json'), 'utf8'));
}

function officialInstalled(): boolean {
  return fs.existsSync(paths.userMarketplaceSkillDir(UID, CONTENT_ID));
}

function intentExists(): boolean {
  return fs.existsSync(paths.userMarketplaceForkIntentFile(UID, CONTENT_ID));
}

function treeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel = ''): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), next);
      else out.push(next);
    }
  };
  walk(dir);
  return out;
}

describe('Phase 9 派生为自定义 Skill（FR-054–FR-060）', () => {
  describe('⭐ T074 先提示后果，用户确认后才执行（FR-054）', () => {
    it('未确认时抛错，且磁盘状态一点没动', async () => {
      await landOfficialCopy();

      await expect(fork.forkOfficialSkillToCustom(UID, CONTENT_ID)).rejects.toThrow();
      await expect(fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: false })).rejects.toThrow();

      expect(officialInstalled()).toBe(true);
      expect(fs.existsSync(customDir(ORIGINAL_NAME))).toBe(false);
      expect(intentExists()).toBe(false);
    });

    it('后果文案由调用方展示：主进程只给文案键，不弹窗', () => {
      expect(fork.FORK_CONSEQUENCE_I18N_KEY).toBe('skills.fork.consequence');
      const zh = JSON.parse(readSrc('main/locales/zh.json')) as Record<string, string>;
      // 三件事都要说到：可修改、不再自动更新、不受 Hub 停用影响。
      expect(zh[fork.FORK_CONSEQUENCE_I18N_KEY]).toContain('修改');
      expect(zh[fork.FORK_CONSEQUENCE_I18N_KEY]).toContain('自动更新');
      expect(zh[fork.FORK_CONSEQUENCE_I18N_KEY]).toContain('停用');
      const code = readSrc('main/features/marketplace/fork-to-custom.ts');
      expect(code).not.toContain('dialog');
      expect(code).not.toContain('BrowserWindow');
    });
  });

  describe('⭐ T075 先卸载官方副本（记 tombstone）再复制（FR-055）', () => {
    it('派生完成后：官方安装树与清单行都没了，墓碑已记，自定义副本已在', async () => {
      await landOfficialCopy();

      const result = await fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: true });

      expect(officialInstalled()).toBe(false);
      const manifest = await installs.readInstalls(UID);
      expect(manifest.skills.find((s) => s.id === CONTENT_ID)).toBeUndefined();
      expect(manifest._deleted_at?.skills?.[CONTENT_ID]).toBeGreaterThan(0);
      expect(fs.existsSync(customDir(result.customId))).toBe(true);
      expect(intentExists()).toBe(false);
    });

    it('⚠️ T082 顺序不可颠倒：官方副本还在时提升会触发同名禁止', async () => {
      await landOfficialCopy();

      // 「先复制后卸载」在提升那一步被拒 —— 用的是客户端既有的同名禁止文案。
      expect(() => fork.assertOfficialCopyAbsent(UID, CONTENT_ID, ORIGINAL_NAME))
        .toThrow(/conflicts with a marketplace skill|与平台技能冲突/);

      await fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: true });
      // 卸载之后同一判定放行。
      expect(() => fork.assertOfficialCopyAbsent(UID, CONTENT_ID, ORIGINAL_NAME)).not.toThrow();
    });

    it('官方副本与派生副本不可能同时存在（「两份」被结构性排除）', async () => {
      await landOfficialCopy();
      const result = await fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: true });

      expect(officialInstalled()).toBe(false);
      expect(fs.existsSync(customDir(result.customId))).toBe(true);
    });
  });

  describe('⭐ T076 复制源必须是版本副本（FR-056）', () => {
    it('派生副本的内容树与版本副本逐文件一致', async () => {
      await landOfficialCopy();
      const copyTree = store.resolveVersionCopy(UID, CONTENT_ID, '1.0.0')!;
      const expected = treeFiles(copyTree);

      const result = await fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: true });

      // 派生副本多出一个 `_meta.json`（forked_from 的落点），其余逐文件相同。
      const actual = treeFiles(customDir(result.customId)).filter((f) => f !== '_meta.json');
      expect(actual).toEqual(expected);
      expect(fs.readFileSync(path.join(customDir(result.customId), 'reference.md'), 'utf8'))
        .toBe(fs.readFileSync(path.join(copyTree, 'reference.md'), 'utf8'));
    });

    it('没有版本副本时拒绝派生，且**不卸载**官方副本（失败不破坏现状）', async () => {
      await landCurrentInstall('1.0.0');

      await expect(fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: true })).rejects.toThrow();

      expect(officialInstalled()).toBe(true);
      expect(intentExists()).toBe(false);
      expect(fs.existsSync(customDir(ORIGINAL_NAME))).toBe(false);
    });
  });

  describe('⭐ T077 新自定义 ID + 沿用原名 + 写 forked_from（FR-057/FR-058）', () => {
    it('id 是新的自定义 id、名称沿用原名、forked_from 已写入', async () => {
      await landOfficialCopy();

      const result = await fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: true });

      expect(result.customId).not.toBe(CONTENT_ID);
      expect(result.renamed).toBe(false);
      expect(result.name).toBe(ORIGINAL_NAME);
      const listed = await skills.getCustomSkill(result.customId);
      expect(listed?.name).toBe(ORIGINAL_NAME);
      expect(listed?.source).toBe('custom');
      expect(sidecarOf(result.customId).forked_from).toEqual({ content_id: CONTENT_ID, version: '1.0.0' });
    });

    it('⚠️ version 取本机**实际已安装版本**，不取清单里的目标版本', async () => {
      // 清单说 9.9.9（检查阶段已推进），本机内容其实还是 1.0.0。
      await landOfficialCopy('1.0.0', '9.9.9');

      const result = await fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: true });

      expect(sidecarOf(result.customId).forked_from).toEqual({ content_id: CONTENT_ID, version: '1.0.0' });
    });

    it('派生 id 必须不同于 content_id —— 否则 Hub 隔离直接失效', async () => {
      await landOfficialCopy();
      const result = await fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: true });

      // 版本副本仍在，所以 content_id 仍被判为 Hub 内容；派生副本必须判不到。
      expect(store.isHubManagedContent(UID, CONTENT_ID)).toBe(true);
      expect(store.isHubManagedContent(UID, result.customId)).toBe(false);
    });

    it('`forked_from` 迭代一只写不读：src 下只有写入点', () => {
      const walk = (dir: string, out: string[] = []): string[] => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full, out);
          else if (e.name.endsWith('.ts')) out.push(full);
        }
        return out;
      };
      const readers = walk(path.join(SRC, 'main'))
        .filter((f) => {
          const code = fs.readFileSync(f, 'utf8');
          // 读取的形态：成员访问或解构。写入点用的是对象字面量的键。
          return /\.forked_from\b/.test(code) || /forked_from\s*[,}]\s*=/.test(code);
        })
        .map((f) => path.relative(SRC, f).split(path.sep).join('/'));
      expect(readers).toEqual([]);
    });
  });

  describe('⭐ T078 / T081 重装官方版时同名先提示改名（FR-060，`C11`）', () => {
    it('同名时抛 SkillNameConflictError，带冲突方与建议名称', async () => {
      await landOfficialCopy();
      const result = await fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: true });

      await expect(fork.assertOfficialReinstallNameIsFree(ORIGINAL_NAME))
        .rejects.toBeInstanceOf(fork.SkillNameConflictError);
      try {
        await fork.assertOfficialReinstallNameIsFree(ORIGINAL_NAME);
      } catch (err) {
        const conflict = err as InstanceType<typeof fork.SkillNameConflictError>;
        expect(conflict.conflictingSkillIds).toEqual([result.customId]);
        expect(conflict.suggestedName).not.toBe(ORIGINAL_NAME);
        expect(conflict.suggestedName).toBeTruthy();
      }
    });

    it('没有同名自定义 Skill 时放行', async () => {
      await expect(fork.assertOfficialReinstallNameIsFree(ORIGINAL_NAME)).resolves.toBeUndefined();
      await expect(fork.assertOfficialReinstallNameIsFree('')).resolves.toBeUndefined();
    });

    it('改名后重装放行：两条并存且来源可区分', async () => {
      await landOfficialCopy();
      const result = await fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: true });

      const renamedId = await fork.renameForkedCustomSkill(result.customId, `${ORIGINAL_NAME}b`);
      expect(renamedId).toBe(`${ORIGINAL_NAME}b`);
      await expect(fork.assertOfficialReinstallNameIsFree(ORIGINAL_NAME)).resolves.toBeUndefined();

      // 重装官方版（落回 current install）后两条并存。
      await landCurrentInstall('1.0.0');
      expect(officialInstalled()).toBe(true);
      expect(fs.existsSync(customDir(renamedId))).toBe(true);
      // 来源可区分：派生副本带 forked_from，官方副本在 marketplace 树下。
      expect(sidecarOf(renamedId).forked_from).toEqual({ content_id: CONTENT_ID, version: '1.0.0' });
      // 重装清墓碑（既有行为）。
      const manifest = await installs.readInstalls(UID);
      expect(manifest._deleted_at?.skills?.[CONTENT_ID]).toBeUndefined();
    });

    it('同名检查只挂在显式重装上，自动撒种与周期更新不受影响', () => {
      const code = readSrc('main/features/marketplace.ts');
      const guard = code.slice(code.indexOf('assertOfficialReinstallNameIsFree') - 400);
      expect(guard).toContain("opts.force === true");
      // 判据是显示名称，不是 forked_from（FR-057 只写不读）。
      const forkCode = readSrc('main/features/marketplace/fork-to-custom.ts');
      const fn = forkCode.slice(forkCode.indexOf('export async function assertOfficialReinstallNameIsFree'));
      expect(fn.slice(0, 700)).toContain('findCustomSkillIdsByDisplayName');
      expect(fn.slice(0, 700)).not.toContain('forked_from');
    });
  });

  describe('⭐ T079 列表仍是一条（`C10`）', () => {
    it('派生后该名称在列表里恰好一条，来源为 custom', async () => {
      await landOfficialCopy();
      const result = await fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: true });

      skills.clearSkillListCache();
      const listed = (await skills.listSkills()).filter((s) => s.name === ORIGINAL_NAME);
      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe(result.customId);
      expect(listed[0].source).toBe('custom');
    });
  });

  describe('⭐ T080 派生后 Hub 的更新 / 停用 / 事件影响项数为 0（FR-059，SC-007）', () => {
    it('Hub 再发 v2：派生副本内容逐字节不变', async () => {
      await landOfficialCopy();
      const result = await fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: true });
      const before = fs.readFileSync(path.join(customDir(result.customId), 'SKILL.md'), 'utf8');
      const filesBefore = treeFiles(customDir(result.customId));

      // Hub 发布并落地 v2（版本副本 + 新的 current install）。
      await landOfficialCopy('2.0.0');

      expect(fs.readFileSync(path.join(customDir(result.customId), 'SKILL.md'), 'utf8')).toBe(before);
      expect(treeFiles(customDir(result.customId))).toEqual(filesBefore);
    });

    it('停用与 pin 来源分派都判不到派生副本', async () => {
      await landOfficialCopy();
      const result = await fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: true });

      // 停用判定与更新都以「是 Hub 管理的内容」为前提，派生副本恒为 false。
      expect(store.isHubManagedContent(UID, result.customId)).toBe(false);
      expect(store.hubPinIdentity(UID, result.customId)).toBeNull();
    });

    it('`hub_content_used` 对派生副本产生 0 条', async () => {
      await landOfficialCopy();
      const result = await fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: true });

      const sent: unknown[] = [];
      usage.setUsageEventSender((e) => { sent.push(e); });
      usage.setConsentReader(() => 'granted');
      try {
        const event = usage.recordHubContentUsage({
          userId: UID, contentId: result.customId, pinnedVersion: '1.0.0', result: 'success',
        });
        expect(event).toBeNull();
        expect(sent).toHaveLength(0);
        expect(usage.isHubOfficialUse(UID, result.customId, '1.0.0')).toBe(false);
      } finally {
        usage.setUsageEventSender(null);
        usage.setConsentReader(null);
      }
    });

    it('回收也碰不到派生副本：它不在 Hub 版本存储那棵树下', async () => {
      await landOfficialCopy();
      const result = await fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: true });

      await gc.runVersionGc(UID, { now: Date.now() + 365 * 24 * 60 * 60 * 1000 });

      expect(fs.existsSync(customDir(result.customId))).toBe(true);
      const code = readSrc('main/features/marketplace/version-gc.ts');
      expect(code).not.toContain('userSkillsDir');
    });
  });

  describe('⭐ 崩溃恢复：既不留两份，也不永久留零份', () => {
    it('崩在卸载之后、提升之前 → 启动恢复把派生做完', async () => {
      await landOfficialCopy();
      // 复刻中断状态：意图已落盘、官方副本已卸载、自定义副本还没有。
      const marketplace = await import('../../../../src/main/features/marketplace');
      fs.writeFileSync(paths.userMarketplaceForkIntentFile(UID, CONTENT_ID), JSON.stringify({
        content_id: CONTENT_ID, version: '1.0.0', name: ORIGINAL_NAME, created_at: Date.now(),
      }));
      await marketplace.uninstallMarketplaceSkill(CONTENT_ID);
      expect(fs.existsSync(customDir(ORIGINAL_NAME))).toBe(false);

      const report = await fork.recoverInterruptedForks(UID);

      expect(report.completed).toEqual([CONTENT_ID]);
      expect(fs.existsSync(customDir(ORIGINAL_NAME))).toBe(true);
      expect(sidecarOf(ORIGINAL_NAME).forked_from).toEqual({ content_id: CONTENT_ID, version: '1.0.0' });
      expect(intentExists()).toBe(false);
    });

    it('崩在卸载之前 → 丢弃意图，不产生副本（官方副本还在，什么都没丢）', async () => {
      await landOfficialCopy();
      fs.writeFileSync(paths.userMarketplaceForkIntentFile(UID, CONTENT_ID), JSON.stringify({
        content_id: CONTENT_ID, version: '1.0.0', name: ORIGINAL_NAME, created_at: Date.now(),
      }));

      const report = await fork.recoverInterruptedForks(UID);

      expect(report.discarded).toEqual([CONTENT_ID]);
      expect(officialInstalled()).toBe(true);
      expect(fs.existsSync(customDir(ORIGINAL_NAME))).toBe(false);
      expect(intentExists()).toBe(false);
    });

    it('派生其实已完成、只是意图没清 → 清意图，不产生第二份', async () => {
      await landOfficialCopy();
      const result = await fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: true });
      fs.writeFileSync(paths.userMarketplaceForkIntentFile(UID, CONTENT_ID), JSON.stringify({
        content_id: CONTENT_ID, version: '1.0.0', name: result.customId, created_at: Date.now(),
      }));

      const report = await fork.recoverInterruptedForks(UID);

      expect(report.completed).toEqual([]);
      expect(intentExists()).toBe(false);
      const ids = fs.readdirSync(paths.userSkillsDir(UID)).filter((n) => !n.startsWith('.'));
      expect(ids).toEqual([result.customId]);
    });

    it('版本副本也没了 → 放弃并清意图，不猜内容', async () => {
      fs.mkdirSync(paths.userSkillsDir(UID), { recursive: true });
      fs.writeFileSync(paths.userMarketplaceForkIntentFile(UID, CONTENT_ID), JSON.stringify({
        content_id: CONTENT_ID, version: '1.0.0', name: ORIGINAL_NAME, created_at: Date.now(),
      }));

      const report = await fork.recoverInterruptedForks(UID);

      expect(report.discarded).toEqual([CONTENT_ID]);
      expect(fs.existsSync(customDir(ORIGINAL_NAME))).toBe(false);
      expect(intentExists()).toBe(false);
    });

    it('暂存残留被清除，且提升前对列表不可见（点号前缀）', async () => {
      await landOfficialCopy();
      const residue = path.join(paths.userSkillsDir(UID), '.fork-deadbeef0000');
      fs.mkdirSync(residue, { recursive: true });
      fs.writeFileSync(path.join(residue, 'SKILL.md'), `---\nname: ${ORIGINAL_NAME}\n---\n`);

      skills.clearSkillListCache();
      expect((await skills.listSkills()).some((s) => s.id.startsWith('.fork-'))).toBe(false);

      await fork.recoverInterruptedForks(UID);
      expect(fs.existsSync(residue)).toBe(false);
    });

    it('恢复在启动期接线，且不抛给启动流程', () => {
      const code = readSrc('main/features/marketplace.ts');
      expect(code).toContain("registerDeferred('marketplace:fork-recovery'");
      const task = code.slice(code.indexOf("registerDeferred('marketplace:fork-recovery'"));
      expect(task.slice(0, 600)).toContain('recoverInterruptedForks');
      expect(task.slice(0, 600)).toContain('catch');
    });
  });

  describe('结构约束：复用既有能力，不新增第二套身份或命名空间', () => {
    it('派生副本落在既有自定义 Skill 树下，不新建目录层级', async () => {
      await landOfficialCopy();
      const result = await fork.forkOfficialSkillToCustom(UID, CONTENT_ID, { confirmed: true });

      expect(path.dirname(customDir(result.customId))).toBe(paths.userSkillsDir(UID));
    });

    it('卸载、墓碑、自定义 Skill 落地都走既有实现', () => {
      const code = readSrc('main/features/marketplace/fork-to-custom.ts');
      expect(code).toContain('uninstallMarketplaceSkill');
      expect(code).toContain('adoptCustomSkillFromStagedTree');
      // 不自己删清单行、不自己写墓碑、不自己实现第二套安装。
      expect(code).not.toContain('removeSkillInstall');
      expect(code).not.toContain('_deleted_at');
      expect(code).not.toContain('installs.json');
    });

    it('同名禁止仍只有一处 id 级实现（`skills.ts`）', () => {
      const code = readSrc('main/features/skills.ts');
      expect(code).toContain('export function assertCustomSkillIdAvailable');
      // 既有三处（create / rename / commander create）与自动纠正都仍在同一层。
      expect((code.match(/skills\.errors\.builtin_conflict/g) || []).length).toBeGreaterThanOrEqual(3);
    });
  });
});
