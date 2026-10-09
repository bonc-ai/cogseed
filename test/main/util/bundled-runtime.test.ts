import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-bundled-runtime-'));
  process.env.COGSEED_RUNTIME_DIR = path.join(tmpDir, 'runtime');
});

afterEach(() => {
  delete process.env.COGSEED_RUNTIME_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('bundled-runtime', () => {
  it('exposes Python, uv, and Node directories for sandbox PATH precedence', async () => {
    const key = `${process.platform}-${process.arch}`;
    const root = process.env.COGSEED_RUNTIME_DIR!;
    const pythonRel = process.platform === 'win32' ? path.join('python', 'python.exe') : path.join('python', 'bin', 'python3');
    const python = path.join(root, 'python', key, pythonRel);
    const uv = path.join(root, 'uv', key, process.platform === 'win32' ? 'uv.exe' : 'uv');
    const nodeRel = process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node');
    const node = path.join(root, 'node', key, nodeRel);
    for (const file of [python, uv, node]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
    }
    const runtime = await import('../../../src/main/util/bundled-runtime');
    expect(runtime.bundledRuntimeEnv()).toMatchObject({
      COGSEED_PYTHON: python,
      COGSEED_UV: uv,
      COGSEED_BUNDLED_NODE: node,
    });
    expect(runtime.bundledRuntimePathEntries()).toEqual(expect.arrayContaining([
      path.dirname(python), path.dirname(uv), path.dirname(node),
    ]));
  });

});
