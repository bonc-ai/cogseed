import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string; let previousRoot: string | undefined;
beforeEach(() => {
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'library-staging-'));
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('stageLibraryReferences', () => {
  it('copies cited library files into a fresh workspace and appends absolute paths', async () => {
    const { userContextsDir } = await import('../../../../src/main/paths');
    const { stageLibraryReferences } = await import('../../../../src/main/features/cogseed_backend/library-staging');
    const library = userContextsDir('u1');
    fs.mkdirSync(path.join(library, 'from-tasks', '中扬会议总结'), { recursive: true });
    fs.writeFileSync(path.join(library, 'from-tasks', '中扬会议总结', 'transcript_会议.txt'), 'raw');
    const workspace = path.join(root, 'ws', 'task-6');
    const task = '转写来源：资料库文件 `from-tasks/中扬会议总结/transcript_会议.txt`，另见 from-tasks/缺失/none.txt 与 `../secret/x.txt`。';
    const result = stageLibraryReferences('u1', task, workspace);
    const staged = path.join(workspace, 'transcript_会议.txt');
    expect(fs.readFileSync(staged, 'utf8')).toBe('raw');
    expect(result.staged).toEqual([{ reference: 'from-tasks/中扬会议总结/transcript_会议.txt', path: staged }]);
    expect(result.task).toContain(`→ ${staged}`);
    expect(fs.readdirSync(workspace)).toEqual(['transcript_会议.txt']);
  });

  it('only ensures the workspace exists when nothing is cited', async () => {
    const { stageLibraryReferences } = await import('../../../../src/main/features/cogseed_backend/library-staging');
    const workspace = path.join(root, 'ws', 'empty');
    expect(stageLibraryReferences('u1', 'summarize my meeting', workspace)).toEqual({ task: 'summarize my meeting', staged: [] });
    expect(fs.statSync(workspace).isDirectory()).toBe(true);
  });
});
