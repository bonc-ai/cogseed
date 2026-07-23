import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';
const TEST_CID = 'cid-repro';

function writeFile(rel: string, body: string): string {
  const abs = path.join(tmpDir, 'workspace', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-repro-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = path.join(tmpDir, 'data');
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  writeFile('README.md', '# Demo Repro\n\nRun `python examples/minimal.py`.');
  writeFile('requirements.txt', 'numpy\n');
  writeFile('examples/minimal.py', 'print("ok")\n');
  writeFile('.env', 'SECRET=1\n');
  writeFile('node_modules/ignored.js', 'ignored');
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('companion_repro › storage and manifest', () => {
  it('collects repro inputs through a visible AI-style guide conversation', async () => {
    const repro = await import('../../../src/main/features/companion_repro');

    let state = await repro.submitGuideMessage(TEST_UID, TEST_CID, '帮我跑一下这篇论文对应的 GitHub 项目。');
    expect(state.guide_messages.map((msg) => msg.role)).toEqual(['user', 'assistant']);
    expect(state.draft?.user_intent).toContain('帮我跑一下');
    expect(state.guide_messages.at(-1)?.text).toContain('论文选区');

    state = await repro.submitGuideMessage(TEST_UID, TEST_CID, 'The minimal experiment verifies the model output on a small fixture.');
    expect(state.draft?.paper_selection).toContain('minimal experiment');
    expect(state.guide_messages.at(-1)?.text).toContain('GitHub 仓库');

    state = await repro.submitGuideMessage(TEST_UID, TEST_CID, 'repo 是 https://github.com/example/tiny-repro commit 是 abc1234');
    expect(state.draft?.repo_url).toBe('https://github.com/example/tiny-repro');
    expect(state.draft?.commit).toBe('abc1234');
    expect(state.guide_messages.at(-1)?.text).toContain('workspace');

    state = await repro.submitGuideMessage(TEST_UID, TEST_CID, path.join(tmpDir, 'workspace'));
    expect(state.draft?.workspace_path).toBe(path.join(tmpDir, 'workspace'));
    expect(state.reference_manifest?.included_files.map((file) => file.path)).toContain('README.md');
    expect(state.guide_messages.at(-1)?.text).toContain('ReferenceManifest');
  });

  it('stores state under the conversation group directory and creates a reference manifest', async () => {
    const repro = await import('../../../src/main/features/companion_repro');
    const paths = repro.companionReproPaths(TEST_UID, TEST_CID);
    expect(paths.rootDir).toBe(path.join(tmpDir, 'data', TEST_UID, 'cloud', 'chats', TEST_CID, 'companion_repro'));

    const state = await repro.saveDraft(TEST_UID, TEST_CID, {
      paper_title: 'Tiny Paper',
      paper_selection: 'The minimal experiment verifies the model output on a small fixture.',
      repo_url: 'https://github.com/example/tiny-repro',
      commit: 'abc1234',
      workspace_path: path.join(tmpDir, 'workspace'),
      user_intent: 'Run the minimal experiment on this Mac.',
    });

    expect(state.reference_manifest?.repo_url).toBe('https://github.com/example/tiny-repro');
    expect(state.reference_manifest?.commit).toBe('abc1234');
    expect(state.reference_manifest?.included_files.map((file) => file.path)).toContain('README.md');
    expect(state.reference_manifest?.included_files.map((file) => file.path)).toContain('requirements.txt');
    expect(state.reference_manifest?.skipped_files.some((file) => file.path === '.env' && file.reason === 'sensitive')).toBe(true);
    expect(state.reference_manifest?.skipped_files.some((file) => file.path.startsWith('node_modules/'))).toBe(true);

    const events = await repro.readEvidence(TEST_UID, TEST_CID, 10);
    expect(events.map((event) => event.type)).toEqual(['draft_saved', 'reference_manifest_created']);
  });
});

describe('companion_repro › context, contract, and execution gate', () => {
  it('generates editable project context and records revision decisions', async () => {
    const repro = await import('../../../src/main/features/companion_repro');
    await repro.saveDraft(TEST_UID, TEST_CID, {
      paper_selection: 'The minimal experiment verifies the model output on a small fixture.',
      repo_url: 'https://github.com/example/tiny-repro',
      commit: 'abc1234',
      workspace_path: path.join(tmpDir, 'workspace'),
      user_intent: 'Run the minimal experiment on this Mac.',
    });

    const context = await repro.generateProjectContext(TEST_UID, TEST_CID);
    expect(context.tech_stack).toContain('Python');
    expect(context.key_files.map((file) => file.path)).toContain('README.md');
    expect(context.uncertainties.length).toBeGreaterThan(0);

    const revised = await repro.applyProjectContextRevision(TEST_UID, TEST_CID, {
      before: 'Full training needs to run.',
      after: 'Only the minimal CPU sample needs to run.',
      reason: 'Demo scope is a minimum reproducible experiment.',
    });
    expect(revised.review_decisions.at(-1)).toMatchObject({
      before: 'Full training needs to run.',
      after: 'Only the minimal CPU sample needs to run.',
    });
  });

  it('requires a confirmed task contract before starting execution', async () => {
    const repro = await import('../../../src/main/features/companion_repro');
    await repro.saveDraft(TEST_UID, TEST_CID, {
      paper_selection: 'The minimal experiment verifies the model output on a small fixture.',
      repo_url: 'https://github.com/example/tiny-repro',
      commit: 'abc1234',
      workspace_path: path.join(tmpDir, 'workspace'),
      user_intent: 'Run the minimal experiment on this Mac.',
    });
    await repro.generateProjectContext(TEST_UID, TEST_CID);
    const contract = await repro.generateTaskContract(TEST_UID, TEST_CID);
    expect(contract.confirmed_at).toBeNull();

    const sends: string[] = [];
    const blocked = await repro.startExecution(TEST_UID, TEST_CID, {
      send: async ({ text }) => { sends.push(text); return { ok: true }; },
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe('task_contract_not_confirmed');
    expect(sends).toEqual([]);

    await repro.confirmTaskContract(TEST_UID, TEST_CID, 'demo-user');
    const started = await repro.startExecution(TEST_UID, TEST_CID, {
      send: async ({ text }) => { sends.push(text); return { ok: true }; },
    });
    expect(started.ok).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('Run the minimal experiment on this Mac.');
    expect(sends[0]).toContain('Success criteria');
  });
});
