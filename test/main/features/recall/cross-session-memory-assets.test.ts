import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RecallAbilityAssetScopePolicy } from '../../../../src/main/features/recall/scope-policy';

// 标题一等化（设计 3.2 / 深探 F1）：旧标题不合规时修正线动态 import
// suggestAbilityAssetTitle 起标题。单测无模型，mock 出确定性行为并记录调用
// （与 candidate-service.test.ts 的同款 mock 边界口径）。
const titleSuggest = vi.hoisted(() => ({
  suggested: '模型重起的记忆标题',
  failure: null as Error | null,
  calls: [] as Array<{ userId: string; input: Record<string, unknown> }>,
}));
vi.mock('../../../../src/main/features/recall/asset-title-suggestion', () => ({
  suggestAbilityAssetTitle: async (userId: string, input: Record<string, unknown>) => {
    titleSuggest.calls.push({ userId, input });
    if (titleSuggest.failure) throw titleSuggest.failure;
    return { title: titleSuggest.suggested };
  },
}));

const USER_ID = 'cross-memory-user';
const ALLOWED_AGENT = 'agent-memory-allowed';
const BLOCKED_AGENT = 'agent-memory-blocked';
let workspaceRoot: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-cross-memory-assets-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = workspaceRoot;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

async function seedScopedPersonalAsset(
  statement: string,
  scopePolicy: RecallAbilityAssetScopePolicy = { agentIds: [ALLOWED_AGENT] },
) {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const assets = await import('../../../../src/main/features/recall/asset-service');
  const saved = await candidates.saveRecallCandidate(USER_ID, {
    judgment: statement,
    // 标题闸门（设计 3.2）：summary＝正文首句过不了闸门，改为合规样本标题。
    summary: `跨会话样本${statement.length}`,
    suggestedType: 'personal',
    suggestedScope: 'general',
    sourceRefs: [{ kind: 'execution', id: `exec-${statement.length}` }],
  });
  const promoted = await candidates.promoteRecallCandidate(USER_ID, saved.id, { actor: 'user' });
  return assets.updateAbilityAsset(USER_ID, promoted.asset.id, {
    scopePolicy,
    reason: 'Limit this memory to the approved agent.',
    actor: 'user',
  });
}

