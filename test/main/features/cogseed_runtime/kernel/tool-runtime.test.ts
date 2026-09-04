import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as paths from '../../../../../src/main/paths';
import { DEFAULT_RUNTIME_TOOL_POLICY } from '../../../../../src/main/features/cogseed_runtime/kernel/config';
import type { RuntimeToolPolicy } from '../../../../../src/main/features/cogseed_runtime/kernel/types';
import { getRuntimeToolCatalog } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/catalog';
import { createRuntimeToolRunner } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/runner';
import { captureSkillTree } from '../../../../../src/main/features/skills/snapshot-service';
import { appendFullSkillVersion } from '../../../../../src/main/features/skills/version-store';
import { ensureSkillRuntimeSnapshot } from '../../../../../src/main/features/skills/runtime-snapshot-service';

const UID = 'runtime-tool-user';
const SESSION = 'mruntime-tools';
let tmpRoot = '';

function makeRoot(): string {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-runtime-tools-'));
  return tmpRoot;
}

function runner(
  root: string,
  maxInlineToolResultTokens?: number,
  policy: RuntimeToolPolicy = DEFAULT_RUNTIME_TOOL_POLICY,
  allowedSkillIds: string[] = [],
  skillVersionPins: Array<{ skillId: string; version: string; manifestHash: string; revisionId?: string }> = [],
) {
  return createRuntimeToolRunner({
    userId: UID,
    runtimeSessionId: SESSION,
    allowedRoots: [root],
    writableRoots: [root],
    toolPolicy: policy,
    allowedSkillIds,
    skillVersionPins,
    hostToolClient: {
      async call(call: { name: string }) {
        if (call.name === 'action_approval_request') {
          return { content: JSON.stringify({ approved: true, request_id: 'approval-test-once', code: 'E_ACTION_APPROVAL_DENIED' }) };
        }
        return { content: JSON.stringify({ ok: true }) };
      },
    } as never,
    ...(maxInlineToolResultTokens ? { maxInlineToolResultTokens } : {}),
  });
}

const WRITE_POLICY: RuntimeToolPolicy = {
  ...DEFAULT_RUNTIME_TOOL_POLICY,
  fileWrite: 'explicit_writable_roots',
};

const SHELL_POLICY: RuntimeToolPolicy = {
  ...DEFAULT_RUNTIME_TOOL_POLICY,
  shell: 'low_risk_only',
};

const SKILL_POLICY: RuntimeToolPolicy = {
  ...DEFAULT_RUNTIME_TOOL_POLICY,
  skillRun: 'allowlisted_skills',
};

afterEach(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(paths.userRoot(UID), { recursive: true, force: true });
});

