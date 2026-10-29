import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  findCreatorAgentBindingByAgentId,
  isCreatorPresetMaterialized,
  readCreatorAgentBinding,
  saveCreatorAgentBinding,
  type CreatorAgentBinding,
} from '../../../../src/main/features/creator/agent-binding-store';
import { userCreatorAgentBindingFile } from '../../../../src/main/paths';

const userId = 'creator-binding-user';
const workspaceRoot = process.env.COGSEED_WORKSPACE_ROOT as string;

function binding(overrides: Partial<CreatorAgentBinding> = {}): CreatorAgentBinding {
  return {
    schemaVersion: 1,
    presetId: 'local-research',
    version: '1',
    manifestDigest: `sha256:${'a'.repeat(64)}`,
    agentId: 'agentabc12345',
    materializedAt: '2026-08-21T06:00:00.000Z',
    materializationRevision: 'revision-1',
    policy: {
      model: { providerId: 'provider-main', modelId: 'deepseek-chat' },
      skillIds: ['research'],
      capabilityIds: ['skill.research', 'tool.search', 'peer.peer-a.research.answer'],
      runtime: {
        sessionPolicy: 'new-per-run',
        memoryPolicy: 'read-only',
        loopPolicy: 'single-agent',
        sandboxProfile: 'creator-read-only-v1',
        timeoutMs: 60_000,
        budget: { maxCost: 2, maxTokens: 8_000 },
      },
      permissions: {
        tools: ['tool.search'],
        files: ['workspace.readonly'],
        sideEffects: [],
        approvalMode: 'always',
      },
    },
    ...overrides,
  };
}

beforeEach(async () => {
  await fs.rm(path.join(workspaceRoot, userId), { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(path.join(workspaceRoot, userId), { recursive: true, force: true });
});

describe('Creator Agent binding store', () => {
  it('saves an immutable binding and resolves it in both directions', async () => {
    const saved = await saveCreatorAgentBinding(userId, binding());

    expect(saved).toEqual(binding());
    expect(await readCreatorAgentBinding(userId, 'local-research', '1')).toEqual(binding());
    expect(await findCreatorAgentBindingByAgentId(userId, 'agentabc12345')).toEqual(binding());
    await expect(isCreatorPresetMaterialized(
      userId,
      'local-research',
      '1',
      `sha256:${'a'.repeat(64)}`,
    )).resolves.toBe(true);
  });

  it('treats an exact repeated save as idempotent without rewriting the binding', async () => {
    await saveCreatorAgentBinding(userId, binding());
    const file = userCreatorAgentBindingFile(userId, 'local-research');
    const before = await fs.readFile(file, 'utf8');

    const repeated = await saveCreatorAgentBinding(userId, binding());

    expect(repeated).toEqual(binding());
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('rejects conflicting digest or agent identity for an existing preset version', async () => {
    await saveCreatorAgentBinding(userId, binding());

    await expect(saveCreatorAgentBinding(userId, binding({
      manifestDigest: `sha256:${'b'.repeat(64)}`,
    }))).rejects.toThrow('creator_agent_binding_conflict');
    await expect(saveCreatorAgentBinding(userId, binding({
      agentId: 'different1234',
    }))).rejects.toThrow('creator_agent_binding_conflict');
  });

  it('rejects binding one Agent to a different preset version', async () => {
    await saveCreatorAgentBinding(userId, binding());

    await expect(saveCreatorAgentBinding(userId, binding({
      presetId: 'other-research',
      version: '2',
    }))).rejects.toThrow('creator_agent_binding_conflict');
  });

  it('keeps separate explicit versions addressable without mutating the first binding', async () => {
    const first = binding();
    const second = binding({
      version: '2',
      manifestDigest: `sha256:${'b'.repeat(64)}`,
      agentId: 'agentdef67890',
      materializationRevision: 'revision-2',
    });
    await saveCreatorAgentBinding(userId, first);
    await saveCreatorAgentBinding(userId, second);

    expect(await readCreatorAgentBinding(userId, 'local-research', '1')).toEqual(first);
    expect(await readCreatorAgentBinding(userId, 'local-research', '2')).toEqual(second);
  });



  it('rejects unsafe user ids before resolving binding paths', async () => {
    await expect(saveCreatorAgentBinding('../other-user', binding()))
      .rejects.toThrow('creator_agent_binding_user_invalid');
    await expect(readCreatorAgentBinding('../other-user', 'local-research', '1'))
      .rejects.toThrow('creator_agent_binding_user_invalid');
    await expect(findCreatorAgentBindingByAgentId('../other-user', 'agentabc12345'))
      .rejects.toThrow('creator_agent_binding_user_invalid');
  });

  it('returns stable corruption errors for malformed or non-canonical binding files', async () => {
    const file = userCreatorAgentBindingFile(userId, 'local-research');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{broken', 'utf8');
    await expect(readCreatorAgentBinding(userId, 'local-research', '1'))
      .rejects.toThrow('creator_agent_binding_corrupt');

    await fs.writeFile(file, JSON.stringify({
      schemaVersion: 1,
      presetId: 'local-research',
      bindings: [{ ...binding(), endpoint: 'forbidden' }],
    }), 'utf8');
    await expect(readCreatorAgentBinding(userId, 'local-research', '1'))
      .rejects.toThrow('creator_agent_binding_corrupt');
  });

  it('rejects secret, endpoint, absolute-path, and unknown fields before persistence', async () => {
    for (const extra of [
      { apiKey: 'forbidden' },
      { endpoint: 'forbidden' },
      { localPath: '/private/tmp/agent' },
      { unexpected: 'forbidden' },
    ]) {
      await expect(saveCreatorAgentBinding(userId, {
        ...binding(),
        ...extra,
      } as CreatorAgentBinding)).rejects.toThrow('creator_agent_binding_invalid');
    }
  });

  it('rejects a symlinked binding file instead of following it outside the user root', async () => {
    const file = userCreatorAgentBindingFile(userId, 'local-research');
    const outside = path.join(workspaceRoot, 'outside-binding.json');
    await fs.writeFile(outside, JSON.stringify({
      schemaVersion: 1,
      presetId: 'local-research',
      bindings: [binding()],
    }), 'utf8');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.symlink(outside, file);

    await expect(readCreatorAgentBinding(userId, 'local-research', '1'))
      .rejects.toThrow('creator_agent_binding_corrupt');
  });

  it('rejects a symlinked bindings parent for reads and writes', async () => {
    const bindingsDir = path.dirname(userCreatorAgentBindingFile(userId, 'local-research'));
    const outsideDir = path.join(workspaceRoot, 'outside-bindings');
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.mkdir(path.dirname(bindingsDir), { recursive: true });
    await fs.symlink(outsideDir, bindingsDir);

    await expect(readCreatorAgentBinding(userId, 'local-research', '1'))
      .rejects.toThrow('creator_agent_binding_corrupt');
    await expect(saveCreatorAgentBinding(userId, binding()))
      .rejects.toThrow('creator_agent_binding_invalid');
  });
});
