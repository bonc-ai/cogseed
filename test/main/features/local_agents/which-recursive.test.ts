import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  findBinRecursively,
  recursiveSearchRoots,
} from '../../../../src/main/features/local_agents/which';

describe('which: recursive install-root discovery', () => {
  it('covers Codex and WorkBuddy app roots on win32', () => {
    if (process.platform !== 'win32') return;
    const roots = recursiveSearchRoots(
      'codex',
      {
        LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
        APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
      },
      'C:\\Users\\tester',
    );
    expect(roots).toContain('c:\\users\\tester\\appdata\\local\\openai');
    expect(roots).toContain('c:\\users\\tester\\appdata\\local\\programs\\openai');

    const wbRoots = recursiveSearchRoots(
      'codebuddy',
      {
        LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
        APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
      },
      'C:\\Users\\tester',
    );
    expect(wbRoots).toContain('c:\\users\\tester\\appdata\\local\\workbuddy');
    expect(wbRoots).toContain('c:\\users\\tester\\appdata\\local\\programs\\workbuddy');
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
});
