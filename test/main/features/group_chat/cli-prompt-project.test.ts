import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A CLI agent dispatched into a project must receive that project's
// ORKAS.md. Before this was wired, `_buildCliPrompt` never took a projectId,
// so standing instructions (e.g. "the repo is at ~/Documents/GitHub/X")
// silently never reached the CLI and it guessed the repo from cwd instead.

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'uCliProj';
const CID = 'c_cli_proj';
const REPO_LINE = 'Orkas 代码仓库路径:`~/Documents/GitHub/AITeamRelease`。';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cli-prompt-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const AGENT = {
  agent_id: '0d14cc183d5f',
  name: 'Claude Code',
  description_en: 'Coding agent.',
  runtime: { kind: 'cli', cli: 'claude' },
  inputs: [],
} as any;

const ITEM = {
  actor: { id: AGENT.agent_id, kind: 'agent' },
  turnId: 't1',
  msgId: 'm1',
  fromActorId: 'user',
  llmPayload: '<msg from="user">查一下 Orkas 仓库当前的版本分支</msg>',
} as any;

async function buildPrompt(spaceId?: string): Promise<string> {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const bus = await import('../../../../src/main/features/group_chat/bus');
  return bus._buildCliPromptForTest(TEST_UID, CID, AGENT, ITEM, [], false, spaceId);
}

async function makeSpace(instructions?: string): Promise<string> {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const spaces = await import('../../../../src/main/features/spaces');
  const r = await spaces.createSpace(TEST_UID, { name: '迭代Orkas' });
  if (!r.ok) throw new Error('space setup failed');
  if (instructions !== undefined) {
    await spaces.writeSpaceInstructions(TEST_UID, r.space.space_id, instructions);
  }
  return r.space.space_id;
}

describe('CLI prompt › space instructions', () => {
  it('injects instructions when the conversation is scoped to a space', async () => {
    const sid = await makeSpace(`本项目用于迭代 Orkas。\n\n- ${REPO_LINE}`);
    const prompt = await buildPrompt(sid);

    expect(prompt).toContain('## Space instructions (user-authored)');
    // The whole point: the user's repo path actually reaches the CLI.
    expect(prompt).toContain(REPO_LINE);
  });

  it('places the space block in the stable prefix, ahead of the runtime region', async () => {
    const sid = await makeSpace(`- ${REPO_LINE}`);
    const prompt = await buildPrompt(sid);

    const spaceIdx = prompt.indexOf('## Space instructions (user-authored)');
    const runtimeIdx = prompt.indexOf('## Runtime injection');
    const taskIdx = prompt.indexOf('## Your task');
    expect(spaceIdx).toBeGreaterThan(-1);
    expect(runtimeIdx).toBeGreaterThan(-1);
    // Low-churn config sits before the per-turn region so the CLI's prompt
    // cache stays stable across turns.
    expect(spaceIdx).toBeLessThan(runtimeIdx);
    expect(spaceIdx).toBeLessThan(taskIdx);
  });

  it('omits the block entirely for a conversation with no space', async () => {
    await makeSpace(`- ${REPO_LINE}`);
    const prompt = await buildPrompt(undefined);

    expect(prompt).not.toContain('## Space instructions');
    expect(prompt).not.toContain(REPO_LINE);
    // The frame itself is intact — only the space slot is empty.
    expect(prompt).toContain('## Your task');
    expect(prompt).toContain('## Runtime injection');
  });

  it('omits the block when the space has no instructions yet', async () => {
    const sid = await makeSpace();
    const prompt = await buildPrompt(sid);

    expect(prompt).not.toContain('## Space instructions');
    expect(prompt).toContain('## Your task');
  });

  it('leaves no unsubstituted $project_block placeholder in any case', async () => {
    const withSid = await buildPrompt(await makeSpace(`- ${REPO_LINE}`));
    const withoutSid = await buildPrompt(undefined);
    expect(withSid).not.toContain('$project_block');
    expect(withoutSid).not.toContain('$project_block');
  });
});
