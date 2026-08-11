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
    expect(read('package-lock.json')).toContain('"name": "cogseed"');

    const currentDocs = [
      'README.md',
      'README.zh-CN.md',
      'README-源码包说明.txt',
      '目录说明.md',
      'docs/README.md',
    ];
    for (const file of currentDocs) {
      const source = read(file);
      expect(source, file).not.toContain('team-02/mate-agent.git');
      expect(source, file).not.toContain('cd mate-agent');
    }
    expect(read('README.md')).toContain('team-02/cogseed.git');
  });

  it('uses a canonical cogseed temp prefix for local imports', async () => {
    const fileImport = await import('../../src/main/util/file-import');
    const source = path.join(tmpDir, 'source.txt');
    const target = path.join(tmpDir, 'target.txt');
    fs.writeFileSync(source, 'hello');
    await fileImport.copyLocalFileAtomic(source, target);
    expect(fs.readdirSync(tmpDir).some((name) => name.startsWith('.cogseed-import-'))).toBe(false);
    expect(fs.readdirSync(tmpDir).some((name) => name.startsWith('.orkas-import-'))).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('hello');
  });

  it('accepts legacy .orkas whisper markers but prefers canonical CogSeed markers', async () => {
    Object.defineProperty(process, 'resourcesPath', { value: path.join(tmpDir, 'no-resources'), configurable: true, writable: true });
    const runtimeRoot = path.join(tmpDir, 'runtime');
    const whisperDir = path.join(runtimeRoot, 'whisper', 'current');
    fs.mkdirSync(path.join(whisperDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(whisperDir, 'models'), { recursive: true });
    const canonical = path.join(whisperDir, '.cogseed-whisper-ready.json');
    const legacy = path.join(whisperDir, '.orkas-whisper-ready.json');
    fs.writeFileSync(legacy, JSON.stringify({ schema: 1, platformKey: 'darwin-x64', version: '1', model: 'x', capability: { status: 'ready' }, files: {} }));
    process.env.ORKAS_RUNTIME_DIR = runtimeRoot;
    const runtime = await import('../../src/main/util/bundled-runtime');
    expect(runtime.bundledWhisperPaths()).toEqual({});
    expect(fs.existsSync(legacy)).toBe(true);
    fs.writeFileSync(canonical, JSON.stringify({ schema: 1, platformKey: 'darwin-x64', version: '1', model: 'x', capability: { status: 'ready' }, files: {} }));
    expect(fs.existsSync(canonical)).toBe(true);
  });
});
