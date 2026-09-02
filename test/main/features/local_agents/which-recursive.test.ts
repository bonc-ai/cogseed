import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  findBinRecursively,
  recursiveSearchRoots,
} from '../../../../src/main/features/local_agents/which';
import { invalidateCache } from '../../../../src/main/features/local_agents/registry';

describe('which: recursive install-root discovery', () => {
  it('scans generic app roots and honors COGSEED_AGENT_SEARCH_ROOTS', () => {
    if (process.platform !== 'win32') return;
    const env = {
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
      COGSEED_AGENT_SEARCH_ROOTS: 'D:\\cli\\agents;E:\\more\\cli',
    };
    const roots = recursiveSearchRoots('codex', env, 'C:\\Users\\tester');
    expect(roots).toContain('c:\\users\\tester\\appdata\\local');
    expect(roots).toContain('c:\\users\\tester\\appdata\\local\\programs');
    expect(roots).toContain('c:\\users\\tester\\appdata\\roaming');
    expect(roots).toContain('c:\\users\\tester\\appdata\\roaming\\npm');
    expect(roots).toContain('d:\\cli\\agents');
    expect(roots).toContain('e:\\more\\cli');
  });

  it('finds a codex binary inside a Windows-app hash directory', async () => {
    if (process.platform !== 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'which-recursive-'));
    const hashDir = path.join(root, 'OpenAI', 'Codex', 'bin', 'abc123');
    fs.mkdirSync(hashDir, { recursive: true });
    const bin = path.join(hashDir, 'codex.exe');
    fs.writeFileSync(bin, 'fake');
    try {
      const found = await findBinRecursively('codex', {
        env: { LOCALAPPDATA: root, APPDATA: root, PATH: '' },
        home: root,
      });
      expect(found?.toLowerCase()).toBe(bin.toLowerCase());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores recursive Windows matches whose extension is not in PATHEXT', async () => {
    if (process.platform !== 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'which-recursive-noise-'));
    const nested = path.join(root, 'agent', 'bin');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'noise-agent.json'), '{}');
    try {
      await expect(findBinRecursively('noise-agent', {
        env: {
          LOCALAPPDATA: root,
          APPDATA: root,
          PATH: '',
          PATHEXT: '.EXE;.CMD',
        },
        home: root,
      })).resolves.toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      invalidateCache();
    }
  });

  it('clears recursive results when the registry cache is invalidated', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'which-recursive-cache-'));
    const nested = path.join(root, 'agent', 'bin');
    fs.mkdirSync(nested, { recursive: true });
    const base = path.join(nested, process.platform === 'win32' ? 'cache-agent.exe' : 'cache-agent');
    fs.writeFileSync(base, process.platform === 'win32' ? 'fake' : '#!/bin/sh\n');
    if (process.platform !== 'win32') fs.chmodSync(base, 0o755);
    const env = {
      PATH: '',
      LOCALAPPDATA: root,
      APPDATA: root,
      COGSEED_AGENT_SEARCH_ROOTS: root,
    };
    try {
      await expect(findBinRecursively('cache-agent', { env, home: root })).resolves.toBeTruthy();
      fs.rmSync(base, { force: true });
      invalidateCache();
      await expect(findBinRecursively('cache-agent', { env, home: root })).resolves.toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      invalidateCache();
    }
  });
});
