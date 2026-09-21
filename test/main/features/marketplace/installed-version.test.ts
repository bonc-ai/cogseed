import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import AdmZip from 'adm-zip';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CogSeedTaskRecord } from '../../../../src/main/features/cogseed_backend/types';
import { makeCompliantSkillPackage } from '../../../fixtures/make-skill-packages';

// `paths.ts` 的 WS_ROOT 是模块级常量：工作区在导入前建好且只建一次，用例按 uid 隔离。
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-installed-version-'));

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

const iv = await import('../../../../src/main/features/marketplace/installed-version');
const store = await import('../../../../src/main/features/marketplace/version-store');
const pinScan = await import('../../../../src/main/features/marketplace/pin-scan');
const paths = await import('../../../../src/main/paths');

const CONTENT_ID = 'a1b2c3d4e5f6';

let uidSeq = 0;
let UID = '';

beforeEach(() => {
  uidSeq += 1;
  UID = `u_installed_version_${uidSeq}`;
  listCogSeedTasks.mockReset();
  listCogSeedTasks.mockResolvedValue([]);
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

/**
 * 把内容原子落盘成「已安装 vN」的磁盘事实。
 * 顺序与既有安装链路一致：**内容先就位，`_install.json` 最后写**（success marker）。
 */
function landInstalled(version: string, extra: Record<string, unknown> = {}): void {
  const dir = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: x\nversion: ${version}\n---\n`);
  fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify({
    version, published_at: 1, installed_at: Date.now(),
    artifact_sha256: `artifact-${version}`, artifact_size_bytes: 1024,
    content_sha: `skillmd-${version}`, ...extra,
  }, null, 2));
}

/** 内容已落但成功标记尚未写——落盘被中断的磁盘形态。 */
function landWithoutMarker(version: string): void {
  const dir = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: x\nversion: ${version}\n---\n`);
}

/** 写一份已下载并校验通过的不可变版本副本（更新可以先做完这一步）。 */
async function stageVerifiedCopy(version: string): Promise<void> {
  const pkg = makeCompliantSkillPackage(undefined, version);
  const src = path.join(workspace, 'sources', UID, version);
  fs.mkdirSync(src, { recursive: true });
  new AdmZip(pkg.bytes).extractAllTo(src, true);
  await store.writeVersionCopy(
    UID, { contentId: CONTENT_ID, version, sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }, src,
  );
}

function task(status: string, version: string): CogSeedTaskRecord {
  return {
    status,
    skillVersionPins: [{ skillId: CONTENT_ID, version, manifestHash: 'h'.repeat(64) }],
  } as unknown as CogSeedTaskRecord;
}

describe('marketplace/installed-version：actual version = 已成功原子落盘的本地内容事实', () => {
  describe('⭐ 六个状态（FR-019 的可执行判据）', () => {
    it('① target v4，下载失败 → actual 仍 v3', async () => {
      landInstalled('3.0.0');
      // 下载失败：既没有 v4 的版本副本，也没有触碰安装目录。
      expect(iv.installedVersionOf(UID, CONTENT_ID)).toBe('3.0.0');
      expect(store.resolveVersionCopy(UID, CONTENT_ID, '4.0.0')).toBeNull();
    });

    it('② v4 下载成功但校验失败 → actual 仍 v3', async () => {
      landInstalled('3.0.0');
      // 校验失败时 source-fetch 不返回字节、不落盘（FR-011），故副本不存在。
      expect(store.resolveVersionCopy(UID, CONTENT_ID, '4.0.0')).toBeNull();
      expect(iv.installedVersionOf(UID, CONTENT_ID)).toBe('3.0.0');
    });

    it('③ v4 校验成功但替换前 crash → actual 仍 v3', async () => {
      landInstalled('3.0.0');
      await stageVerifiedCopy('4.0.0');   // 下载与校验已完成

      // 崩溃发生在原子替换之前：安装目录与其 success marker 都没动过。
      expect(iv.readInstalledVersion(UID, CONTENT_ID)).toMatchObject({ version: '3.0.0', state: 'installed' });
      // v4 副本确实已就位——「下载/校验可提前」与「actual 仍是 v3」并存。
      expect(store.resolveVersionCopy(UID, CONTENT_ID, '4.0.0')).not.toBeNull();
    });

    it('④ Task pin v3，v4 已下载校验但仍在使用 → current 与 Task 都仍是 v3', async () => {
      landInstalled('3.0.0');
      await stageVerifiedCopy('3.0.0');
      await stageVerifiedCopy('4.0.0');
      listCogSeedTasks.mockResolvedValue([task('running', '3.0.0')]);

      // current（= 实际落盘事实）没有前进。
      expect(iv.installedVersionOf(UID, CONTENT_ID)).toBe('3.0.0');
      // 使用中的 Task 仍解析到开始时的 v3。
      await expect(pinScan.hasActivePin(UID, CONTENT_ID, '3.0.0')).resolves.toBe(true);
      expect(store.resolveVersionCopy(UID, CONTENT_ID, '3.0.0')).not.toBeNull();
      // v4 已备好但未生效。
      expect(store.resolveVersionCopy(UID, CONTENT_ID, '4.0.0')).not.toBeNull();
    });

    it('⑤ 使用结束并成功原子替换 → actual 才变 v4', async () => {
      landInstalled('3.0.0');
      await stageVerifiedCopy('4.0.0');
      listCogSeedTasks.mockResolvedValue([task('completed', '3.0.0')]);

      expect(iv.installedVersionOf(UID, CONTENT_ID)).toBe('3.0.0');
      // 使用已结束（终态），不再钉固。
      await expect(pinScan.hasActivePin(UID, CONTENT_ID, '3.0.0')).resolves.toBe(false);

      landInstalled('4.0.0');   // 原子替换完成，success marker 随之推进

      expect(iv.installedVersionOf(UID, CONTENT_ID)).toBe('4.0.0');
    });

    it('⑥ restart 后仍能从本地事实得到正确 actual version', () => {
      landInstalled('3.0.0');
      const before = iv.readInstalledVersion(UID, CONTENT_ID);

      // 「重启」= 不做任何恢复动作，重新从磁盘读一遍。本模块无内存状态。
      const after = iv.readInstalledVersion(UID, CONTENT_ID);

      expect(after).toEqual(before);
      expect(after.version).toBe('3.0.0');
    });
  });

  describe('⭐ 目标版本不得冒充实际已安装版本（发现 12）', () => {
    it('安装清单的 version 领先于内容时，实际版本仍取内容事实', () => {
      landInstalled('3.0.0');
      // 模拟检查阶段已把清单 version 推进到 4.0.0（目标版本）。
      const manifestTargetVersion = '4.0.0';

      expect(iv.installedVersionOf(UID, CONTENT_ID)).toBe('3.0.0');
      expect(iv.isTargetAheadOfContent(UID, CONTENT_ID, manifestTargetVersion)).toBe(true);
    });

    it('目标与内容一致时不报「领先」', () => {
      landInstalled('3.0.0');
      expect(iv.isTargetAheadOfContent(UID, CONTENT_ID, '3.0.0')).toBe(false);
    });
  });

  describe('判不出时返回 null，绝不猜', () => {
    it('内容树不存在 → absent / null', () => {
      expect(iv.readInstalledVersion(UID, CONTENT_ID)).toMatchObject({ version: null, state: 'absent' });
    });

    it('内容在但成功标记未写（落盘被中断）→ unmarked / null，不得当作已安装', () => {
      landWithoutMarker('4.0.0');
      expect(iv.readInstalledVersion(UID, CONTENT_ID)).toMatchObject({ version: null, state: 'unmarked' });
    });

    it('标记损坏或缺 version → unreadable / null，且不抛错', () => {
      landInstalled('3.0.0');
      fs.writeFileSync(path.join(paths.userMarketplaceSkillDir(UID, CONTENT_ID), '_install.json'), '{ broken');
      expect(iv.readInstalledVersion(UID, CONTENT_ID)).toMatchObject({ version: null, state: 'unreadable' });

      fs.writeFileSync(path.join(paths.userMarketplaceSkillDir(UID, CONTENT_ID), '_install.json'), '{"published_at":1}');
      expect(iv.readInstalledVersion(UID, CONTENT_ID)).toMatchObject({ version: null, state: 'unreadable' });
    });

    it('空参数不抛错', () => {
      expect(iv.installedVersionOf(UID, '')).toBeNull();
      expect(iv.installedVersionOf('', CONTENT_ID)).toBeNull();
    });
  });

  describe('完整性依据是 artifact.sha256', () => {
    it('带出发布物摘要 artifact_sha256 与大小，供完整性核对', () => {
      landInstalled('3.0.0');
      const fact = iv.readInstalledVersion(UID, CONTENT_ID);
      expect(fact.artifactSha256).toBe('artifact-3.0.0');
      expect(fact.artifactSizeBytes).toBe(1024);
    });

    it('⚠️ 不与既有 content_sha 混淆——后者是 SKILL.md 单文件摘要，两者并存且不同', () => {
      landInstalled('3.0.0');
      const fact = iv.readInstalledVersion(UID, CONTENT_ID);
      expect(fact.contentSha).toBe('skillmd-3.0.0');
      expect(fact.contentSha).not.toBe(fact.artifactSha256);
    });
  });

  describe('⭐ 明确禁止的实现方式（结构断言）', () => {
    it('本模块不读安装清单 installs.json、不消费 bundle_url、不联网', () => {
      const raw = fs.readFileSync(
        path.join(__dirname, '../../../../src/main/features/marketplace/installed-version.ts'), 'utf8',
      );
      // 按代码断言：注释里刻意写明了「禁止用 bundle_url」，谈论不等于使用。
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

      expect(code).not.toContain('bundle_url');
      expect(code).not.toContain('installs.json');
      expect(code).not.toContain('userMarketplaceInstallsFile');
      expect(code).not.toMatch(/fetch\(|postJson|http/);
      // 反向自检：注释确实提到了它们，说明过滤的是注释而非整段清空。
      expect(raw).toContain('bundle_url');
    });

    it('不存在伪造的 hub:// 形式地址', () => {
      const raw = fs.readFileSync(
        path.join(__dirname, '../../../../src/main/features/marketplace/installed-version.ts'), 'utf8',
      );
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code).not.toContain('hub://');
    });
  });
});
