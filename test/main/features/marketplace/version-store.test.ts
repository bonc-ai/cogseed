import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import AdmZip from 'adm-zip';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeBinaryHeavyPackage, makeCompliantSkillPackage } from '../../../fixtures/make-skill-packages';

// `paths.ts` 把容器根算成模块级常量（WS_ROOT），装载后不再变。因此工作区必须在
// 导入 paths 之前建好且**只建一次**；用例之间靠**各自独立的 uid** 隔离，而不是换目录。
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-version-store-'));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => workspace),
    isPackaged: false,
    getVersion: vi.fn(() => '1.1.2'),
  },
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
  UID = `u_version_store_${uidSeq}`;
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** 造一棵内容树（解包合成包得到），作为写入来源。 */
function treeFrom(zipBytes: Buffer, name: string): string {
  const dir = path.join(workspace, 'sources', UID, name);
  fs.mkdirSync(dir, { recursive: true });
  new AdmZip(zipBytes).extractAllTo(dir, true);
  return dir;
}

describe('marketplace/version-store', () => {
  describe('写入与解析（FR-023 / FR-024）', () => {
    it('写入后可按 {content_id, version} 解析出内容目录', async () => {
      const pkg = makeCompliantSkillPackage();
      const src = treeFrom(pkg.bytes, 'compliant');

      const dir = await store.writeVersionCopy(
        UID, { contentId: CONTENT_ID, version: '1.2.0', sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }, src,
      );

      expect(dir).toBe(paths.userMarketplaceVersionDir(UID, CONTENT_ID, '1.2.0'));
      const resolved = store.resolveVersionCopy(UID, CONTENT_ID, '1.2.0');
      expect(resolved).toBe(paths.userMarketplaceVersionTreeDir(UID, CONTENT_ID, '1.2.0'));
      expect(fs.existsSync(path.join(resolved!, 'fixture0skill0id', 'SKILL.md'))).toBe(true);
    });

    it('解析路径不联网：全程无 fetch 调用', async () => {
      const pkg = makeCompliantSkillPackage();
      await store.writeVersionCopy(
        UID, { contentId: CONTENT_ID, version: '1.2.0', sha256: pkg.sha256, sizeBytes: pkg.sizeBytes },
        treeFrom(pkg.bytes, 'nonet'),
      );
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      expect(store.resolveVersionCopy(UID, CONTENT_ID, '1.2.0')).not.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('更新写入新版本后，旧版本副本仍在（一次使用钉住的版本不受更新影响）', async () => {
      const a = makeCompliantSkillPackage(undefined, '1.0.0');
      const b = makeCompliantSkillPackage(undefined, '2.0.0');
      await store.writeVersionCopy(UID, { contentId: CONTENT_ID, version: '1.0.0', sha256: a.sha256, sizeBytes: a.sizeBytes }, treeFrom(a.bytes, 'v1'));
      await store.writeVersionCopy(UID, { contentId: CONTENT_ID, version: '2.0.0', sha256: b.sha256, sizeBytes: b.sizeBytes }, treeFrom(b.bytes, 'v2'));

      expect(store.resolveVersionCopy(UID, CONTENT_ID, '1.0.0')).not.toBeNull();
      expect(store.resolveVersionCopy(UID, CONTENT_ID, '2.0.0')).not.toBeNull();
      expect(store.listVersionCopies(UID, CONTENT_ID).map((r) => r.version).sort()).toEqual(['1.0.0', '2.0.0']);
    });

    it('不存在的副本解析为 null，而不是抛错', () => {
      expect(store.resolveVersionCopy(UID, CONTENT_ID, '9.9.9')).toBeNull();
      expect(store.resolveVersionCopy(UID, 'no-such-content', '1.0.0')).toBeNull();
    });
  });

  describe('写入原子性：中断不留半写状态（FR-023）', () => {
    it('复制过程中失败 → 不产生版本目录，只可能留下 .staging-*', async () => {
      const pkg = makeCompliantSkillPackage();
      const src = treeFrom(pkg.bytes, 'atomic');
      const cp = vi.spyOn(fs.promises, 'cp').mockRejectedValueOnce(new Error('disk full'));

      await expect(store.writeVersionCopy(
        UID, { contentId: CONTENT_ID, version: '1.2.0', sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }, src,
      )).rejects.toThrow('disk full');
      cp.mockRestore();

      expect(fs.existsSync(paths.userMarketplaceVersionDir(UID, CONTENT_ID, '1.2.0'))).toBe(false);
      expect(store.resolveVersionCopy(UID, CONTENT_ID, '1.2.0')).toBeNull();
      // 失败路径自己清掉了临时目录。
      const leftovers = fs.readdirSync(paths.userMarketplaceContentVersionsDir(UID, CONTENT_ID));
      expect(leftovers).toEqual([]);
    });

    it('残留的 .staging-* 不会被当成一个版本（解析与枚举都跳过）', () => {
      const staging = path.join(paths.userMarketplaceContentVersionsDir(UID, CONTENT_ID), '.staging-deadbeef');
      fs.mkdirSync(path.join(staging, 'tree'), { recursive: true });
      fs.writeFileSync(path.join(staging, 'tree', 'SKILL.md'), '# half written');

      expect(store.listVersionCopies(UID, CONTENT_ID)).toEqual([]);
      expect(store.resolveVersionCopy(UID, CONTENT_ID, '.staging-deadbeef')).toBeNull();
    });

    it('重复写入同一 {content_id, version} 是幂等的，不改写已存在的副本', async () => {
      const pkg = makeCompliantSkillPackage();
      await store.writeVersionCopy(UID, { contentId: CONTENT_ID, version: '1.2.0', sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }, treeFrom(pkg.bytes, 'idem1'));
      const first = store.readVersionCopyMeta(UID, CONTENT_ID, '1.2.0');

      await store.writeVersionCopy(UID, { contentId: CONTENT_ID, version: '1.2.0', sha256: 'f'.repeat(64), sizeBytes: 1 }, treeFrom(pkg.bytes, 'idem2'));

      expect(store.readVersionCopyMeta(UID, CONTENT_ID, '1.2.0')).toEqual(first);
    });
  });

  describe('完整性校验用 sha256，不用树哈希（FR-025）', () => {
    it('结构自洽的副本通过校验', async () => {
      const pkg = makeCompliantSkillPackage();
      await store.writeVersionCopy(UID, { contentId: CONTENT_ID, version: '1.2.0', sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }, treeFrom(pkg.bytes, 'ok'));
      expect(store.verifyVersionCopy(UID, CONTENT_ID, '1.2.0')).toBe(true);
    });

    it('meta 与目录名不符即拒绝（副本被移动或篡改）', async () => {
      const pkg = makeCompliantSkillPackage();
      await store.writeVersionCopy(UID, { contentId: CONTENT_ID, version: '1.2.0', sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }, treeFrom(pkg.bytes, 'tamper'));
      const metaFile = paths.userMarketplaceVersionMetaFile(UID, CONTENT_ID, '1.2.0');
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      fs.writeFileSync(metaFile, JSON.stringify({ ...meta, version: '9.9.9' }));

      expect(store.verifyVersionCopy(UID, CONTENT_ID, '1.2.0')).toBe(false);
    });

    it('sha256 缺失即拒绝——它是唯一的完整性依据', async () => {
      const pkg = makeCompliantSkillPackage();
      await expect(store.writeVersionCopy(
        UID, { contentId: CONTENT_ID, version: '1.2.0', sha256: '', sizeBytes: pkg.sizeBytes }, treeFrom(pkg.bytes, 'nosha'),
      )).rejects.toThrow(/sha256 is required/);
    });

    it('meta.json 损坏或内容树为空即拒绝，且不抛错', async () => {
      const pkg = makeCompliantSkillPackage();
      await store.writeVersionCopy(UID, { contentId: CONTENT_ID, version: '1.2.0', sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }, treeFrom(pkg.bytes, 'broken'));
      fs.writeFileSync(paths.userMarketplaceVersionMetaFile(UID, CONTENT_ID, '1.2.0'), '{ not json');

      expect(store.verifyVersionCopy(UID, CONTENT_ID, '1.2.0')).toBe(false);
    });
  });

  describe('⭐ FR-025 判据：含二进制且解包 9 MiB 的内容必须可写可解析', () => {
    it('9 MiB 含 NUL 的内容树写入与解析均成功（改用树哈希则此项必红）', async () => {
      const pkg = makeBinaryHeavyPackage();
      const src = treeFrom(pkg.bytes, 'binary-heavy');
      const blob = path.join(src, 'fixture0skill0id', 'assets', 'model.bin');
      // 先确认夹具确实落在冲突区间：> captureSkillTree 的单文件 2 MiB 上限，且含 NUL。
      expect(fs.statSync(blob).size).toBe(9 * 1024 * 1024);
      expect(fs.readFileSync(blob).includes(0)).toBe(true);

      await store.writeVersionCopy(
        UID, { contentId: CONTENT_ID, version: '1.2.0', sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }, src,
      );

      const resolved = store.resolveVersionCopy(UID, CONTENT_ID, '1.2.0');
      expect(resolved).not.toBeNull();
      expect(store.verifyVersionCopy(UID, CONTENT_ID, '1.2.0')).toBe(true);
      const copied = path.join(resolved!, 'fixture0skill0id', 'assets', 'model.bin');
      expect(fs.statSync(copied).size).toBe(9 * 1024 * 1024);
      expect(fs.readFileSync(copied).includes(0)).toBe(true);
    });
  });

  describe('meta.json 不含派生属性与引用计数（FR-027 / FR-028）', () => {
    it('字段集合恰好是六项，且不含 forked_from / 引用计数', async () => {
      const pkg = makeCompliantSkillPackage();
      await store.writeVersionCopy(UID, { contentId: CONTENT_ID, version: '1.2.0', sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }, treeFrom(pkg.bytes, 'meta'));
      const meta = JSON.parse(fs.readFileSync(paths.userMarketplaceVersionMetaFile(UID, CONTENT_ID, '1.2.0'), 'utf8'));

      expect(Object.keys(meta).sort()).toEqual(
        ['content_id', 'installed_at', 'sha256', 'size_bytes', 'source', 'version'],
      );
      expect(meta).not.toHaveProperty('forked_from');
      expect(meta).not.toHaveProperty('ref_count');
      expect(meta).not.toHaveProperty('refcount');
      expect(meta).not.toHaveProperty('references');
      expect(meta.source).toBe('hub');
      expect(typeof meta.installed_at).toBe('number');
    });
  });

  describe('与创作流版本存储零交互（FR-026）', () => {
    it('本模块不导入 skills/version-store 或 snapshot-service，也不碰其路径', () => {
      const raw = fs.readFileSync(
        path.join(__dirname, '../../../../src/main/features/marketplace/version-store.ts'), 'utf8',
      );
      // ⚠️ 按**代码**断言，不按全文。本模块的注释刻意解释了「为什么不能用树哈希」，
      // 里面就出现 captureSkillTree —— 谈论一个符号不等于用了它。
      // （同类误判见客户端基线提交 1e4e09c58：文档里的示例被绊线测试误当成标记。）
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
        .replace(/(^|[^:])\/\/.*$/gm, '$1');  // 行注释（避开 URL 里的 //）

      // 同名不同路径，极易误导入——这条断言就是为了让误导入立刻变红。
      expect(code).not.toMatch(/from '.*skills\/version-store'/);
      expect(code).not.toMatch(/from '.*snapshot-service'/);
      expect(code).not.toContain('captureSkillTree');
      // ⚠️ 这里禁的是**创作流的内容树哈希机制**，不是 `manifestHash` 这个字面量：
      // TaskRun pin 的形状是不变量，其 `manifestHash` 字段对 Hub pin 承载 artifact.sha256，
      // 本模块的来源分派助手必然提到它。故按机制断言，不按字面量。
      expect(code).not.toContain('snapshot-service');
      expect(code).not.toMatch(/\.manifestHash\b/);
      // 反向自检：注释确实提到了它，说明上面过滤的是注释而不是把整段清空了。
      expect(raw).toContain('captureSkillTree');
    });

    it('版本副本落在 local/marketplace/versions 下，与创作流的 cloud/skills/versions 互不重叠', () => {
      const ours = paths.userMarketplaceVersionsDir('u_x');
      expect(ours).toContain(path.join('local', 'marketplace', 'versions'));
      expect(ours).not.toContain(path.join('cloud', 'skills'));
    });
  });

  describe('路径安全', () => {
    it('content_id / version 含分隔符或 .. 时拒绝写入', async () => {
      const pkg = makeCompliantSkillPackage();
      const src = treeFrom(pkg.bytes, 'safety');
      for (const bad of ['../escape', 'a/b', 'a\\b', '..', '.']) {
        await expect(store.writeVersionCopy(
          UID, { contentId: bad, version: '1.0.0', sha256: pkg.sha256, sizeBytes: 1 }, src,
        )).rejects.toThrow(/safe single path segment|required/);
        await expect(store.writeVersionCopy(
          UID, { contentId: CONTENT_ID, version: bad, sha256: pkg.sha256, sizeBytes: 1 }, src,
        )).rejects.toThrow(/safe single path segment|required/);
      }
    });
  });
});
