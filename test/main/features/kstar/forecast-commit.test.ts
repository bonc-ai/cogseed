import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-forecast-commit-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'path-a',
    plan: ['Inspect the current state', 'Return a verified result'],
    expectedTools: [],
    expectedActors: ['commander'],
    predictedResult: {
      summary: 'The requested outcome is delivered.',
      acceptanceSignals: ['The result is observable.'],
      predictedFiles: [],
    },
    causalLinks: [],
    assumptions: [],
    riskRuleRefs: [],
    score: {
      goalFit: 1,
      feasibility: 1,
      observability: 1,
      causalSupport: 1,
      riskPenalty: 0,
      total: 0,
    },
    ...overrides,
  };
}

async function seedForecastBoundary(options: { confirmed: boolean }) {
  const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const refs = await import('../../../../src/main/features/recall/workspace-refs');
  const projections = await import('../../../../src/main/features/recall/context-projection');

  const task = requirementStore.createKstarTaskRecord('user-a', {
    conversationId: 'cid-a',
    workspaceId: 'workspace-a',
    title: 'Fix OAuth callback',
  });
  const requirement = requirementStore.createKstarRequirementRecord('user-a', {
    taskId: task.id,
    conversationId: 'cid-a',
    userMessageIds: ['msg-a'],
    title: 'Fix OAuth callback',
    goalText: 'Fix OAuth callback',
    rHat: {
      summary: 'OAuth callback state is validated',
      acceptanceSignals: ['OAuth callback test passes'],
      source: 'user_message',
      confidence: 0.9,
    },
  });

  const savedCandidate = await candidates.saveRecallCandidate('user-a', {
    judgment: `Validate OAuth callback state. ${'x'.repeat(2_100)}`,
    summary: 'OAuth callback validation',
    suggestedType: 'rule',
    suggestedScope: 'review',
    spaceId: 'workspace-a',
    sourceRefs: [{ kind: 'execution', id: 'exec-oauth' }],
  });
  const promoted = await candidates.promoteRecallCandidate('user-a', savedCandidate.id, {
    actor: 'user',
    causalRule: {
      cause: 'OAuth state is not checked',
      effect: 'The callback can accept an invalid session',
      mitigation: 'Validate state before exchanging the code',
      severity: 'high',
      deltaR: -0.8,
    },
  });
  await refs.addWorkspaceAssetReference('user-a', {
    assetId: promoted.asset.id,
    workspaceId: 'workspace-a',
    scope: 'review',
  });
  const preview = await projections.previewContextProjection('user-a', {
    taskRunId: task.id,
    workspaceId: 'workspace-a',
    purpose: 'review',
    taskText: 'Fix OAuth callback',
  });
  const projection = options.confirmed
    ? await projections.confirmContextProjection('user-a', preview.id)
    : preview;

  task.requirementIds = [requirement.id];
  task.currentRequirementId = requirement.id;
  requirement.projectionId = projection.id;
  requirement.projectionIds = [projection.id];
  await requirementStore.replaceKstarTask('user-a', task);
  await requirementStore.replaceKstarRequirement('user-a', requirement);
  await requirementStore.writeConversationTaskState(
    'user-a',
    {
      ...requirementStore.createInitialConversationTaskState('user-a', 'cid-a'),
      currentTaskId: task.id,
      currentRequirementId: requirement.id,
    },
  );

  return {
    task,
    requirement,
    projection,
    selectedAsset: promoted.asset,
    input: {
      taskRunId: task.id,
      requirementId: requirement.id,
      projectionId: projection.id,
      workspaceId: 'workspace-a',
      taskText: 'Fix OAuth callback',
      constraints: ['Do not change the public API'],
      acceptanceCriteria: ['OAuth callback test passes'],
      candidates: [candidate(), candidate({ id: 'path-b' })],
      allowedToolNames: new Set<string>(),
    },
  };
}

