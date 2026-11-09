import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { userCloudRoot, userCognitionDir } from '../../../../../src/main/paths';
import {
  assertRuntimePathAllowed,
  containsProtectedPathHint,
  isRuntimeProtectedPath,
  runtimeProtectedRoots,
} from '../../../../../src/main/features/cogseed_runtime/kernel/tools/protected-paths';
import { runRuntimeFileTool, type RuntimeToolCallContext } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/file-tools';
import { runRuntimeBashTool } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/shell-tools';
import { buildSeatbeltProfile, wrapProcessForOsSandbox } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/os-sandbox';

let tmp: string;
let previousRoot: string | undefined;
const userId = 'protected-path-user';

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-protected-path-')));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function context(overrides: Partial<RuntimeToolCallContext> = {}): RuntimeToolCallContext {
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  return {
    userId,
    runtimeSessionId: 'mruntime-protected-path',
    allowedRoots: [workspace],
    writableRoots: [workspace],
    workspaceRoot: workspace,
    pcDir: process.cwd(),
    beforeAction: async () => undefined,
    toolPolicy: {
      fileRead: 'all',
      fileWrite: 'all',
      shell: 'allow_with_confirmation',
      skillRun: 'none',
      network: 'none',
      connectors: 'enabled',
    },
    ...overrides,
  };
}

describe('runtime protected paths', () => {
  it('recognizes cognition and recall paths while leaving workspace files alone', () => {
    const cognitionFile = path.join(userCognitionDir(userId), 'cognition-store.json');
    fs.mkdirSync(path.dirname(cognitionFile), { recursive: true });
    fs.writeFileSync(cognitionFile, '{"secret":true}');
    expect(isRuntimeProtectedPath(userId, cognitionFile)).toBe(true);
    expect(isRuntimeProtectedPath(userId, path.join(userCloudRoot(userId), 'recall', 'records', 'x.json'))).toBe(true);
    expect(isRuntimeProtectedPath(userId, path.join(tmp, 'workspace', 'notes.txt'))).toBe(false);
    expect(() => assertRuntimePathAllowed(userId, cognitionFile)).toThrow(/private cognition/);
    expect(runtimeProtectedRoots(userId).length).toBeGreaterThan(0);
  });

  it('blocks direct file reads and writes to protected paths under full access', async () => {
    const cognitionFile = path.join(userCognitionDir(userId), 'cognition-store.json');
    fs.mkdirSync(path.dirname(cognitionFile), { recursive: true });
    fs.writeFileSync(cognitionFile, '{"secret":true}');
    const ctx = context();
    const opts = { userId, runtimeSessionId: ctx.runtimeSessionId };
    const read = await runRuntimeFileTool('read_file', { path: cognitionFile }, ctx, opts);
    expect(read.isError).toBe(true);
    expect(read.content).toContain('E_RUNTIME_COGNITION_PATH');
    const write = await runRuntimeFileTool('write_file', { path: cognitionFile, content: 'changed' }, ctx, opts);
    expect(write.isError).toBe(true);
    expect(write.content).toContain('E_RUNTIME_COGNITION_PATH');
    expect(fs.readFileSync(cognitionFile, 'utf8')).toBe('{"secret":true}');
    const normal = path.join(ctx.workspaceRoot!, 'normal.txt');
    const wrote = await runRuntimeFileTool('write_file', { path: normal, content: 'ok' }, ctx, opts);
    expect(wrote.isError).toBeFalsy();
    expect(fs.readFileSync(normal, 'utf8')).toBe('ok');
  });

  it.runIf(process.platform === 'darwin')('denies protected shell reads and writes even in full access', async () => {
    const protectedFile = path.join(userCognitionDir(userId), 'secret.txt');
    fs.mkdirSync(path.dirname(protectedFile), { recursive: true });
    fs.writeFileSync(protectedFile, 'SECRET');
    const ctx = context();
    const opts = { userId, runtimeSessionId: ctx.runtimeSessionId };
    const read = await runRuntimeBashTool({ command: `cat ${protectedFile}` }, ctx, opts);
    expect(read.isError).toBe(true);
    const write = await runRuntimeBashTool({ command: `printf changed > ${protectedFile}` }, ctx, opts);
    expect(write.isError).toBe(true);
    expect(fs.readFileSync(protectedFile, 'utf8')).toBe('SECRET');
  });

  it('filters protected files out of directory searches', async () => {
    const cloud = userCloudRoot(userId);
    const secret = path.join(userCognitionDir(userId), 'secret.txt');
    const normal = path.join(cloud, 'notes', 'normal.txt');
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.mkdirSync(path.dirname(normal), { recursive: true });
    fs.writeFileSync(secret, 'PROTECTED_MARKER');
    fs.writeFileSync(normal, 'PROTECTED_MARKER');
    const ctx = context({
      allowedRoots: [cloud],
      writableRoots: [],
      toolPolicy: {
        fileRead: 'explicit_roots', fileWrite: 'none', shell: 'none', skillRun: 'none', network: 'none', connectors: 'enabled',
      },
    });
    const result = await runRuntimeFileTool('grep_files', { pattern: 'PROTECTED_MARKER', output_mode: 'files' }, ctx, {
      userId, runtimeSessionId: ctx.runtimeSessionId,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain(normal);
    expect(result.content).not.toContain(secret);
  });

  it('builds a seatbelt profile that denies both reads and writes of protected paths', () => {
    const protectedPath = path.join(userCognitionDir(userId));
    fs.mkdirSync(protectedPath, { recursive: true });
    const canonical = fs.realpathSync(protectedPath);
    // SBPL 字符串要转义反斜杠（os-sandbox 的 quote 就是这么做的）；Windows 路径
    // 全由反斜杠组成，直接内插会与生成结果对不上。
    const sbplQuote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const quoted = sbplQuote(canonical);
    const normal = buildSeatbeltProfile({ workspaceRoot: tmp, protectedPaths: [protectedPath] });
    expect(normal).toContain('(allow default)');
    expect(normal).toContain(`(deny file-read* (subpath ${quoted}))`);
    expect(normal).toContain(`(deny file-write* (subpath ${quoted}))`);
    const full = buildSeatbeltProfile({ allowAllWrites: true, protectedPaths: [protectedPath] });
    expect(full).toContain(`(deny file-read* (subpath ${quoted}))`);
    expect(full).toContain(`(deny file-write* (subpath ${quoted}))`);
    expect(wrapProcessForOsSandbox(process.execPath, ['-e', '0'], {
      allowAllWrites: true, protectedPaths: [protectedPath],
    }, { platform: 'darwin' })).toMatchObject({ file: '/usr/bin/sandbox-exec' });
  });

  it('keeps a textual fallback for platforms without an OS sandbox', () => {
    expect(containsProtectedPathHint(userId, `cat ${path.join(userCognitionDir(userId), 'cognition-store.json')}`)).toBe(true);
    expect(containsProtectedPathHint(userId, 'cat cognition-store.json')).toBe(true);
    expect(containsProtectedPathHint(userId, 'cat notes.txt')).toBe(false);
  });
});
