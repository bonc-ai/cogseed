import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
const UID = 'discover-user';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-discover-'));
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function loadDiscovery(manifest: unknown) {
  const bundled = path.join(tmpDir, 'catalog');
  const cloud = path.join(tmpDir, 'cloud');
  const contextsRoot = path.join(tmpDir, 'contexts');
  fs.mkdirSync(bundled, { recursive: true });
  fs.writeFileSync(path.join(bundled, 'manifest.json'), JSON.stringify(manifest));

  vi.doMock('../../../src/main/paths', () => ({
    packagedDiscoverCatalogDir: () => bundled,
    userCloudRoot: () => cloud,
    userContextsDir: () => contextsRoot,
  }));
  vi.doMock('../../../src/main/features/contexts', () => ({
    writeContextFileForUser: (_uid: string, rel: string, content: string) => {
      const target = path.join(contextsRoot, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      return { ok: true, path: rel };
    },
    updateContextFileForUser: (_uid: string, rel: string, content: string) => {
      fs.writeFileSync(path.join(contextsRoot, rel), content, 'utf8');
      return { ok: true, path: rel };
    },
  }));
  vi.doMock('../../../src/main/features/spaces', () => ({ listSpaces: vi.fn(async () => []) }));
  vi.doMock('../../../src/main/features/share/feishu-share', () => ({ listFeishuShares: vi.fn(async () => []) }));
  vi.doMock('../../../src/main/features/share/cogseed-publish', () => ({ listCogseedShares: vi.fn(async () => []) }));
  vi.doMock('../../../src/main/features/personal_context/manager', () => ({ getStatus: vi.fn(async () => ({ kind: 'disconnected' })) }));
  vi.doMock('../../../src/main/features/personal_context/registry', () => ({
    PersonalContextRegistry: class { async list() { return []; } },
  }));

  const discovery = await import('../../../src/main/features/kb_discovery');
  return { discovery, bundled, contextsRoot };
}

describe('kb_discovery official packages', () => {
  it('drops unsafe and incomplete manifest entries', async () => {
    const { discovery } = await loadDiscovery({
      version: 1,
      packages: [
        { id: 'valid-package', version: '1.0.0', title: 'Valid', description: 'Valid package', publisher: 'CogSeed', category: '团队', tags: ['团队'], updatedAt: '2026-09-02T00:00:00Z', files: ['valid/readme.md'] },
        { id: '../escape', version: '1.0.0', title: 'Unsafe', description: 'Unsafe', publisher: 'CogSeed', category: '团队', tags: [], updatedAt: '2026-09-02T00:00:00Z', files: ['valid/readme.md'] },
        { id: 'no-files', version: '1.0.0', title: 'Empty', description: 'Empty', publisher: 'CogSeed', category: '团队', tags: [], updatedAt: '2026-09-02T00:00:00Z', files: [] },
      ],
    });
    expect(discovery.readOfficialManifest().packages.map((item) => item.id)).toEqual(['valid-package']);
  });

  it('imports official markdown into the user context tree and is idempotent', async () => {
    const manifest = {
      version: 1,
      packages: [{ id: 'valid-package', version: '1.0.0', title: 'Valid', description: 'Valid package', publisher: 'CogSeed', category: '团队', tags: ['团队'], updatedAt: '2026-09-02T00:00:00Z', files: ['valid/guide.md'] }],
    };
    const { discovery, bundled, contextsRoot } = await loadDiscovery(manifest);
    fs.mkdirSync(path.join(bundled, 'valid'), { recursive: true });
    fs.writeFileSync(path.join(bundled, 'valid', 'guide.md'), '# Official guide\n', 'utf8');

    await expect(discovery.importOfficialPackage(UID, 'valid-package')).resolves.toMatchObject({ ok: true, imported: 1, updated: 0, skipped: 0 });
    expect(fs.readFileSync(path.join(contextsRoot, 'official', 'valid-package', 'guide.md'), 'utf8')).toContain('Official guide');
    await expect(discovery.importOfficialPackage(UID, 'valid-package')).resolves.toMatchObject({ ok: true, imported: 0, updated: 0, skipped: 1 });
  });

  it('marks a newer official package as updatable and replaces its existing files', async () => {
    const manifest = {
      version: 1,
      packages: [{ id: 'valid-package', version: '1.0.0', title: 'Valid', description: 'Valid package', publisher: 'CogSeed', category: '团队', tags: ['团队'], updatedAt: '2026-09-02T00:00:00Z', files: ['valid/guide.md'] }],
    };
    const { discovery, bundled, contextsRoot } = await loadDiscovery(manifest);
    fs.mkdirSync(path.join(bundled, 'valid'), { recursive: true });
    fs.writeFileSync(path.join(bundled, 'valid', 'guide.md'), '# Version one\n', 'utf8');
    await discovery.importOfficialPackage(UID, 'valid-package');

    manifest.packages[0].version = '2.0.0';
    manifest.packages[0].updatedAt = '2026-09-05T00:00:00Z';
    fs.writeFileSync(path.join(bundled, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(bundled, 'valid', 'guide.md'), '# Version two\n', 'utf8');

    const view = await discovery.listDiscoverView(UID);
    expect(view.featured[0]).toMatchObject({ imported: true, updateAvailable: true, version: '2.0.0' });
    await expect(discovery.importOfficialPackage(UID, 'valid-package')).resolves.toMatchObject({ ok: true, imported: 0, updated: 1, skipped: 0 });
    expect(fs.readFileSync(path.join(contextsRoot, 'official', 'valid-package', 'guide.md'), 'utf8')).toBe('# Version two\n');
    const updatedView = await discovery.listDiscoverView(UID);
    expect(updatedView.featured[0]).toMatchObject({ imported: true, updateAvailable: false, version: '2.0.0' });
  });
});
