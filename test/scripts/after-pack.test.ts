import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { verifyWindowsSherpaRuntime } = require('../../scripts/after-pack.js') as {
  verifyWindowsSherpaRuntime: (resourcesPath: string) => void;
};

const roots: string[] = [];
const files = [
  'sherpa-onnx.node',
  'onnxruntime.dll',
  'onnxruntime_providers_shared.dll',
  'sherpa-onnx-c-api.dll',
  'sherpa-onnx-cxx-api.dll',
];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('after-pack Windows speech runtime gate', () => {
  it('fails the Windows package when a Sherpa addon DLL is absent', () => {
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-after-pack-'));
    roots.push(resources);
    expect(() => verifyWindowsSherpaRuntime(resources)).toThrow('Windows speech runtime is missing');
  });

  it('accepts an unpacked Windows speech runtime with the addon and all DLLs', () => {
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-after-pack-'));
    roots.push(resources);
    const runtimeDir = path.join(resources, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-win-x64');
    fs.mkdirSync(runtimeDir, { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(runtimeDir, file), 'runtime');
    expect(() => verifyWindowsSherpaRuntime(resources)).not.toThrow();
  });
});
