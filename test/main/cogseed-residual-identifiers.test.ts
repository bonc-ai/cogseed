import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const readJson = (rel: string) => JSON.parse(read(rel));

describe('CogSeed residual identifiers', () => {
  let tmpDir: string;
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-residual-'));
    originalResourcesPath = process.resourcesPath;
  });

  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', { value: originalResourcesPath, configurable: true, writable: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses CogSeed as the official package and repository identity', () => {
    const pkg = readJson('package.json');
    expect(pkg.name).toBe('cogseed');
    expect(pkg.cogseedSourceRuntimeVariant).toBe('cogseed');
    expect(pkg.build.protocols[0].schemes).toEqual(['cogseed']);
    expect(read('package-lock.json')).toContain('"name": "cogseed"');

    const currentDocs = [
      'README.md',
      'README.zh-CN.md',
      'README-源码包说明.txt',
    ];
    for (const file of currentDocs) {
      const source = read(file);
      expect(source, file).toContain('CogSeed');
      const repositoryRefs = source.match(/\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git\b/g) ?? [];
      expect([...new Set(repositoryRefs)], file).toEqual(['bonc-ai/cogseed.git']);

      const shellDirectories = [...source.matchAll(/(?:^|\n)\s*(?:\$\s+)?cd\s+([A-Za-z0-9_.-]+)/g)]
        .map((match) => match[1])
        .filter((directory) => directory !== 'cogseed');
      expect(shellDirectories, file).toEqual([]);

      const privateIpv4 = /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g;
      expect(source.match(privateIpv4) ?? [], file).toEqual([]);
    }
    const readme = read('README.md');
    expect(readme).toContain('github.com/bonc-ai/cogseed.git');
    expect(readme).toContain('window.cogseed');
    expect(readme).toContain('npm test');
    expect(readme).toContain('.cogseed');
    expect(readme).toContain('cogseed://');

    const agents = read('AGENTS.md');
    expect(agents).toContain('window.cogseed.{invoke, stream}');
    const claude = read('CLAUDE.md');
    expect(claude).toContain('AGENTS.md');
  });

  it('uses a canonical CogSeed temp prefix for local imports', async () => {
    const fileImport = await import('../../src/main/util/file-import');
    const source = path.join(tmpDir, 'source.txt');
    const target = path.join(tmpDir, 'target.txt');
    fs.writeFileSync(source, 'hello');
    await fileImport.copyLocalFileAtomic(source, target);
    expect(fs.readdirSync(tmpDir).some((name) => name.startsWith('.cogseed-import-'))).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('hello');
  });

});

describe('CogSeed-only IPC registration', () => {
  it('registers each canonical transport exactly once', () => {
    const ipc = read('src/main/ipc/index.ts');
    const main = read('src/main/index.ts');
    expect(ipc.match(/ipcMain\.handle\('cogseed\.invoke'/g)).toHaveLength(1);
    expect(ipc.match(/ipcMain\.on\('cogseed\.streamStart'/g)).toHaveLength(1);
    expect(ipc.match(/ipcMain\.on\('cogseed\.streamCancel'/g)).toHaveLength(1);
    expect(main.match(/ipcMain\.on\('cogseed:bootI18n'/g)).toHaveLength(1);
  });
});