describe('cross-session memory personal-asset runtime admission', () => {
  it('lists a personal asset body only for an eligible Agent', async () => {
    const statement = 'The user prefers short technical summaries.';
    const asset = await seedScopedPersonalAsset(statement);
    const memory = await import('../../../../src/main/features/recall/cross-session-memory-assets');

    const denied = await memory.listCrossSessionMemoryAssets(USER_ID, { agentId: BLOCKED_AGENT });
    expect(denied.entries).toEqual([]);

    const allowed = await memory.listCrossSessionMemoryAssets(USER_ID, { agentId: ALLOWED_AGENT });
    expect(allowed.entries.join('\n')).toContain(`[asset:${asset.id}]`);
    expect(allowed.entries.join('\n')).toContain(statement);
  });

  it('does not let an ineligible Agent replace or remove a matching formal asset', async () => {
    const statement = 'The user prefers concise implementation plans.';
    const asset = await seedScopedPersonalAsset(statement);
    const memory = await import('../../../../src/main/features/recall/cross-session-memory-assets');
    const assets = await import('../../../../src/main/features/recall/asset-service');

    const replacement = await memory.replaceCrossSessionMemoryAsset(
      USER_ID,
      statement,
      'The user prefers a detailed implementation plan.',
      { agentId: BLOCKED_AGENT },
    );
    expect(replacement).toMatchObject({ handled: true, result: { ok: false, entries: [] } });

    const removal = await memory.removeCrossSessionMemoryAsset(
      USER_ID,
      statement,
      { agentId: BLOCKED_AGENT },
    );
    expect(removal).toMatchObject({ handled: true, result: { ok: false, entries: [] } });

    const unchanged = await assets.readAbilityAsset(USER_ID, asset.id);
    expect(unchanged).toMatchObject({ statement, status: 'active', version: asset.version });
  });

  it.each([
    {
      name: 'Agent + purpose',
      scopePolicy: { agentIds: [ALLOWED_AGENT], purposeTags: ['review'] },
      context: { agentId: ALLOWED_AGENT },
    },
    {
      name: 'Agent + role',
      scopePolicy: { agentIds: [ALLOWED_AGENT], roleIds: ['role-memory-narrow'] },
      context: { agentId: ALLOWED_AGENT },
    },
    {
      name: 'Agent + project',
      scopePolicy: { agentIds: [ALLOWED_AGENT], projectIds: ['project-memory-narrow'] },
      context: { agentId: ALLOWED_AGENT },
    },
    {
      name: 'Agent + workspace',
      scopePolicy: { agentIds: [ALLOWED_AGENT], workspaceIds: ['space-memory-narrow'] },
      context: { agentId: ALLOWED_AGENT },
    },
    {
      name: 'Agent + conversation kind',
      scopePolicy: { agentIds: [ALLOWED_AGENT], conversationKinds: ['group_chat'] },
      context: { agentId: ALLOWED_AGENT },
    },
    {
      name: 'Agent + file kind',
      scopePolicy: { agentIds: [ALLOWED_AGENT], fileKinds: ['md'] },
      context: { agentId: ALLOWED_AGENT },
    },
    {
      name: 'Space + purpose',
      scopePolicy: { workspaceIds: ['space-memory-target'], purposeTags: ['review'] },
      context: { workspaceId: 'space-memory-target' },
    },
    {
      name: 'Space + role',
      scopePolicy: { workspaceIds: ['space-memory-target'], roleIds: ['role-memory-narrow'] },
      context: { workspaceId: 'space-memory-target' },
    },
    {
      name: 'Space + project',
      scopePolicy: { workspaceIds: ['space-memory-target'], projectIds: ['project-memory-narrow'] },
      context: { workspaceId: 'space-memory-target' },
    },
    {
      name: 'Space + Agent',
      scopePolicy: { workspaceIds: ['space-memory-target'], agentIds: [ALLOWED_AGENT] },
      context: { workspaceId: 'space-memory-target' },
    },
    {
      name: 'Space + conversation kind',
      scopePolicy: { workspaceIds: ['space-memory-target'], conversationKinds: ['group_chat'] },
      context: { workspaceId: 'space-memory-target' },
    },
    {
      name: 'Space + file kind',
      scopePolicy: { workspaceIds: ['space-memory-target'], fileKinds: ['md'] },
      context: { workspaceId: 'space-memory-target' },
    },
  ])('does not let a legacy $name target edit or remove a narrower asset', async ({ name, scopePolicy, context }) => {
    const statement = `Legacy memory text for ${name}.`;
    const asset = await seedScopedPersonalAsset(statement, scopePolicy);
    const memory = await import('../../../../src/main/features/recall/cross-session-memory-assets');
    const assets = await import('../../../../src/main/features/recall/asset-service');

    const replacement = await memory.replaceCrossSessionMemoryAsset(
      USER_ID,
      statement,
      `Corrected memory text for ${name}.`,
      context,
    );
    expect(replacement).toMatchObject({ handled: true, result: { ok: false, entries: [] } });

    const removal = await memory.removeCrossSessionMemoryAsset(USER_ID, statement, context);
    expect(removal).toMatchObject({ handled: true, result: { ok: false, entries: [] } });
    expect(await assets.readAbilityAsset(USER_ID, asset.id)).toMatchObject({
      statement,
      status: 'active',
      version: asset.version,
    });
  });

  it.each([
    {
      name: 'Agent in the authorized Project',
      scopePolicy: { agentIds: [ALLOWED_AGENT], projectIds: ['project-memory-authorized'] },
      context: { agentId: ALLOWED_AGENT, projectId: 'project-memory-authorized' },
    },
    {
      name: 'Space in the authorized Project',
      scopePolicy: { workspaceIds: ['space-memory-authorized'], projectIds: ['project-memory-authorized'] },
      context: { workspaceId: 'space-memory-authorized', projectId: 'project-memory-authorized' },
    },
  ])('allows correction within the legacy owner boundary when the current context satisfies the narrower scope ($name)', async ({ scopePolicy, context }) => {
    const statement = `Legacy memory text for ${context.agentId || context.workspaceId}.`;
    const asset = await seedScopedPersonalAsset(statement, scopePolicy);
    const memory = await import('../../../../src/main/features/recall/cross-session-memory-assets');
    const assets = await import('../../../../src/main/features/recall/asset-service');

    const replacement = await memory.replaceCrossSessionMemoryAsset(
      USER_ID,
      statement,
      `${statement} Corrected.`,
      context,
    );
    expect(replacement).toMatchObject({ handled: true, result: { ok: true } });
    const updated = await assets.readAbilityAsset(USER_ID, asset.id);
    expect(updated).toMatchObject({
      statement: `${statement} Corrected.`,
      status: 'active',
      scopePolicy,
    });
    expect(updated?.version).not.toBe(asset.version);

    const removal = await memory.removeCrossSessionMemoryAsset(USER_ID, updated!.statement, context);
    expect(removal).toMatchObject({ handled: true, result: { ok: true } });
    expect((await assets.readAbilityAsset(USER_ID, asset.id))?.status).toBe('deleted');
  });

  it('keeps the existing replace and reversible-remove path for an eligible Agent', async () => {
    const statement = 'The user prefers design notes before implementation.';
    const asset = await seedScopedPersonalAsset(statement);
    const memory = await import('../../../../src/main/features/recall/cross-session-memory-assets');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const context = { agentId: ALLOWED_AGENT };

    const replacement = await memory.replaceCrossSessionMemoryAsset(
      USER_ID,
      statement,
      'The user prefers a short design note before implementation.',
      context,
    );
    expect(replacement).toMatchObject({ handled: true, result: { ok: true } });
    const updated = await assets.readAbilityAsset(USER_ID, asset.id);
    expect(updated?.statement).toBe('The user prefers a short design note before implementation.');

    const removal = await memory.removeCrossSessionMemoryAsset(USER_ID, updated!.statement, context);
    expect(removal).toMatchObject({ handled: true, result: { ok: true } });
    expect((await assets.readAbilityAsset(USER_ID, asset.id))?.status).toBe('deleted');
  });
});

