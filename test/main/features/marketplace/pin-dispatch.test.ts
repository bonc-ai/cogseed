import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import AdmZip from 'adm-zip';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCompliantSkillPackage } from '../../../fixtures/make-skill-packages';

// `paths.ts` 的 WS_ROOT 是模块级常量：工作区在导入前建好且只建一次，用例按 uid 隔离。
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-pin-dispatch-'));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => workspace), isPackaged: false, getVersion: vi.fn(() => '1.1.2') },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

const store = await import('../../../../src/main/features/marketplace/version-store');
const paths = await import('../../../../src/main/paths');

const CONTENT_ID = 'a1b2c3d4e5f6';

let uidSeq = 0;
let UID = '';

beforeEach(() => {
  uidSeq += 1;
  UID = `u_pin_dispatch_${uidSeq}`;
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** 写一份版本副本，返回其 artifact 摘要（Hub pin 的 manifestHash 即此值）。 */
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

/** 把 current install 置为某一版（success marker 最后写，与真实链路一致）。 */
function setCurrentInstall(version: string): void {
  const dir = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: x\nversion: ${version}\n---\n`);
  fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify({
    version, published_at: 1, installed_at: Date.now(),
  }));
}

/** 内容级停用：客户端判定停用读的是 status 字符串。 */
function markDisabled(): void {
  const marker = path.join(paths.userMarketplaceSkillDir(UID, CONTENT_ID), '_install.json');
  const meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
  fs.writeFileSync(marker, JSON.stringify({ ...meta, status: 'disabled' }));
}

describe('marketplace：TaskRun pin 按来源分派（FR-029～FR-033）', () => {
  describe('⭐ T040 回归：Hub Skill 现在产生 pin（基线为不产生）', () => {
    it('装好一版并有副本 → 取得 pin 身份；基线的 listSkillVersions 对 Hub 恒为空故产不出', async () => {
      const sha = await landVersionCopy('1.0.0');
      setCurrentInstall('1.0.0');

      const hub = store.hubPinIdentity(UID, CONTENT_ID);

      expect(hub).not.toBeNull();
      expect(hub?.version).toBe('1.0.0');
      // manifestHash 对 Hub pin 承载的是 artifact.sha256（pin 形状不变，见契约不变量）。
      expect(hub?.manifestHash).toBe(sha);
    });

    it('未安装 → 不产生 pin，而不是产生一个指不到内容的 pin', () => {
      expect(store.hubPinIdentity(UID, CONTENT_ID)).toBeNull();
      expect(store.isHubManagedContent(UID, CONTENT_ID)).toBe(false);
    });

    it('已装但该版本没有副本 → 不产生 pin', () => {
      setCurrentInstall('1.0.0');
      expect(store.hubPinIdentity(UID, CONTENT_ID)).toBeNull();
      // 但仍被认定为 Hub 管理的内容（安装事实存在）——解析侧据此报 UNAVAILABLE 而非走旧路径。
      expect(store.isHubManagedContent(UID, CONTENT_ID)).toBe(true);
    });

    it('落盘未完成（无 success marker）→ 判不出实际版本，不产生 pin', async () => {
      await landVersionCopy('1.0.0');
      const dir = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\n---\n');

      expect(store.hubPinIdentity(UID, CONTENT_ID)).toBeNull();
    });
  });

  describe('⭐ T044：执行期 current install 切到新版本，解析仍是开始时那一版', () => {
    it('current 推进到 2.0.0 后，钉在 1.0.0 的 pin 仍解析到 1.0.0', async () => {
      const sha1 = await landVersionCopy('1.0.0');
      setCurrentInstall('1.0.0');
      const pin = store.hubPinIdentity(UID, CONTENT_ID)!;

      // 使用进行中，Hub 发布 2.0.0 并完成替换。
      await landVersionCopy('2.0.0');
      setCurrentInstall('2.0.0');

      const resolved = store.resolveHubPinnedTree(UID, CONTENT_ID, pin.version, pin.manifestHash);

      expect(pin.version).toBe('1.0.0');
      expect(pin.manifestHash).toBe(sha1);
      expect(resolved).toBe(paths.userMarketplaceVersionTreeDir(UID, CONTENT_ID, '1.0.0'));
      // current 确实已经是 2.0.0 —— 两者并存正是不变量要的效果。
      expect(store.hubPinIdentity(UID, CONTENT_ID)?.version).toBe('2.0.0');
    });
  });

  describe('⭐ T045：执行期被停用，解析不受影响（解析路径不读 status）', () => {
    it('内容级停用后仍解析到 pinned 版本', async () => {
      await landVersionCopy('1.0.0');
      setCurrentInstall('1.0.0');
      const pin = store.hubPinIdentity(UID, CONTENT_ID)!;

      markDisabled();

      expect(store.resolveHubPinnedTree(UID, CONTENT_ID, pin.version, pin.manifestHash)).not.toBeNull();
    });

    it('解析路径的代码里不出现 status / disabled 判定', () => {
      const raw = fs.readFileSync(
        path.join(__dirname, '../../../../src/main/features/marketplace/version-store.ts'), 'utf8',
      );
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code).not.toContain('disabled');
      expect(code).not.toMatch(/\bstatus\b/);
    });
  });

  describe('⭐ T046：执行期网络不可达，解析不受影响（解析路径不联网）', () => {
    it('全局 fetch 被替换成会抛错的实现，解析照样成功', async () => {
      await landVersionCopy('1.0.0');
      setCurrentInstall('1.0.0');
      const pin = store.hubPinIdentity(UID, CONTENT_ID)!;

      const fetchMock = vi.fn(() => { throw new Error('network is down'); });
      vi.stubGlobal('fetch', fetchMock);

      expect(store.resolveHubPinnedTree(UID, CONTENT_ID, pin.version, pin.manifestHash)).not.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });

  describe('⭐ T047：副本被删除 → 解析失败，不回退到 current install', () => {
    it('删掉 pinned 版本副本后解析为 null，即便 current install 还在', async () => {
      await landVersionCopy('1.0.0');
      setCurrentInstall('1.0.0');
      const pin = store.hubPinIdentity(UID, CONTENT_ID)!;

      fs.rmSync(paths.userMarketplaceVersionDir(UID, CONTENT_ID, '1.0.0'), { recursive: true, force: true });

      expect(store.resolveHubPinnedTree(UID, CONTENT_ID, pin.version, pin.manifestHash)).toBeNull();
      // current install 仍在——解析**没有**把它当替代品。
      expect(fs.existsSync(paths.userMarketplaceSkillDir(UID, CONTENT_ID))).toBe(true);
    });

    it('身份摘要不符 → 解析为 null，不静默降级', async () => {
      await landVersionCopy('1.0.0');
      setCurrentInstall('1.0.0');

      expect(store.resolveHubPinnedTree(UID, CONTENT_ID, '1.0.0', 'f'.repeat(64))).toBeNull();
    });
  });

  describe('⭐ T048：重启后非终态 Task 的 pin 仍有效', () => {
    it('不做任何恢复动作，重新解析同一 pin 得到同一目录', async () => {
      await landVersionCopy('1.0.0');
      setCurrentInstall('1.0.0');
      const pin = store.hubPinIdentity(UID, CONTENT_ID)!;

      const before = store.resolveHubPinnedTree(UID, CONTENT_ID, pin.version, pin.manifestHash);
      // 「重启」= 无内存状态可丢，重新从磁盘解析。
      const after = store.resolveHubPinnedTree(UID, CONTENT_ID, pin.version, pin.manifestHash);

      expect(after).toBe(before);
      expect(after).not.toBeNull();
    });

    it('current 已前进 + 重启：pin 仍指向开始时那一版', async () => {
      await landVersionCopy('1.0.0');
      setCurrentInstall('1.0.0');
      const pin = store.hubPinIdentity(UID, CONTENT_ID)!;
      await landVersionCopy('2.0.0');
      setCurrentInstall('2.0.0');

      expect(store.resolveHubPinnedTree(UID, CONTENT_ID, pin.version, pin.manifestHash))
        .toBe(paths.userMarketplaceVersionTreeDir(UID, CONTENT_ID, '1.0.0'));
    });
  });

  describe('⭐ T043：pin 形状与分派位置不变', () => {
    it('pin 类型仍是四个字段，本轮未加字段', () => {
      const types = fs.readFileSync(
        path.join(__dirname, '../../../../src/main/features/cogseed_backend/types.ts'), 'utf8',
      );
      const block = types.slice(
        types.indexOf('export interface CogSeedTaskSkillVersionPin'),
      ).split('}')[0];
      expect(block).toContain('skillId: string;');
      expect(block).toContain('version: string;');
      expect(block).toContain('manifestHash: string;');
      expect(block).toContain('revisionId?: string;');
      // 没有来源字段——来源靠本地事实判定，不写进 pin。
      expect(block).not.toMatch(/source|origin|hub/i);
    });

    it('分派只发生在两处：pin 产生与 pin 解析', () => {
      const root = path.join(__dirname, '../../../../src/main');
      const hits: string[] = [];
      // 只看代码，注释先剥掉：判据是**调用点**在哪几处，别的模块在文档里说明
      // 「为什么我不会被分派判定命中」不构成第三处分派。
      const codeOf = (file: string): string => fs.readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name.endsWith('.ts') && /isHubManagedContent|resolveHubPinnedTree|hubPinIdentity/.test(codeOf(full))) {
            hits.push(path.relative(root, full).split(path.sep).join('/'));
          }
        }
      };
      walk(root);

      expect(hits.sort()).toEqual([
        'features/cogseed_backend/task-store.ts',
        'features/cogseed_runtime/kernel/tools/skill-tools.ts',
        'features/marketplace/version-store.ts',
      ]);
    });

    it('解析失败返回 E_RUNTIME_SKILL_VERSION_UNAVAILABLE，且不回退到 current install', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '../../../../src/main/features/cogseed_runtime/kernel/tools/skill-tools.ts'), 'utf8',
      );
      const branch = src.slice(src.indexOf('if (isHubManagedContent'), src.indexOf('} else if (pin.revisionId)'));
      expect(branch).toContain('E_RUNTIME_SKILL_VERSION_UNAVAILABLE');
      // 该分支内不得出现 current install 目录的取值。
      expect(branch).not.toContain('userMarketplaceSkillDir');
      expect(branch).not.toContain('userSkillsDir');
    });
  });

  describe('创作流路径不受影响（FR-030 / FR-074）', () => {
    it('非 Hub 管理的内容不命中分派分支', () => {
      expect(store.isHubManagedContent(UID, 'authoring-only-skill')).toBe(false);
      expect(store.hubPinIdentity(UID, 'authoring-only-skill')).toBeNull();
    });
  });
});
