/**
 * Phase 13：跨阶段场景归集（PRD §12.2 的 `C7` / `C13`，以及 SC-002 / SC-003）。
 *
 * **本文件不替代各阶段内的测试**，补的是跨阶段才成立的那几条：一个场景里同时牵动
 * 取元信息、版本副本、pin、停用判定、current 切换与采集侧时，各模块单独为真**不等于**
 * 合起来为真。因此这里刻意按「一次使用的生命周期」编排，而不是按模块。
 *
 * 映射表见 `README.md`。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import AdmZip from 'adm-zip';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CogSeedTaskRecord } from '../../../../src/main/features/cogseed_backend/types';
import { makeCompliantSkillPackage } from '../../../fixtures/make-skill-packages';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-scenarios-'));
const listCogSeedTasks = vi.fn<(userId: string) => Promise<CogSeedTaskRecord[]>>();

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => workspace), isPackaged: false, getVersion: vi.fn(() => '1.1.2') },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));
// 只替换 `listCogSeedTasks` 一个导出：本文件要导入真实的 `marketplace.ts`，而它的模块图
// 会经群聊桥接用到 task-store 的其它导出，整体替身会把那条链路打断。
vi.mock('../../../../src/main/features/cogseed_backend/task-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listCogSeedTasks: (userId: string) => listCogSeedTasks(userId),
}));

vi.mock('../../../../src/main/util/retry', () => ({
  fetchWithRetry: vi.fn(),
  fetchAndReadWithRetry: vi.fn(),
  serverErrorEnvelopeOf: () => null,
}));

const store = await import('../../../../src/main/features/marketplace/version-store');
const installed = await import('../../../../src/main/features/marketplace/installed-version');
const policy = await import('../../../../src/main/features/marketplace/current-switch-policy');
const usage = await import('../../../../src/main/features/marketplace/usage-event');
const marketplace = await import('../../../../src/main/features/marketplace');
const paths = await import('../../../../src/main/paths');

const CONTENT_ID = 'a1b2c3d4e5f6';

let uidSeq = 0;
let UID = '';

beforeEach(() => {
  uidSeq += 1;
  UID = `u_scen_${uidSeq}`;
  listCogSeedTasks.mockReset();
  listCogSeedTasks.mockResolvedValue([]);
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function landVersionCopy(version: string): Promise<string> {
  const pkg = makeCompliantSkillPackage(undefined, version);
  const src = path.join(workspace, 'sources', UID, version);
  fs.mkdirSync(src, { recursive: true });
  new AdmZip(pkg.bytes).extractAllTo(src, true);
  await store.writeVersionCopy(
    UID, { contentId: CONTENT_ID, version, sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }, src,
  );
  return pkg.sha256;
}

/** current install 置为某一版。success marker 最后写，与真实安装链路同序。 */
function setCurrentInstall(version: string, extra: Record<string, unknown> = {}): void {
  const dir = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: x\nversion: ${version}\n---\n`);
  fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify({
    version, published_at: 1, installed_at: Date.now(), ...extra,
  }));
}

function task(status: string, version: string): CogSeedTaskRecord {
  return {
    status,
    skillVersionPins: [{ skillId: CONTENT_ID, version, manifestHash: '' }],
  } as unknown as CogSeedTaskRecord;
}

/** 一次「进行中的使用」：开始时固定 {content_id, version}，此后只认这一对。 */
function beginUse(): { version: string; manifestHash: string } {
  const pin = store.hubPinIdentity(UID, CONTENT_ID);
  expect(pin, '开始一次使用时必须能产生 pin').not.toBeNull();
  listCogSeedTasks.mockResolvedValue([task('running', pin!.version)]);
  return pin!;
}

describe('跨阶段场景（PRD §12.2）', () => {
  describe('⭐ T110 `C7`：Hub 5xx / 不可达（FR-069）', () => {
    it('Hub 不可达时，已安装内容仍可判定版本、仍可解析', async () => {
      await landVersionCopy('1.0.0');
      setCurrentInstall('1.0.0');
      const pin = beginUse();

      // 把网络整体换成必然失败的实现——解析路径若碰网络，这里就会炸。
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
      try {
        expect(installed.installedVersionOf(UID, CONTENT_ID)).toBe('1.0.0');
        expect(store.resolveHubPinnedTree(UID, CONTENT_ID, pin.version, pin.manifestHash)).not.toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('⚠️ 已开始的使用不中断：解析全程不碰网络，也不读停用状态', async () => {
      await landVersionCopy('1.0.0');
      setCurrentInstall('1.0.0');
      const pin = beginUse();

      const originalFetch = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = (() => { fetchCalls += 1; throw new Error('ECONNREFUSED'); }) as typeof fetch;
      try {
        // 连续解析多次（复刻一次使用里多次读内容）。
        for (let i = 0; i < 5; i++) {
          expect(store.resolveHubPinnedTree(UID, CONTENT_ID, pin.version, pin.manifestHash)).not.toBeNull();
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(fetchCalls, '解析路径一次网络调用都不该有').toBe(0);
    });

    it('⚠️ Hub 不可达期间不擅自解除也不擅自施加停用（沿用最近已知状态）', async () => {
      await landVersionCopy('1.0.0');
      setCurrentInstall('1.0.0', { status: 'disabled' });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
      try {
        // 最近一次检查写下的就是 disabled —— 不可达不改变这个事实。
        expect(installed.isContentDisabled(UID, CONTENT_ID)).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('⭐ T112 `C13`：使用进行中 Hub 发布 v2', () => {
    it('本次使用全程读 v1，结束后新的使用才读 v2', async () => {
      await landVersionCopy('1.0.0');
      setCurrentInstall('1.0.0');
      const pin = beginUse();
      expect(pin.version).toBe('1.0.0');

      // Hub 发布 v2 并被检查到：副本先落盘（下载与校验可以先做完）。
      await landVersionCopy('2.0.0');

      // ① 使用进行中：current 不得推进（defer-while-pinned）。
      const duringUse = await policy.decideCurrentSwitch(UID, CONTENT_ID);
      expect(duringUse).toEqual({ advance: false, reason: 'deferred-active-use' });
      // ② 本次使用仍解析到 v1——哪怕 v2 的副本已经在盘上。
      const tree = store.resolveHubPinnedTree(UID, CONTENT_ID, pin.version, pin.manifestHash);
      expect(tree).toBe(paths.userMarketplaceVersionTreeDir(UID, CONTENT_ID, '1.0.0'));

      // ③ 使用结束（终态）→ 可以推进，current 换成 v2。
      listCogSeedTasks.mockResolvedValue([task('completed', '1.0.0')]);
      const afterUse = await policy.decideCurrentSwitch(UID, CONTENT_ID);
      expect(afterUse).toEqual({ advance: true, reason: 'no-active-use' });
      setCurrentInstall('2.0.0');

      // ④ 之后新的使用读 v2。
      expect(store.hubPinIdentity(UID, CONTENT_ID)?.version).toBe('2.0.0');
      // 旧版副本仍在——上一次使用若尚未走完终态，仍解析得到。
      expect(store.resolveVersionCopy(UID, CONTENT_ID, '1.0.0')).not.toBeNull();
    });

    it('⚠️ 事件 `version` 取本次使用固定的 v1，不是已经推进到的 v2', async () => {
      await landVersionCopy('1.0.0');
      setCurrentInstall('1.0.0');
      const pin = beginUse();
      await landVersionCopy('2.0.0');
      setCurrentInstall('2.0.0'); // current 已是 v2

      const sent: Array<{ version: string }> = [];
      usage.setUsageEventSender((e) => { sent.push(e as unknown as { version: string }); });
      usage.setConsentReader(() => 'granted');
      try {
        const event = usage.recordHubContentUsage({
          userId: UID, contentId: CONTENT_ID, pinnedVersion: pin.version, result: 'success',
        });
        expect(event?.version).toBe('1.0.0');
        expect(sent).toHaveLength(1);
        expect(sent[0].version).toBe('1.0.0');
      } finally {
        usage.setUsageEventSender(null);
        usage.setConsentReader(null);
      }
      // 而此刻 current install 确实已经是 v2 —— 两者不同正是这条判据的意义。
      expect(installed.installedVersionOf(UID, CONTENT_ID)).toBe('2.0.0');
    });
  });

  describe('⭐ T113 复合场景（SC-002）：发布 + 停用 + 不可达同时发生', () => {
    it('版本恒为开始时的版本，中止数为 0', async () => {
      await landVersionCopy('1.0.0');
      setCurrentInstall('1.0.0');
      const pin = beginUse();
      const resolvedAtStart = store.resolveHubPinnedTree(UID, CONTENT_ID, pin.version, pin.manifestHash);
      expect(resolvedAtStart).not.toBeNull();

      // 三件事同时发生：v2 落盘、内容被停用、Hub 不可达。
      await landVersionCopy('2.0.0');
      setCurrentInstall('1.0.0', { status: 'disabled' });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() => { throw new Error('ECONNREFUSED'); }) as typeof fetch;

      let aborted = 0;
      const seen = new Set<string>();
      try {
        // 复刻一次使用里反复读内容：每次都必须是同一棵树。
        for (let i = 0; i < 20; i++) {
          const tree = store.resolveHubPinnedTree(UID, CONTENT_ID, pin.version, pin.manifestHash);
          if (tree === null) aborted += 1;
          else seen.add(tree);
        }
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(aborted, 'SC-002：中止率必须为 0').toBe(0);
      expect([...seen]).toEqual([paths.userMarketplaceVersionTreeDir(UID, CONTENT_ID, '1.0.0')]);
      // 停用只挡新的使用，不碰这一次。
      expect(installed.isContentDisabled(UID, CONTENT_ID)).toBe(true);
      // current 也不许在使用进行中被推进。
      expect(await policy.decideCurrentSwitch(UID, CONTENT_ID)).toMatchObject({ advance: false });
    });

    it('⚠️ `recoverable` 同样是进行中：复合场景下照样不推进、不失联', async () => {
      await landVersionCopy('1.0.0');
      setCurrentInstall('1.0.0');
      const pin = store.hubPinIdentity(UID, CONTENT_ID)!;
      listCogSeedTasks.mockResolvedValue([task('recoverable', pin.version)]);
      await landVersionCopy('2.0.0');

      expect(await policy.decideCurrentSwitch(UID, CONTENT_ID)).toMatchObject({ advance: false });
      expect(store.resolveHubPinnedTree(UID, CONTENT_ID, pin.version, pin.manifestHash)).not.toBeNull();
    });
  });

  describe('⭐ T114 `C4` 重复性（SC-003）：崩溃注入 20 次', () => {
    it('每一次崩溃后可用版本数恒为 1，从不为 0', () => {
      const runs: number[] = [];
      for (let i = 0; i < 20; i++) {
        uidSeq += 1;
        UID = `u_crash_${uidSeq}`;
        const root = paths.userMarketplaceSkillsDir(UID);
        fs.mkdirSync(root, { recursive: true });

        // 复刻 promote 的两次 rename 之间被强制结束：旧版已被挪进 `.trash-*`，
        // 新版还没 rename 回来 —— 此刻磁盘上**没有**可用的 current install。
        const hex = `${i.toString(16).padStart(12, '0')}`;
        const trash = path.join(root, marketplace.quarantineTrashName(CONTENT_ID, hex));
        fs.mkdirSync(trash, { recursive: true });
        fs.writeFileSync(path.join(trash, 'SKILL.md'), '---\nname: x\nversion: 1.0.0\n---\n');
        fs.writeFileSync(path.join(trash, '_install.json'), JSON.stringify({ version: '1.0.0' }));
        // 同时留一个未通过校验的 staging 残留，恢复必须只认 trash。
        fs.mkdirSync(path.join(root, marketplace.quarantineStagingName(hex)), { recursive: true });
        expect(installed.installedVersionOf(UID, CONTENT_ID), '崩溃瞬间确实没有可用版本').toBeNull();

        // 重启：启动期孤儿清理跑一轮。
        marketplace.cleanupOrphanedStagingDirs(UID);

        const version = installed.installedVersionOf(UID, CONTENT_ID);
        runs.push(version === null ? 0 : 1);
        expect(version, `第 ${i + 1} 次崩溃后应恢复到旧版`).toBe('1.0.0');
        // 残留必须清干净，且不会被当成第二份内容。
        expect(fs.existsSync(trash)).toBe(false);
        expect(fs.readdirSync(root).filter((n) => n.startsWith('.'))).toEqual([]);
      }
      expect(runs).toHaveLength(20);
      expect(new Set(runs), 'SC-003：可用版本数恒为 1，从不为 0').toEqual(new Set([1]));
    });

    it('⚠️ 新版已经就位时，trash 里的旧版是残留而不是唯一副本 —— 删掉而不是复活', () => {
      uidSeq += 1;
      UID = `u_crash_done_${uidSeq}`;
      const root = paths.userMarketplaceSkillsDir(UID);
      fs.mkdirSync(root, { recursive: true });
      setCurrentInstall('2.0.0');
      const trash = path.join(root, marketplace.quarantineTrashName(CONTENT_ID, 'aabbccddeeff'));
      fs.mkdirSync(trash, { recursive: true });
      fs.writeFileSync(path.join(trash, 'SKILL.md'), '---\nname: x\nversion: 1.0.0\n---\n');

      marketplace.cleanupOrphanedStagingDirs(UID);

      expect(fs.existsSync(trash)).toBe(false);
      expect(installed.installedVersionOf(UID, CONTENT_ID)).toBe('2.0.0');
    });
  });
});