describe('CogSeed Runtime tool runtime MVP', () => {
  it('has a fixed file catalog without group/chat tools', () => {
    expect(getRuntimeToolCatalog().map((tool) => tool.name)).toEqual([
      'stat_file',
      'read_file',
      'search_files',
      'grep_files',
      'write_file',
      'edit_file',
      'bash',
      'run_skill',
      'list_connector_tools',
      'call_connector_tool',
      'search_mate_kb',
      'read_mate_kb',
      'office_read', 'office_create', 'office_edit', 'office_render',
      'browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot',
      'cogseed_delegate', 'cogseed_tasks', 'cogseed_cancel', 'cogseed_retry_step', 'cogseed_skip_step', 'cogseed_resume_workflow', 'cogseed_workflow',
      'messaging_list_targets', 'messaging_send', 'p3394_send',
    ]);
    expect(JSON.stringify(getRuntimeToolCatalog())).not.toMatch(/group|chat|memory/i);
  });

  it('hides capability-gated messaging tools without the grant and rejects direct calls', async () => {
    const root = makeRoot();
    const denied = createRuntimeToolRunner({
      userId: UID,
      runtimeSessionId: SESSION,
      allowedRoots: [root],
      toolPolicy: DEFAULT_RUNTIME_TOOL_POLICY,
      hostToolClient: { call: async () => ({ content: 'should not be called' }) } as never,
    });
    expect(denied.catalog.map((tool) => tool.name)).not.toContain('messaging_send');
    const result = await denied.run('messaging_send', { target: 'self', text: 'hello' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_RUNTIME_UNKNOWN_TOOL');
  });

  it('exposes messaging tools only when the Commander capability is granted', async () => {
    const root = makeRoot();
    const hostToolClient = {
      call: async (call: { name: string; input: Record<string, unknown> }) => ({
        content: JSON.stringify({ name: call.name, input: call.input }),
      }),
    };
    const granted = createRuntimeToolRunner({
      userId: UID,
      runtimeSessionId: SESSION,
      allowedRoots: [root],
      toolPolicy: DEFAULT_RUNTIME_TOOL_POLICY,
      capabilities: ['messaging.proactive'],
      hostToolClient: hostToolClient as never,
    });
    const names = granted.catalog.map((tool) => tool.name);
    expect(names).toContain('messaging_list_targets');
    expect(names).toContain('messaging_send');
    const listed = await granted.run('messaging_list_targets', {});
    expect(listed.isError).toBeFalsy();
    expect(listed.content).toContain('messaging_list_targets');
    const sent = await granted.run('messaging_send', { target: 'self', text: 'hello' });
    expect(sent.isError).toBeFalsy();
    expect(sent.content).toContain('messaging_send');
  });

  it('stats, reads, searches, and greps files under explicit roots', async () => {
    const root = makeRoot();
    const notes = path.join(root, 'notes.md');
    const nested = path.join(root, 'src');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(notes, 'Alpha\nBeta\nGamma');
    fs.writeFileSync(path.join(nested, 'app.txt'), 'needle here\nother line');
    const tools = runner(root);

    const stat = await tools.run('stat_file', { path: notes });
    expect(stat.isError).toBeFalsy();
    expect(stat.content).toContain('kind="text"');
    expect(stat.content).toContain('total_chars="16"');

    const read = await tools.run('read_file', { path: notes, charStart: 6 });
    expect(read.isError).toBeFalsy();
    expect(read.content).toContain('covered="6-16"');
    expect(read.content).toContain('2\tBeta');

    const search = await tools.run('search_files', { query: '*.txt' });
    expect(search.isError).toBeFalsy();
    expect(search.content).toContain('app.txt');
    expect(search.content).not.toContain('notes.md');

    const grep = await tools.run('grep_files', { pattern: 'needle' });
    expect(grep.isError).toBeFalsy();
    expect(grep.content).toContain('app.txt:1:needle here');
  });

  it('rejects symlink escapes through the path sandbox', async () => {
    const root = makeRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-runtime-outside-'));
    const secret = path.join(outside, 'secret.txt');
    const link = path.join(root, 'linked-secret.txt');
    fs.writeFileSync(secret, 'SECRET');
    try {
      fs.symlinkSync(secret, link);
      const read = await runner(root).run('read_file', { path: link });
      expect(read.isError).toBe(true);
      expect(read.content).toContain('E_RUNTIME_PATH_DENIED');
      expect(read.content).not.toContain('SECRET');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects cloud transcript paths even under a broad explicit root', async () => {
    const transcript = paths.userSessionFile(UID, 'gconv-secret');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, 'PRIVATE TRANSCRIPT');

    const broadRunner = createRuntimeToolRunner({
      userId: UID,
      runtimeSessionId: SESSION,
      allowedRoots: [paths.userRoot(UID)],
      toolPolicy: DEFAULT_RUNTIME_TOOL_POLICY,
    });

    const read = await broadRunner.run('read_file', { path: transcript });
    expect(read.isError).toBe(true);
    expect(read.content).toContain('E_RUNTIME_TRANSCRIPT_PATH');
    expect(read.content).not.toContain('PRIVATE TRANSCRIPT');
  });



  it('denies write_file unless writable roots are enabled by policy', async () => {
    const root = makeRoot();
    const target = path.join(root, 'new.txt');

    const denied = await runner(root).run('write_file', { path: target, content: 'blocked' });

    expect(denied.isError).toBe(true);
    expect(denied.content).toContain('E_RUNTIME_PERMISSION_DENIED');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('writes and edits files only under explicit writable roots', async () => {
    const root = makeRoot();
    const target = path.join(root, 'docs', 'note.txt');
    const tools = runner(root, undefined, WRITE_POLICY);

    const write = await tools.run('write_file', { path: target, content: 'Alpha\nBeta\n' });
    expect(write.isError).toBeFalsy();
    expect(write.content).toContain('written');
    expect(fs.readFileSync(target, 'utf8')).toBe('Alpha\nBeta\n');

    const edit = await tools.run('edit_file', { path: target, old_string: 'Beta', new_string: 'Gamma' });
    expect(edit.isError).toBeFalsy();
    expect(edit.content).toContain('edited');
    expect(fs.readFileSync(target, 'utf8')).toBe('Alpha\nGamma\n');
  });

  it('rejects write_file symlink escapes and outside paths', async () => {
    const root = makeRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-runtime-write-outside-'));
    const secret = path.join(outside, 'secret.txt');
    const link = path.join(root, 'linked-secret.txt');
    fs.writeFileSync(secret, 'ORIGINAL');
    try {
      fs.symlinkSync(secret, link);
      const write = await runner(root, undefined, WRITE_POLICY).run('write_file', { path: link, content: 'LEAK' });
      expect(write.isError).toBe(true);
      expect(write.content).toContain('E_RUNTIME_PATH_DENIED');
      expect(fs.readFileSync(secret, 'utf8')).toBe('ORIGINAL');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });



  it('runs low-risk bash and rejects high-risk commands without executing them', async () => {
    const root = makeRoot();
    const marker = path.join(root, 'marker.txt');
    const tools = runner(root, undefined, SHELL_POLICY);

    const ok = await tools.run('bash', { command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('hello-runtime')"`, working_dir: root });
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toBe('hello-runtime');

    fs.writeFileSync(marker, 'keep');
    const risky = await tools.run('bash', { command: `rm -f ${JSON.stringify(marker)}`, working_dir: root });
    expect(risky.isError).toBe(true);
    expect(risky.content).toContain('E_RUNTIME_BASH_REQUIRES_APPROVAL');
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep');
  });

  it('runs skills only through run-skill.cjs when skill execution is enabled', async () => {
    const root = makeRoot();
    const skillDir = path.join(paths.userSkillsDir(UID), 'runtime-echo');
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: runtime-echo\ndescription: test\n---\n');
    fs.writeFileSync(
      path.join(skillDir, 'scripts', 'echo.js'),
      'module.exports = async ({ args }) => ({ ok: true, uid: process.env.COGSEED_UID, args });\n',
    );

    const denied = await runner(root).run('run_skill', { skill_id: 'runtime-echo', script: 'echo', args: ['a'] });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain('E_RUNTIME_PERMISSION_DENIED');

    const result = await runner(root, undefined, SKILL_POLICY, ['runtime-echo']).run('run_skill', {
      skill_id: 'runtime-echo',
      script: 'echo',
      args: ['a', 'b'],
      cwd: root,
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content.trim())).toEqual({ ok: true, uid: UID, args: ['a', 'b'] });
  });

  it('continues to run the frozen Skill snapshot after the live Skill changes', async () => {
    const root = makeRoot();
    const skillDir = path.join(paths.userSkillsDir(UID), 'runtime-pinned');
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: runtime-pinned\ndescription: test\n---\n');
    fs.writeFileSync(path.join(skillDir, 'scripts', 'echo.js'), 'module.exports = async () => ({ ok: true });\n');
    const snapshot = await captureSkillTree(skillDir);
    const version = await appendFullSkillVersion(UID, 'runtime-pinned', {
      operation: 'install',
      files: snapshot.files,
      source: { kind: 'manual_edit' },
      security: { outcome: 'pass', findingCount: 0 },
    });
    await ensureSkillRuntimeSnapshot(UID, 'runtime-pinned', version);

    const first = await runner(root, undefined, SKILL_POLICY, ['runtime-pinned'], [{
      skillId: 'runtime-pinned', version: version.version, revisionId: version.revisionId, manifestHash: snapshot.manifestHash,
    }]).run('run_skill', { skill_id: 'runtime-pinned', script: 'echo', cwd: root });
    expect(first.isError).toBeFalsy();

    fs.writeFileSync(path.join(skillDir, 'scripts', 'echo.js'), 'module.exports = async () => ({ ok: false, changed: true });\n');
    const frozen = await runner(root, undefined, SKILL_POLICY, ['runtime-pinned'], [{
      skillId: 'runtime-pinned', version: version.version, revisionId: version.revisionId, manifestHash: snapshot.manifestHash,
    }]).run('run_skill', { skill_id: 'runtime-pinned', script: 'echo', cwd: root });
    expect(frozen.isError).toBeFalsy();
    expect(JSON.parse(frozen.content.trim())).toEqual({ ok: true });
  });

  it('spills oversized tool output into the local runtime tool-results store', async () => {
    const root = makeRoot();
    const huge = path.join(root, 'huge.txt');
    fs.writeFileSync(huge, '0123456789\n'.repeat(2000));

    const read = await runner(root, 10).run('read_file', { path: huge });

    expect(read.isError).toBeFalsy();
    expect(read.content).toContain('<persisted-output');
    expect(read.persistedOutput?.ref).toMatch(/^read_file\.[a-f0-9]{64}$/);
    expect(read.persistedOutput?.path.startsWith(paths.cogseedRuntimeSessionToolResultsDir(UID, SESSION))).toBe(true);
    expect(fs.existsSync(read.persistedOutput!.path)).toBe(true);
  });
});
