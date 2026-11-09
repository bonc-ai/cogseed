import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNightlyCandidateFixture } from '../helpers/nightly-formation-fixture';
import { drainMainRuntimeForTest } from '../helpers/drain-main-runtime';

vi.mock('../../src/main/util/boot_init', () => ({
  registerDeferred: () => {},
  scheduleBootBackground: () => ({ cancel: vi.fn(), promise: Promise.resolve() }),
}));

let root: string;
let previousRoot: string | undefined;
const uid = 'ontology-loop-user';
const projectId = 'jia-project';
const moduleId = 'jia-module';
const ruleId = 'jia-review-rule';

beforeEach(async () => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ontology-loop-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  const { activateUser } = await import('../../src/main/features/users');
  activateUser(uid);
  const { migrateLegacyCognition } = await import('../../src/main/features/cognition_migration');
  expect((await migrateLegacyCognition(uid, { activate: true })).errors).toEqual([]);
});

afterEach(async () => {
  await drainMainRuntimeForTest(uid);
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function seedOntology(access: 'task' | 'owner_only' = 'task'): Promise<void> {
  const { commitOntologyCommand } = await import('../../src/main/features/cognition/ontology/service');
  const create = (recordId: string, record: Record<string, unknown>) => ({
    intent: 'create' as const, recordId, record: { access, ...record }, sourceLabel: '甲项目评审会合成数据',
  });
  await commitOntologyCommand(uid, {
    commandId: 'seed-jia-review',
    expectedRevision: 0,
    actions: [
      create(moduleId, {
        kind: 'module', name: '甲项目', description: '甲项目评审会',
        scope: { kind: 'project', id: projectId },
      }),
      create('person-type', {
        kind: 'definition', moduleId, name: '人员', description: '',
        definitionKind: 'type', subjectTypes: [], objectTypes: [],
        valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject',
      }),
      create('wang-engineer', {
        kind: 'entity', moduleId, typeId: 'person-type', name: '王工',
        description: '甲项目评审负责人', aliases: [], identityStatus: 'confirmed',
      }),
      create('review-owner-def', {
        kind: 'definition', moduleId, name: '评审负责人', description: '',
        definitionKind: 'attribute', subjectTypes: ['person-type'], objectTypes: [],
        valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject',
      }),
      create('jia-review-owner', {
        kind: 'assertion', moduleId, subjectId: 'wang-engineer', definitionId: 'review-owner-def',
        object: { kind: 'literal', valueType: 'text', value: '评审负责人是王工' },
        validity: { from: '2026-01-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' },
      }),
      create(ruleId, {
        kind: 'rule', moduleId, name: '评审行动项规则',
        requirement: '评审结束前确认负责人',
        strength: 'required',
        condition: { kind: 'task', field: 'taskKind', equals: 'review' },
        effect: { kind: 'note' },
        exception: '',
      }),
    ],
  });
  expect((await import('../../src/main/features/cognition/ontology/service')).readOntologyDocument(uid).revision).toBe(1);
}

async function createUpdateCandidate() {
  const formation = await import('../../src/main/features/recall/ontology-formation');
  const ontology = await import('../../src/main/features/cognition/ontology/service');
  const judgment = '评审结束前确认负责人、期限和行动项';
  const plan = formation.parseOntologyFormationProposal(ontology.readOntologyDocument(uid), 'temporary', {
    reason: '用户纠正：评审结束前还要确认期限和行动项',
    evidence: ['jia-correction'],
    refs: [{ moduleId, recordId: ruleId, versionPolicy: 'current' }],
    actions: [{
      intent: 'update', recordId: ruleId, expectedVersion: 1,
      patch: { requirement: judgment },
      sourceLabel: '用户纠正：评审结束前确认负责人、期限和行动项',
    }],
  }, judgment, '2026-11-02T10:10:00.000Z', 'ontology');
  if (!plan) throw new Error('formation plan missing');
  if (plan.blockedReasons.length) throw new Error(`formation blocked: ${plan.blockedReasons.join(',')}`);
  return createNightlyCandidateFixture(uid, {
    proposalTarget: 'ontology',
    formationProposalId: 'jia-review-formation',
    judgment,
    summary: '甲项目评审规则更新',
    value: '评审闭环更完整，避免遗漏负责人、期限和行动项。',
    suggestedType: 'cognition',
    suggestedScope: 'general',
    suggestedAction: 'create',
    risk: 'low',
    sourceRefs: [],
    ontologyFormation: plan,
  });
}

async function buildContext() {
  const { buildTaskOntologyContext } = await import('../../src/main/features/cognition/ontology/task-context');
  return buildTaskOntologyContext({
    userId: uid,
    taskText: '准备甲项目评审会',
    context: { projectId },
    purpose: 'review',
    taskKind: 'review',
  });
}

describe('ontology evidence → candidate → confirmation → next turn', () => {
  it('updates the ontology and makes the next automatic context read the new version', async () => {
    await seedOntology();
    const before = await buildContext();
    expect(before.promptBlock).toContain('评审结束前确认负责人');
    expect(before.promptBlock).toContain(`[[ontology:${moduleId}/${ruleId}@1]]`);
    const { recordOntologyQueryReadReceipt, listOntologyQueryReadReceipts } =
      await import('../../src/main/features/cognition/ontology/query-receipt');
    await recordOntologyQueryReadReceipt(uid, 'turn-before', before.readRefs);

    const candidate = await createUpdateCandidate();
    expect(candidate.status).toBe('pending_review');
    expect(candidate.proposalTarget).toBe('ontology');

    const { promoteRecallCaptureCandidate } = await import('../../src/main/features/recall/capture-service');
    const promotion = await promoteRecallCaptureCandidate(uid, candidate.id);
    expect(promotion.candidate.status).toBe('integrated');
    expect(promotion.candidate.ontologyHandoff?.recordIds).toContain(ruleId);

    const ontology = await import('../../src/main/features/cognition/ontology/service');
    const doc = ontology.readOntologyDocument(uid);
    expect(doc.revision).toBe(2);
    expect(doc.records[ruleId]).toMatchObject({
      kind: 'rule', version: 2, requirement: '评审结束前确认负责人、期限和行动项',
    });
    const commandId = promotion.candidate.ontologyFormation!.commandId;
    expect(doc.receipts[commandId].changedIds).toContain(ruleId);

    const after = await buildContext();
    expect(after.promptBlock).toContain('评审结束前确认负责人、期限和行动项');
    expect(after.promptBlock).toContain(`[[ontology:${moduleId}/${ruleId}@2]]`);
    expect(after.promptBlock).not.toContain(`[[ontology:${moduleId}/${ruleId}@1]]`);
    await recordOntologyQueryReadReceipt(uid, 'turn-after', after.readRefs);

    const oldReceipts = await listOntologyQueryReadReceipts(uid, 'turn-before');
    expect(oldReceipts[0].recordRefs).toContainEqual(expect.objectContaining({
      moduleId, recordId: ruleId, recordVersion: 1,
    }));
    const newReceipts = await listOntologyQueryReadReceipts(uid, 'turn-after');
    expect(newReceipts[0].recordRefs).toContainEqual(expect.objectContaining({
      moduleId, recordId: ruleId, recordVersion: 2,
    }));
  });

  it('confirmation produces a usage receipt for the next-turn answer', async () => {
    await seedOntology();
    const candidate = await createUpdateCandidate();
    const { promoteRecallCaptureCandidate } = await import('../../src/main/features/recall/capture-service');
    await promoteRecallCaptureCandidate(uid, candidate.id);
    const after = await buildContext();
    const { recordOntologyQueryReadReceipt, listOntologyQueryReadReceipts } =
      await import('../../src/main/features/cognition/ontology/query-receipt');
    const readReceipt = await recordOntologyQueryReadReceipt(uid, 'turn-usage', after.readRefs);
    expect(readReceipt).toBeTruthy();
    const { finalizeOntologyUsageCitations, listOntologyUsageReceipts } =
      await import('../../src/main/features/cognition/ontology/usage-receipt');
    const citation = `[[ontology:${moduleId}/${ruleId}@2]]`;
    expect(after.promptBlock).toContain(citation);
    const usage = await finalizeOntologyUsageCitations(uid, {
      taskRunId: 'turn-usage',
      messageId: 'msg-usage',
      finalText: `按更新后的规则执行：${citation}`,
    });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      moduleId, recordId: ruleId, recordVersion: 2, readReceiptId: readReceipt!.id, messageId: 'msg-usage',
    });
    expect(await listOntologyUsageReceipts(uid, 'turn-usage')).toHaveLength(1);
    expect(await listOntologyQueryReadReceipts(uid, 'turn-usage')).toHaveLength(1);
  });

  it('asset candidate confirmation updates the formal version, while an unconfirmed update does not', async () => {
    const { createNightlyCandidateFixture } = await import('../helpers/nightly-formation-fixture');
    const { promoteRecallCaptureCandidate } = await import('../../src/main/features/recall/capture-service');
    const assets = await import('../../src/main/features/recall/asset-service');
    const created = await createNightlyCandidateFixture(uid, {
      judgment: '评审前确认负责人和期限。',
      summary: '评审行动项检查',
      value: '减少评审后遗漏负责人和期限。',
      suggestedType: 'rule',
      suggestedScope: 'general',
      suggestedAction: 'create',
      risk: 'low',
      sourceRefs: [],
    });
    const first = await promoteRecallCaptureCandidate(uid, created.id);
    const assetId = first.asset!.id;
    expect(first.asset).toMatchObject({ version: '1' });
    expect((await assets.readAbilityAsset(uid, assetId)).statement).toBe('评审前确认负责人和期限。');

    const update = await createNightlyCandidateFixture(uid, {
      judgment: '评审前确认负责人、期限和行动项。',
      summary: '评审行动项检查',
      value: '减少评审后遗漏负责人、期限和行动项。',
      suggestedType: 'rule',
      suggestedScope: 'general',
      suggestedAction: 'update',
      targetAssetId: assetId,
      targetVersionUsed: '1',
      risk: 'low',
      sourceRefs: [],
    });
    expect(update.status).toBe('pending_review');
    expect((await assets.readAbilityAsset(uid, assetId)).statement).toBe('评审前确认负责人和期限。');

    const second = await promoteRecallCaptureCandidate(uid, update.id);
    expect(second.asset).toMatchObject({ version: '2' });
    expect((await assets.readAbilityAsset(uid, assetId)).statement).toBe('评审前确认负责人、期限和行动项。');
  });

  it('does not change the formal context while the candidate is unconfirmed', async () => {
    await seedOntology();
    const candidate = await createUpdateCandidate();
    expect(candidate.status).toBe('pending_review');

    const context = await buildContext();
    expect(context.promptBlock).toContain('评审结束前确认负责人');
    expect(context.promptBlock).toContain(`[[ontology:${moduleId}/${ruleId}@1]]`);
    expect(context.promptBlock).not.toContain('评审结束前确认负责人、期限和行动项');
    const ontology = await import('../../src/main/features/cognition/ontology/service');
    expect(ontology.readOntologyDocument(uid).revision).toBe(1);
  });

  it('promotes a private module and the next turn injects and cites it', async () => {
    await seedOntology('owner_only');
    const { buildTaskOntologyContext } = await import('../../src/main/features/cognition/ontology/task-context');
    const before = await buildTaskOntologyContext({
      userId: uid, taskText: '准备甲项目评审会', context: { projectId }, purpose: 'review', taskKind: 'review',
    });
    expect(before.promptBlock).toBe('');
    expect(before.scopeExcluded?.ownerOnly.modules).toBe(1);

    const { promoteOntologyAccess } = await import('../../src/main/features/cognition/ontology/access-promotion');
    const promotion = await promoteOntologyAccess(uid, [moduleId]);
    expect(promotion.partial).toBe(false);
    expect(promotion.promoted.modules).toBe(1);
    expect(promotion.batches).toHaveLength(1);

    const after = await buildTaskOntologyContext({
      userId: uid, taskText: '准备甲项目评审会', context: { projectId }, purpose: 'review', taskKind: 'review',
    });
    expect(after.promptBlock, after.promptBlock).toContain(`[[ontology:${moduleId}/${ruleId}@2]]`);
    const { recordOntologyQueryReadReceipt, listOntologyQueryReadReceipts } =
      await import('../../src/main/features/cognition/ontology/query-receipt');
    const read = await recordOntologyQueryReadReceipt(uid, 'turn-promoted', after.readRefs);
    expect(read).toBeTruthy();
    const receipts = await listOntologyQueryReadReceipts(uid, 'turn-promoted');
    expect(receipts[0].recordRefs).toContainEqual(expect.objectContaining({
      moduleId, recordId: ruleId, recordVersion: 2,
    }));

    const { finalizeOntologyUsageCitations, listOntologyUsageReceipts } =
      await import('../../src/main/features/cognition/ontology/usage-receipt');
    const citation = `[[ontology:${moduleId}/${ruleId}@2]]`;
    const usage = await finalizeOntologyUsageCitations(uid, {
      taskRunId: 'turn-promoted', messageId: 'msg-promoted', finalText: `按规则执行：${citation}`,
    });
    expect(usage).toHaveLength(1);
    expect(await listOntologyUsageReceipts(uid, 'turn-promoted')).toHaveLength(1);
  });
});