describe('标题一等化（设计 3.2 / 深探 F1）：记忆修正线禁止 makeDisplayTitle 直写 title', () => {
  beforeEach(() => {
    titleSuggest.calls.length = 0;
    titleSuggest.failure = null;
  });

  it('旧标题对新正文仍合规：沿用旧标题（update 不带 title），不调起标题链', async () => {
    const statement = 'The user tracks decisions in a shared log.';
    const asset = await seedScopedPersonalAsset(statement);
    const memory = await import('../../../../src/main/features/recall/cross-session-memory-assets');
    const assets = await import('../../../../src/main/features/recall/asset-service');

    const replacement = await memory.replaceCrossSessionMemoryAsset(
      USER_ID,
      statement,
      'The user now tracks decisions in a shared log with links.',
      { agentId: ALLOWED_AGENT },
    );
    expect(replacement).toMatchObject({ handled: true, result: { ok: true } });
    const updated = await assets.readAbilityAsset(USER_ID, asset.id);
    // 旧标题被沿用（update 不传 title 即保留），正文换新。
    expect(updated?.title).toBe(asset.title);
    expect(updated?.statement).toBe('The user now tracks decisions in a shared log with links.');
    expect(titleSuggest.calls).toHaveLength(0);
  });

  it('旧标题缺失或不合规（与正文开头重复）：走起标题共享函数，拿模型起的标题', async () => {
    const statement = 'Old memory about release notes.';
    const asset = await seedScopedPersonalAsset(statement);
    const store = await import('../../../../src/main/features/recall/store');
    // 制造两条不合规旧标题：①与将写入的新正文首字相同（prefix_overlap）；
    // ②空标题（存量缺失形态，raw 直改不走闸门）。
    const overlapText = '跨团队的发布说明规范，取代旧表述。';
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const cloneId = `aa-empty-title-${asset.id.slice(-6)}`;
    await store.writeRecallJsonRecord(USER_ID, 'ability-assets', cloneId, {
      ...(asset as unknown as Record<string, unknown>),
      id: cloneId,
      statement: 'Empty-title legacy memory body.',
      title: '',
    } as never);

    const memory = await import('../../../../src/main/features/recall/cross-session-memory-assets');
    const overlap = await memory.replaceCrossSessionMemoryAsset(
      USER_ID,
      statement,
      overlapText,
      { agentId: ALLOWED_AGENT },
    );
    expect(overlap).toMatchObject({ handled: true, result: { ok: true } });
    expect((await assets.readAbilityAsset(USER_ID, asset.id))?.title).toBe(titleSuggest.suggested);

    const empty = await memory.replaceCrossSessionMemoryAsset(
      USER_ID,
      'Empty-title legacy memory body.',
      'Replacement for the untitled legacy memory.',
      { agentId: ALLOWED_AGENT },
    );
    expect(empty).toMatchObject({ handled: true, result: { ok: true } });
    expect((await assets.readAbilityAsset(USER_ID, cloneId))?.title)
      .toBe(titleSuggest.suggested);

    // 起标题共享函数收到的是**将落盘的新正文**与资产类型。
    expect(titleSuggest.calls).toHaveLength(2);
    expect(titleSuggest.calls[0]).toMatchObject({
      userId: USER_ID,
      input: { statement: overlapText, type: 'personal' },
    });
  });

  it('起标题失败：明示失败，本次修正不落盘（正文与版本都不动）', async () => {
    const statement = 'Another legacy memory to correct.';
    const asset = await seedScopedPersonalAsset(statement);
    const store = await import('../../../../src/main/features/recall/store');
    const memory = await import('../../../../src/main/features/recall/cross-session-memory-assets');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    // raw 清空标题 → 起标题链被触发；模型不可用按明示失败口径上抛。
    await store.updateRecallJsonRecord(USER_ID, 'ability-assets', asset.id, (raw) => ({ ...raw!, title: '' }));
    titleSuggest.failure = new Error('model_not_configured');

    const replacement = await memory.replaceCrossSessionMemoryAsset(
      USER_ID,
      statement,
      'The corrected replacement body.',
      { agentId: ALLOWED_AGENT },
    );
    expect(replacement).toMatchObject({ handled: true, result: { ok: false, entries: [] } });
    const unchanged = await assets.readAbilityAsset(USER_ID, asset.id);
    expect(unchanged?.statement).toBe(statement);
    expect(unchanged?.version).toBe(asset.version);
    expect(titleSuggest.calls).toHaveLength(1);
  });
});