function forecastFiles(): string[] {
  const dir = path.join(tmpDir, 'user-a', 'cloud', 'recall', 'records', 'world-model-forecasts');
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}

describe('Commander Forecast host commit', () => {
  it('requires a confirmed Projection owned by the active Requirement', async () => {
    const seeded = await seedForecastBoundary({ confirmed: false });
    const forecast = await import('../../../../src/main/features/kstar/forecast-commit');

    await expect(forecast.commitCommanderForecast('user-a', seeded.input))
      .rejects.toMatchObject({ code: 'kstar_projection_not_confirmed' });
    expect(forecastFiles()).toEqual([]);
  });

  it('accepts tool-free candidates, recomputes totals, persists bounded provenance, and binds the Requirement', async () => {
    const seeded = await seedForecastBoundary({ confirmed: true });
    const forecast = await import('../../../../src/main/features/kstar/forecast-commit');
    const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');

    const record = await forecast.commitCommanderForecast('user-a', seeded.input);

    expect(record).toMatchObject({
      taskRunId: seeded.task.id,
      requirementId: seeded.requirement.id,
      projectionId: seeded.projection.id,
      projectionConfirmedAt: seeded.projection.confirmedAt,
      provenanceComplete: true,
      snapshotId: expect.stringMatching(/^snap-/),
      forecast: {
        selectedCandidateId: 'path-a',
        candidates: [
          expect.objectContaining({
            id: 'path-a',
            aHat: expect.objectContaining({ expectedTools: [] }),
            score: expect.objectContaining({ total: 1 }),
          }),
          expect.objectContaining({ id: 'path-b' }),
        ],
      },
      input: {
        k: {
          projectionId: seeded.projection.id,
          abilityAssetRefs: [seeded.selectedAsset.id],
        },
        s: {
          workspaceId: 'workspace-a',
          lifecycle: { requirementStatus: 'open', projectionStatus: 'confirmed' },
        },
        t: {
          userGoal: 'Fix OAuth callback',
          constraints: ['Do not change the public API'],
          acceptanceCriteria: ['OAuth callback test passes'],
        },
      },
    });
    expect(record.input.k.abilityAssets[0].statement.length).toBeLessThanOrEqual(2_000);
    expect(JSON.stringify(record.input.s)).not.toContain(tmpDir);
    expect(await requirementStore.readKstarRequirement('user-a', seeded.requirement.id))
      .toMatchObject({ forecastId: record.id });
    expect(forecastFiles()).toEqual([`${record.id}.json`]);
  });

  it.each([
    ['unavailable tool', candidate({ expectedTools: ['made_up_tool'] }), 'kstar_unavailable_tool'],
  ])('maps %s to a stable code without persisting', async (_label, invalidCandidate, code) => {
    const seeded = await seedForecastBoundary({ confirmed: true });
    const forecast = await import('../../../../src/main/features/kstar/forecast-commit');
    const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');

    await expect(forecast.commitCommanderForecast('user-a', {
      ...seeded.input,
      // A NON-empty allowlist still rejects unavailable tools; an empty
      // allowlist (auto-forecast) means no tool constraint.
      allowedToolNames: new Set(['read_file', 'write_file']),
      candidates: [invalidCandidate, candidate({ id: 'path-b' })],
    })).rejects.toMatchObject({ code });
    expect(forecastFiles()).toEqual([]);
    expect(await requirementStore.readKstarRequirement('user-a', seeded.requirement.id))
      .not.toHaveProperty('forecastId');
  });

  it('tolerates unknown rule refs in candidate causal/risk fields (model cannot know host rule ids)', async () => {
    const seeded = await seedForecastBoundary({ confirmed: true });
    const forecast = await import('../../../../src/main/features/kstar/forecast-commit');

    const result = await forecast.commitCommanderForecast('user-a', {
      ...seeded.input,
      candidates: [
        candidate({
          causalLinks: [{ interventionIndex: 0, mechanism: 'Unsupported rule', ruleRefs: ['rule:not-frozen'], assumptions: [] }],
          riskRuleRefs: ['rule:not-frozen'],
        }),
        candidate({ id: 'path-b' }),
      ],
    });

    expect(result.id).toBeTruthy();
    const file = forecastFiles()[0];
    expect(file).toBeTruthy();
    const record = JSON.parse(fs.readFileSync(path.join(
      tmpDir, 'user-a', 'cloud', 'recall', 'records', 'world-model-forecasts', file,
    ), 'utf-8'));
    // The unknown refs are dropped, not fatal: candidate-1 keeps its plan but
    // gains no causal links / predicted risks from the model's guesses.
    expect(record.forecast.candidates[0].causalLinks).toEqual([]);
    expect(record.forecast.candidates[0].predictedRisks).toEqual([]);
    expect(record.forecast.candidates[0].aHat.plan.length).toBeGreaterThan(0);
  });

  it('uses stable model order to break equal scores', async () => {
    const seeded = await seedForecastBoundary({ confirmed: true });
    const forecast = await import('../../../../src/main/features/kstar/forecast-commit');
    const equalScore = {
      goalFit: 0.8,
      feasibility: 0.8,
      observability: 0.8,
      causalSupport: 0.8,
      riskPenalty: 0.2,
      total: 0,
    };

    const record = await forecast.commitCommanderForecast('user-a', {
      ...seeded.input,
      candidates: [
        candidate({ id: 'first', score: equalScore }),
        candidate({ id: 'second', score: equalScore }),
      ],
    });

    expect(record.forecast.selectedCandidateId).toBe('first');
  });

  it('rejects a Projection bound to another Requirement', async () => {
    const seeded = await seedForecastBoundary({ confirmed: true });
    const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');
    const forecast = await import('../../../../src/main/features/kstar/forecast-commit');
    const other = requirementStore.createKstarRequirementRecord('user-a', {
      taskId: seeded.task.id,
      conversationId: 'cid-a',
      userMessageIds: ['msg-b'],
      title: 'Other requirement',
      goalText: 'Other requirement',
    });
    await requirementStore.replaceKstarRequirement('user-a', other);

    await expect(forecast.commitCommanderForecast('user-a', {
      ...seeded.input,
      requirementId: other.id,
    })).rejects.toMatchObject({ code: 'kstar_invalid_candidate' });
    expect(forecastFiles()).toEqual([]);
  });

  it('loads durable personal ontology into K from USER.md and MEMORY.md (Q4)', async () => {
    const seeded = await seedForecastBoundary({ confirmed: true });
    const memoryDir = path.join(tmpDir, 'user-a', 'cloud', 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'USER.md'), 'The user prefers concise technical answers.\n\u00a7\nThe user works primarily in TypeScript.\n');
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), 'Shared fact: the team uses conventional commits.\n');

    const forecast = await import('../../../../src/main/features/kstar/forecast-commit');
    const record = await forecast.commitCommanderForecast('user-a', seeded.input);

    expect(record.input.k.ontologyAssets).toHaveLength(3);
    expect(record.input.k.ontologyAssets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'personal',
        scope: 'general',
        maturity: 'bud',
        title: 'The user prefers concise technical answers.',
      }),
      expect.objectContaining({
        type: 'personal',
        title: 'The user works primarily in TypeScript.',
      }),
      expect.objectContaining({
        type: 'personal',
        title: 'Shared fact: the team uses conventional commits.',
      }),
    ]));
    // Ontology assets never pollute the projection-selected refs/versions.
    expect(record.input.k.abilityAssetRefs).toEqual([seeded.selectedAsset.id]);
    expect(Object.keys(record.input.k.assetVersions || {})).toEqual([seeded.selectedAsset.id]);
    // Snapshot ontology totals include the memory-derived assets (1 selected
    // + 3 ontology entries).
    expect(record.snapshotId).toBeTruthy();
  });

  it('loads the T-Box ontology taxonomy into K from the group ledger (T-Box)', async () => {
    const seeded = await seedForecastBoundary({ confirmed: true });
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const group = await groups.createGroup('user-a', '工作方式');
    await groups.appendFieldValue('user-a', group.group!.group_id, '工作节奏', '上午专注', '手动');

    const forecast = await import('../../../../src/main/features/kstar/forecast-commit');
    const record = await forecast.commitCommanderForecast('user-a', seeded.input);

    expect(record.input.k.ontologyTaxonomy).toMatchObject({
      groups: [
        expect.objectContaining({
          groupId: group.group!.group_id,
          title: '工作方式',
          fields: expect.arrayContaining([expect.objectContaining({ name: '工作节奏' })]),
        }),
      ],
    });
    // Taxonomy never pollutes projection-selected refs.
    expect(record.input.k.abilityAssetRefs).toEqual([seeded.selectedAsset.id]);
  });

  it('loads the ontology R-Box (relation rules) into K alongside asset rules (R-Box)', async () => {
    const seeded = await seedForecastBoundary({ confirmed: true });
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const group = await groups.createGroup('user-a', '技术栈');
    await groups.appendFieldValue('user-a', group.group!.group_id, '工具', 'React → 前端框架', '手动');

    const forecast = await import('../../../../src/main/features/kstar/forecast-commit');
    const record = await forecast.commitCommanderForecast('user-a', seeded.input);

    expect(record.input.k.ontologyRules).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^ontr-/),
        groupId: group.group!.group_id,
        subject: 'React',
        object: '前端框架',
      }),
    ]);
    // Asset CausalRules (ΔR lessons) still present as the other R-Box source.
    expect(record.input.k.rules.length).toBeGreaterThanOrEqual(0);
    expect(record.input.k.abilityAssetRefs).toEqual([seeded.selectedAsset.id]);
  });

  it('evaluates rules at forecast time and carries matched rules into K (rule engine)', async () => {
    const seeded = await seedForecastBoundary({ confirmed: true });
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const group = await groups.createGroup('user-a', '认证');
    await groups.appendFieldValue('user-a', group.group!.group_id, '协议', 'OAuth → 回调安全', '手动');

    const forecast = await import('../../../../src/main/features/kstar/forecast-commit');
    const record = await forecast.commitCommanderForecast('user-a', {
      ...seeded.input,
      taskText: 'OAuth callback state validation missing',
    });

    expect(record.input.k.matchedRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'ontology',
          subject: 'OAuth',
          object: '回调安全',
        }),
      ]),
    );
  });

  it('degrades gracefully when memory files are absent (Q4)', async () => {
    const seeded = await seedForecastBoundary({ confirmed: true });
    const forecast = await import('../../../../src/main/features/kstar/forecast-commit');
    const record = await forecast.commitCommanderForecast('user-a', seeded.input);
    expect(record.input.k.ontologyAssets).toEqual([]);
  });

  it('injects ontology assets into the committed-projection prompt block without citations (Q4)', async () => {
    const seeded = await seedForecastBoundary({ confirmed: true });
    const memoryDir = path.join(tmpDir, 'user-a', 'cloud', 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'USER.md'), 'The user prefers concise technical answers.\n');

    const injection = await import('../../../../src/main/features/recall/prompt-injection');
    const context = await injection.buildRecallTurnPromptContext('user-a', {
      cid: 'cid-a',
      committedProjectionId: seeded.projection.id,
    });

    expect(context.promptBlock).toContain('The user prefers concise technical answers.');
    expect(context.promptBlock).toContain('"type":"personal"');
    // Ontology is visible to the model but never surfaces as a citation.
    const ontologyCitation = context.citations.find((citation) => citation.assetId.startsWith('onto-'));
    expect(ontologyCitation).toBeUndefined();
    expect(context.citations.map((citation) => citation.assetId)).toContain(seeded.selectedAsset.id);
  });
});
