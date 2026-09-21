import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-fact-type-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function modules() {
  const [candidates, formal, tree, screening] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/formal-assets'),
    import('../../../../src/main/features/recall/tree-service'),
    import('../../../../src/main/features/recall/capture-value-screening'),
  ]);
  return { candidates, formal, tree, screening };
}

function factCandidate() {
  return {
    judgment: '团队长期使用 GitLab 托管代码，MR 是主要协作入口。',
    value: '后续讨论代码协作、MR 流程和仓库归属时直接沿用这个环境事实。',
    summary: '团队使用 GitLab 托管代码',
    suggestedType: 'fact' as const,
    suggestedScope: 'code',
    suggestedAction: 'create' as const,
    sourceRefs: [{ kind: 'execution' as const, id: 'exec-fact' }],
    evidenceRefs: [{ kind: 'execution' as const, id: 'exec-fact' }],
  };
}

describe('fact ability asset type', () => {
  it('accepts stable project facts but rejects transient task state', async () => {
    const { screening } = await modules();
    expect(screening.assessRecallCandidateClassification(factCandidate(), {})).toEqual({
      ok: true,
      blockingReasons: [],
      advisoryReasons: [],
    });

    expect(screening.assessRecallCandidateClassification({
      ...factCandidate(),
      judgment: '今天这次构建失败了一次。',
      value: '记录本次失败的临时状态。',
      summary: '构建失败',
    }, {})).toMatchObject({
      ok: false,
      blockingReasons: ['fact_not_stable'],
    });
  });

  it('saves, updates, and promotes a fact candidate without inventing another type', async () => {
    const { candidates } = await modules();
    const saved = await candidates.saveRecallCandidate('user-fact', factCandidate());
    expect(saved).toMatchObject({ status: 'pending_review', suggestedType: 'fact' });

    const updated = await candidates.updateRecallCandidate('user-fact', saved.id, {
      ...factCandidate(),
      judgment: '团队长期使用 GitLab 托管代码；MR 审查是必须流程。',
    });
    expect(updated.suggestedType).toBe('fact');

    const promoted = await candidates.promoteRecallCandidate('user-fact', updated.id, { actor: 'user' });
    expect(promoted.asset.type).toBe('fact');
    expect(promoted.receipt.assetType).toBe('fact');
  });

  it('keeps fact inside the formal asset canonical boundary', async () => {
    const { candidates, formal } = await modules();
    const saved = await candidates.saveRecallCandidate('user-fact', factCandidate());
    const promoted = await candidates.promoteRecallCandidate('user-fact', saved.id, { actor: 'user' });

    const list = await formal.listFormalAssets('user-fact', { assetType: 'fact' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ assetId: promoted.asset.id, assetType: 'fact' });
    expect(list[0].payload).toEqual({ kind: 'fact' });
  });

  it('projects fact assets on cognition tree contract v3', async () => {
    const { candidates, tree } = await modules();
    const saved = await candidates.saveRecallCandidate('user-fact', factCandidate());
    const promoted = await candidates.promoteRecallCandidate('user-fact', saved.id, { actor: 'user' });

    const graph = await tree.rebuildCognitionTree('user-fact');
    expect(graph.contractVersion).toBe(3);
    expect(graph.nodes).toContainEqual(expect.objectContaining({
      id: `asset:${promoted.asset.id}`,
      type: 'asset',
      assetType: 'fact',
    }));
  });

  it('extraction prompts define fact as a durable factual category', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/main/features/recall/capture-service.ts'), 'utf8');
    expect(source).toContain('- fact: "Is this a durable fact about a project or environment?"');
    expect(source).toContain('templates, methods, or durable facts');
  });

  it('keeps the four existing asset types valid', async () => {
    const { candidates } = await modules();
    for (const type of ['personal', 'rule', 'template', 'skill_method'] as const) {
      const saved = await candidates.saveRecallCandidate(`user-${type}`, {
        ...factCandidate(),
        suggestedType: type,
      });
      expect(saved.suggestedType).toBe(type);
    }
  });
});
