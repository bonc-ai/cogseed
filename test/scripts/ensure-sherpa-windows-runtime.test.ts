import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const runtime = require('../../scripts/ensure-sherpa-windows-runtime.cjs') as {
  PACKAGE_NAME: string;
  REQUIRED_FILES: string[];
  hasWindowsRuntime: (root: string, version: string) => boolean;
  missingRuntimeFiles: (root: string) => string[];
  npmCommand: (platform?: NodeJS.Platform) => string;
  packageDir: (root: string) => string;
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fakePeX64() {
  const data = Buffer.alloc(128);
  data.write('MZ', 0, 'ascii');
  data.writeUInt32LE(64, 0x3c);
  data.write('PE\0\0', 64, 'ascii');
  data.writeUInt16LE(0x8664, 68);
  return data;
}

describe('ensure-sherpa-windows-runtime', () => {
  it('uses npm.cmd only on a Windows host', () => {
    expect(runtime.npmCommand('win32')).toBe('npm.cmd');
    expect(runtime.npmCommand('darwin')).toBe('npm');
  });

  it('requires the native addon and every DLL needed by the Windows speech engine', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-sherpa-win-test-'));
    roots.push(root);
    const packageDir = runtime.packageDir(root);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '1.13.6' }));
    fs.writeFileSync(path.join(packageDir, 'sherpa-onnx.node'), fakePeX64());

    expect(runtime.missingRuntimeFiles(root)).toEqual(
      runtime.REQUIRED_FILES.filter((file) => file !== 'sherpa-onnx.node'),
    );
    expect(runtime.hasWindowsRuntime(root, '1.13.6')).toBe(false);

    for (const file of runtime.REQUIRED_FILES.filter((file) => file !== 'sherpa-onnx.node')) {
      fs.writeFileSync(path.join(packageDir, file), 'dll');
    }

    expect(runtime.missingRuntimeFiles(root)).toEqual([]);
    expect(runtime.hasWindowsRuntime(root, '1.13.6')).toBe(true);
  });

  it('pins the platform package name used by sherpa-onnx-node on Windows x64', () => {
    expect(runtime.PACKAGE_NAME).toBe('sherpa-onnx-win-x64');
  });

  it('keeps the Windows speech addon explicitly unpacked for native DLL loading', () => {
    const packageJson = require('../../package.json') as { build?: { asarUnpack?: string[] } };
    expect(packageJson.build?.asarUnpack).toEqual(expect.arrayContaining([
      'node_modules/sherpa-onnx-node/**/*',
      'node_modules/sherpa-onnx-win-x64/**/*',
    ]));
  });
});
