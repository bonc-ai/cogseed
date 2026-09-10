import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const configuredAfterPack = require('../../../scripts/after-pack.js').default as (context: any) => Promise<void>;
const entrypointGate = require('../../../bin/packaged-entrypoint-gate.cjs') as {
  PACKAGED_BIN_ENTRYPOINTS: readonly string[];
  PACKAGED_BIN_HELPERS: readonly string[];
  PACKAGED_JS_LOADER_FILES: readonly { packageName: string; entry: string }[];
};
const resourceGate = require('../../../bin/packaged-resource-gate.cjs') as {
  SHERPA_ONNX_CONTRACT: { files: readonly { name: string }[] };
  SHERPA_ONNX_WINDOWS_NATIVE_FILES: readonly string[];
};
const packageJson = require('../../../package.json') as { build: { asarUnpack?: string[] } };

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-stt-package-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function linkOrCopy(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.linkSync(from, to); }
  catch { fs.copyFileSync(from, to); }
}

function writeEntrypointPayload(): void {
  const pcRoot = path.join(tempRoot, 'resources', 'app.asar.unpacked');
  const binRoot = path.join(pcRoot, 'bin');
  fs.mkdirSync(binRoot, { recursive: true });
  for (const name of [...entrypointGate.PACKAGED_BIN_ENTRYPOINTS, ...entrypointGate.PACKAGED_BIN_HELPERS]) {
    fs.copyFileSync(path.join(process.cwd(), 'bin', name), path.join(binRoot, name));
  }
  const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8'));
  for (const spec of entrypointGate.PACKAGED_JS_LOADER_FILES) {
    const packageDir = path.join(pcRoot, 'node_modules', ...spec.packageName.split('/'));
    const entry = path.join(packageDir, ...spec.entry.split('/'));
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      name: spec.packageName,
      version: lock.packages[`node_modules/${spec.packageName}`].version,
    }));
    fs.writeFileSync(entry, 'module.exports = {};\n');
  }
}

function writeSherpaModel(): string {
  const modelName = 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23';
  const source = path.join(process.cwd(), 'resources', 'sherpa-onnx', modelName);
  const destination = path.join(tempRoot, 'resources', 'sherpa-onnx', modelName);
  for (const { name } of resourceGate.SHERPA_ONNX_CONTRACT.files) {
    const from = path.join(source, name);
    fs.mkdirSync(destination, { recursive: true });
    fs.copyFileSync(from, path.join(destination, name));
  }
  return destination;
}

function sherpaNativeDestination(): string {
  return path.join(
    tempRoot,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'sherpa-onnx-win-x64',
  );
}

function writePe(file: string, machine = 0x8664): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = Buffer.alloc(0x80);
  body.write('MZ', 0, 'ascii');
  body.writeUInt32LE(0x40, 0x3c);
  body.write('PE\0\0', 0x40, 'binary');
  body.writeUInt16LE(machine, 0x44);
  fs.writeFileSync(file, body);
}

function writeSyntheticSherpaNative(machine = 0x8664): string {
  const destination = sherpaNativeDestination();
  for (const name of resourceGate.SHERPA_ONNX_WINDOWS_NATIVE_FILES) {
    writePe(path.join(destination, name), machine);
  }
  return destination;
}

function copyInstalledSherpaNative(): string {
  const source = path.join(process.cwd(), 'node_modules', 'sherpa-onnx-win-x64');
  const destination = sherpaNativeDestination();
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name);
    if (fs.statSync(from).isFile()) linkOrCopy(from, path.join(destination, name));
  }
  return destination;
}

function windowsContext(): any {
  return {
    electronPlatformName: 'win32',
    arch: 1,
    appOutDir: tempRoot,
    packager: { appInfo: { productName: 'CogSeed' } },
  };
}

describe('Windows packaged STT gate', () => {
  it('explicitly unpacks the sherpa Windows native package', () => {
    expect(packageJson.build.asarUnpack).toContain('node_modules/sherpa-onnx-win-x64/**/*');
  });

  it.runIf(process.platform === 'win32')('accepts the installed Windows Sherpa native package', async () => {
    writeEntrypointPayload();
    writeSherpaModel();
    copyInstalledSherpaNative();

    await expect(configuredAfterPack(windowsContext())).resolves.toBeUndefined();
  });

  it('blocks packaging when a required Sherpa DLL is absent', async () => {
    writeEntrypointPayload();
    writeSherpaModel();
    const nativeRoot = writeSyntheticSherpaNative();
    fs.rmSync(path.join(nativeRoot, 'sherpa-onnx-cxx-api.dll'));

    await expect(configuredAfterPack(windowsContext())).rejects.toThrow(/sherpa-onnx-cxx-api\.dll/);
  });

  it('blocks packaging when the shipped speech model hash is wrong', async () => {
    writeEntrypointPayload();
    const modelRoot = writeSherpaModel();
    writeSyntheticSherpaNative();
    fs.writeFileSync(path.join(modelRoot, 'tokens.txt'), 'corrupt');

    await expect(configuredAfterPack(windowsContext())).rejects.toThrow(/tokens\.txt/);
  });

  it('blocks packaging when a Sherpa native binary is not Windows x64', async () => {
    writeEntrypointPayload();
    writeSherpaModel();
    writeSyntheticSherpaNative(0xaa64);

    await expect(configuredAfterPack(windowsContext())).rejects.toThrow(/arch mismatch: expected x64/);
  });
});
