import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previous: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-runtime-asset-context-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
});

afterEach(async () => {
  vi.doUnmock('../../../../src/main/features/recall/prompt-injection');
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function seedConfirmedProjection(userId: string, cid: string, judgment: string, summary: string) {
  const [candidates, refs, projection, storage, layout] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/workspace-refs'),
    import('../../../../src/main/features/recall/context-projection'),
    import('../../../../src/main/storage'),
    import('../../../../src/main/util/project-layout'),
  ]);
  const candidate = await createNightlyCandidateFixture(userId, {
    judgment,
    rawStatement: true,
    summary,
    suggestedType: 'rule',
    suggestedScope: 'review,project',
    sourceRefs: [{ kind: 'execution', id: 'exec-a' }],
  });
  const asset = await candidates.promoteRecallCandidate(userId, candidate.id, { actor: 'user' });
  await refs.addWorkspaceAssetReference(userId, { assetId: asset.asset.id, workspaceId: 'workspace-a', scope: 'review' });
  const preview = await projection.previewContextProjection(userId, {
    taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review',
  });
  const confirmed = await projection.confirmContextProjection(userId, preview.id);
  const messageFile = layout.conversationMessageFile(userId, cid);
  await fs.mkdir(path.dirname(messageFile), { recursive: true });
  await storage.appendJsonlAtomic(messageFile, {
    id: 'msg-a', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'preview',
    recall_projection_card: { projectionId: confirmed.id },
  });
  return confirmed;
}

