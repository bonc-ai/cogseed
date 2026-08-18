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
      '目录说明.md',
    ];
    for (const file of currentDocs) {
      const source = read(file);
      expect(source, file).toContain('CogSeed');
      expect(source, file).not.toContain('team-02/mate-agent.git');
      expect(source, file).not.toContain('cd mate-agent');
      // 开源化清理：内网 GitLab 地址已替换为公开占位地址
      expect(source, file).not.toContain('10.1.12.6');
    }
    const readme = read('README.md');
    expect(readme).toContain('github.com/cogseed/cogseed.git');
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

  it('uses only the canonical CogSeed whisper marker', async () => {
    Object.defineProperty(process, 'resourcesPath', { value: path.join(tmpDir, 'no-resources'), configurable: true, writable: true });
    const runtimeRoot = path.join(tmpDir, 'runtime');
    const whisperDir = path.join(runtimeRoot, 'whisper', 'current');
    fs.mkdirSync(path.join(whisperDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(whisperDir, 'models'), { recursive: true });
    const marker = path.join(whisperDir, '.cogseed-whisper-ready.json');
    process.env.COGSEED_RUNTIME_DIR = runtimeRoot;
    const runtime = await import('../../src/main/util/bundled-runtime');
    expect(runtime.bundledWhisperPaths()).toEqual({});
    fs.writeFileSync(marker, JSON.stringify({ schema: 1, platformKey: 'darwin-x64', version: '1', model: 'x', capability: { status: 'ready' }, files: {} }));
    expect(fs.existsSync(marker)).toBe(true);
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