async function seedOntology(userId: string): Promise<void> {
  const { commitOntologyCommand } = await import('../../../../src/main/features/cognition/ontology/service');
  const action = (recordId: string, record: Record<string, unknown>) => ({
    intent: 'create', recordId, record, sourceLabel: '用户确认',
  });
  await commitOntologyCommand(userId, {
    commandId: 'runtime-ontology-seed',
    expectedRevision: 0,
    actions: [
      action('jia-module', { kind: 'module', name: '甲项目', description: '', scope: { kind: 'personal' } }),
      action('person-type', { kind: 'definition', moduleId: 'jia-module', name: '人员', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      action('owner-def', { kind: 'definition', moduleId: 'jia-module', name: '评审负责人', description: '', definitionKind: 'attribute', subjectTypes: ['person-type'], objectTypes: [], valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject' }),
      action('wang-engineer', { kind: 'entity', moduleId: 'jia-module', typeId: 'person-type', name: '王工', description: '', aliases: [], identityStatus: 'confirmed' }),
      action('jia-owner-fact', { kind: 'assertion', moduleId: 'jia-module', subjectId: 'wang-engineer', definitionId: 'owner-def', object: { kind: 'literal', valueType: 'text', value: '评审负责人是王工' }, validity: { from: '2026-01-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } }),
    ],
  });
}

describe('Runtime asset context assembly', () => {
  it('builds an independent task ontology item and records a task-bound read receipt', async () => {
    await seedOntology('user-a');
    const { buildRuntimeOntologyContext } = await import('../../../../src/main/features/cogseed_backend/runtime-asset-context');
    const items = await buildRuntimeOntologyContext('user-a', 'task-ontology-runtime', {
      taskText: '准备甲项目评审会',
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'text', label: 'Task ontology' });
    expect(items[0].content).toContain('[[ontology:jia-module/jia-owner-fact@1]]');
    const { listOntologyQueryReadReceipts } = await import('../../../../src/main/features/cognition/ontology/query-receipt');
    const receipts = await listOntologyQueryReadReceipts('user-a', 'task-ontology-runtime');
    expect(receipts).toHaveLength(1);
    expect(receipts[0].recordRefs).toContainEqual(expect.objectContaining({
      moduleId: 'jia-module', recordId: 'jia-owner-fact', recordVersion: 1,
    }));
  });
  it('builds a text runtime context item from confirmed projections, read-only', async () => {
    await seedConfirmedProjection(
      'user-a', 'cid-a',
      'Keep architecture decisions in a decision log before changing runtime boundaries.',
      'Use decision logs for architecture changes',
    );
    const { buildRuntimeAssetContext } = await import('../../../../src/main/features/cogseed_backend/runtime-asset-context');
    const items = await buildRuntimeAssetContext('user-a', 'cid-a');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'text', label: 'Confirmed reusable ability assets' });
    expect(items[0].content).toContain('<confirmed-ability-assets>');
    expect(items[0].content).toContain('Use decision logs for architecture changes');
  });

  it('returns an empty array when the conversation has no confirmed projection', async () => {
    const { buildRuntimeAssetContext } = await import('../../../../src/main/features/cogseed_backend/runtime-asset-context');
    await expect(buildRuntimeAssetContext('user-a', 'cid-empty')).resolves.toEqual([]);
  });

  it('never leaks another user assets (user isolation)', async () => {
    await seedConfirmedProjection(
      'user-a', 'cid-a',
      'Private rule of user-a only.', 'Rule private to user-a',
    );
    const { buildRuntimeAssetContext } = await import('../../../../src/main/features/cogseed_backend/runtime-asset-context');
    const items = await buildRuntimeAssetContext('user-b', 'cid-a');
    expect(items).toEqual([]);
  });

  it('caps the assembled text to a bounded size', async () => {
    // judgment has a 4000-char ceiling in candidate-service; a large but legal
    // statement must still be capped by the assembler contract.
    await seedConfirmedProjection(
      'user-a', 'cid-a',
      'Rule '.repeat(750), 'Huge statement cap check',
    );
    const { buildRuntimeAssetContext, MAX_RUNTIME_ASSET_CONTEXT_CHARS } =
      await import('../../../../src/main/features/cogseed_backend/runtime-asset-context');
    const items = await buildRuntimeAssetContext('user-a', 'cid-a');
    expect(items).toHaveLength(1);
    expect(items[0].content.length).toBeLessThanOrEqual(MAX_RUNTIME_ASSET_CONTEXT_CHARS);
  });

  it('fails soft (empty array) when recall store is unavailable', async () => {
    const { buildRuntimeAssetContext } = await import('../../../../src/main/features/cogseed_backend/runtime-asset-context');
    // No COGSEED_WORKSPACE_ROOT data seeded for this user; reads yield no projections.
    await expect(buildRuntimeAssetContext('user-missing', 'cid-missing')).resolves.toEqual([]);
  });

  it('does not report asset ids when the asset block is omitted for size', async () => {
    vi.doMock('../../../../src/main/features/recall/prompt-injection', async (importOriginal) => ({
      ...await importOriginal<typeof import('../../../../src/main/features/recall/prompt-injection')>(),
      buildConfirmedProjectionPromptContext: async () => ({
        promptBlock: 'x'.repeat(16_001),
        citations: [{ assetId: 'asset-oversized', version: '1', projectionId: 'projection-oversized' }],
      }),
    }));
    const { buildRuntimeAssetContextAssembly } = await import('../../../../src/main/features/cogseed_backend/runtime-asset-context');
    const assembly = await buildRuntimeAssetContextAssembly('user-a', 'cid-oversized', 'task-oversized');
    expect(assembly.items).toEqual([]);
    expect(assembly.assetIds).toEqual([]);
    expect(assembly.omittedAssetIds).toEqual(['asset-oversized']);
  });

  it('reports dispatched asset ids only when the dispatched block is present', async () => {
    vi.doMock('../../../../src/main/features/recall/prompt-injection', async (importOriginal) => ({
      ...await importOriginal<typeof import('../../../../src/main/features/recall/prompt-injection')>(),
      buildDispatchedAssetsPromptBlock: async () => ({
        promptBlock: '',
        assetIds: ['asset-granted'],
        assets: [{ id: 'asset-granted', version: '1' }],
        recordCount: 0,
      }),
    }));
    const { buildDispatchedRuntimeAssetContextAssembly } = await import('../../../../src/main/features/cogseed_backend/runtime-asset-context');
    const assembly = await buildDispatchedRuntimeAssetContextAssembly('user-a', ['asset-granted'], {
      taskText: 'task', purpose: 'task',
    });
    expect(assembly.items).toEqual([]);
    expect(assembly.assetIds).toEqual([]);
  });

  it('records one InjectionReceipt per injected asset at the injection site (taskId anchor)', async () => {
    await seedConfirmedProjection(
      'user-a', 'cid-receipts',
      'Keep architecture decisions in a decision log before changing runtime boundaries.',
      'Use decision logs for architecture changes',
    );
    const { buildRuntimeAssetContext } = await import('../../../../src/main/features/cogseed_backend/runtime-asset-context');
    const items = await buildRuntimeAssetContext('user-a', 'cid-receipts', 'task-rt-1');
    expect(items).toHaveLength(1);
    const { listInjectionReceipts } = await import('../../../../src/main/features/recall/injection-receipt');
    const receipts = await listInjectionReceipts('user-a', 'task-rt-1');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      taskRunId: 'task-rt-1',
      status: 'injected',
      boundary: 'real',
      channel: 'projection',
    });
    expect(receipts[0].messageId).toBeUndefined();
    // taskId 缺席时（旧调用方）不落收据——没有稳定锚就不编造。
    await buildRuntimeAssetContext('user-a', 'cid-receipts');
    expect(await listInjectionReceipts('user-a', 'task-rt-1')).toHaveLength(1);
  });
  it('binds new Runtime injections to the host task, exact projection version and stable result anchor', async () => {
    const projection = await seedConfirmedProjection('user-a', 'cid-runtime-anchor', '解释先说结论，再列依据。', '回答结构');
    const { buildRuntimeAssetContext } = await import('../../../../src/main/features/cogseed_backend/runtime-asset-context');
    expect(await buildRuntimeAssetContext('user-a', 'cid-runtime-anchor', 'task-runtime-anchor', 'cogseed-exec-anchor')).toHaveLength(1);
    const { listInjectionReceipts } = await import('../../../../src/main/features/recall/injection-receipt');
    expect(await listInjectionReceipts('user-a', 'task-runtime-anchor')).toEqual([expect.objectContaining({
      channel: 'runtime', projectionId: projection.id, messageId: 'runtime-result-cogseed-exec-anchor', status: 'injected',
      assetVersion: projection.assetVersions![projection.assetIds[0]],
    })]);
  });
});
