import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const modelMocks = vi.hoisted(() => ({
  configured: true,
  oauthExpired: null as string | null,
  output: '',
  errorKind: null as null | 'auth' | 'rate_limit' | 'context_overflow' | 'timeout' | 'provider_error',
  buildError: null as Error | null,
  runGate: null as Promise<void> | null,
  buildCalls: [] as any[],
  runCalls: [] as any[],
  projectionAssetIds: [] as string[],
}));

vi.mock('../../../../src/main/features/auth', () => ({
  hasConfiguredModel: () => ({ configured: modelMocks.configured }),
  getConfiguredModelOAuthExpiredMessage: () => modelMocks.oauthExpired,
}));
vi.mock('../../../../src/main/model/core-agent/runner', () => ({
  buildRunner: vi.fn(async (input: any) => {
    modelMocks.buildCalls.push(input);
    if (modelMocks.buildError) throw modelMocks.buildError;
    return {
      providerId: 'anthropic',
      modelId: 'claude-test',
      turnEphemeral: '',
      runner: {
        run: async (input: any) => {
          modelMocks.runCalls.push(input);
          const gate = modelMocks.runGate;
          if (gate) await gate;
          return {
            text: modelMocks.output,
            content: [],
            meta: {
              durationMs: 1,
              model: 'claude-test',
              provider: 'anthropic',
              stopReason: 'end_turn',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              toolLoops: 0,
              compactionCount: 0,
              ...(modelMocks.errorKind ? { error: { kind: modelMocks.errorKind, message: 'provider detail must not persist' } } : {}),
            },
          };
        },
      },
    };
  }),
}));
vi.mock('../../../../src/main/features/recall/context-projection', () => ({
  createAutomaticContextProjection: vi.fn(async () => modelMocks.projectionAssetIds.length ? ({
    id: 'proj-auto-skill-context',
    assetIds: [...modelMocks.projectionAssetIds],
    sourceRefs: [],
    omittedRefs: [],
    status: 'confirmed',
  }) : undefined),
}));
vi.mock('../../../../src/main/features/p3394', () => ({
  listExperienceCandidates: vi.fn(async () => []),
  listPatchCandidates: vi.fn(async () => []),
  readReceipt: vi.fn(async () => undefined),
  decideExperienceCandidate: vi.fn(),
  reviewPatchCandidate: vi.fn(),
}));

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'recall-skill-user';

const VALID_PROPOSAL = JSON.stringify({
  description: 'Reviews product requirements with an evidence-first, repeatable method.',
  useWhen: ['A product requirement needs a structured evidence-based review.'],
  doNotUseWhen: ['The request lacks the requirement material needed for review.'],
  requiredInputs: [
    { name: 'request', description: 'The review goal and intended audience.' },
    { name: 'requirements', description: 'The product requirement material to review.' },
  ],
  workflowSteps: [
    'Confirm the review scope and required materials.',
    'Inspect each requirement against the approved review method.',
    'Separate supported findings from unresolved assumptions.',
    'Validate the final findings before returning them.',
  ],
  outputs: [
    { name: 'findings', description: 'Evidence-backed findings and recommended changes.' },
    { name: 'validation', description: 'Checks performed and unresolved limitations.' },
  ],
  validationChecks: [
    'Every finding must identify the supplied material that supports it.',
    'Unresolved assumptions must be labelled instead of presented as facts.',
  ],
  failureModes: [
    { name: 'Missing input', signal: 'Required material is absent.', response: 'Stop and request the missing material.' },
    { name: 'Validation failure', signal: 'A finding lacks support.', response: 'Return a blocked result with the failed checks.' },
  ],
  ontology: {
    concepts: [
      { name: 'Review task', description: 'The bounded product review request.' },
      { name: 'Requirement', description: 'A statement that must be evaluated.' },
      { name: 'Finding', description: 'A supported result of the review workflow.' },
      { name: 'Validation', description: 'A check applied before completion.' },
    ],
    relations: [
      'A review task evaluates requirements.',
      'A requirement supports or contradicts a finding.',
      'Validation checks each finding.',
    ],
  },
  mutableSurfaces: ['Workflow wording', 'Validation checks', 'Approved examples'],
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recall-skill-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  modelMocks.configured = true;
  modelMocks.oauthExpired = null;
  modelMocks.output = VALID_PROPOSAL;
  modelMocks.errorKind = null;
  modelMocks.buildError = null;
  modelMocks.runGate = null;
  modelMocks.buildCalls.length = 0;
  modelMocks.runCalls.length = 0;
  modelMocks.projectionAssetIds.length = 0;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(async () => {
  try {
    const reports = await import('../../../../src/main/quality/report');
    await reports.drainReportWrites();
  } finally {
    if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
    else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

async function createAsset(type: 'rule' | 'skill_method' = 'skill_method') {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const candidate = await candidates.saveRecallCandidate(UID, {
    // 两种类型必须用不同正文：同一句话同时落成 rule 和 skill_method 会被
    // 晋升闸门判为分类冲突（谁都不晋升），而本用例考的是 skill-draft 的类型
    // 过滤，不是分类冲突。
    judgment: type === 'skill_method'
      ? 'Review the request, apply the agreed method, and verify the result against supplied evidence.'
      : 'Product review must cite supplied evidence before any conclusion is recorded.',
    summary: type === 'skill_method' ? 'Evidence-first review method' : 'Evidence-first review rule',
    suggestedType: type,
    suggestedScope: 'product review',
    sourceRefs: [{ kind: 'artifact_file', subtype: 'context_file', id: `context-${type}` }],
  });
  return (await candidates.promoteRecallCandidate(UID, candidate.id, { actor: 'user' })).asset;
}

describe('Recall skill draft service', () => {
  it('only generates from active skill and method assets', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const rule = await createAsset('rule');
    await expect(service.prepareRecallSkillDraft(UID, rule.id)).rejects.toThrow(/only skill method/i);

    const method = await createAsset();
    await assets.pauseAbilityAsset(UID, method.id, { actor: 'user', reason: 'review later' });
    await expect(service.prepareRecallSkillDraft(UID, method.id)).rejects.toThrow(/only active/i);
  });

  it('builds and deterministically validates a complete Level A draft package', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const asset = await createAsset();
    const preview = await service.prepareRecallSkillDraft(UID, asset.id);
    const draft = await service.readRecallSkillDraft(UID, asset.id);

    expect(preview.validation).toEqual(expect.objectContaining({
      ok: true,
      target: 'level_a',
      label: 'level_a_structure',
      issues: [],
    }));
    expect(preview.fileCount).toBe(15);
    expect(preview.status).toBe('draft');
    if (preview.status !== 'draft') throw new Error('expected draft preview');
    expect(preview.recallContext).toMatchObject({ assetCount: 1, relatedAssetCount: 0, sourceCount: 1 });
    expect(preview.draftHash).toMatch(/^[a-f0-9]{64}$/);
    expect(draft?.files.every((file) => file.contentHash?.match(/^[a-f0-9]{64}$/))).toBe(true);
    expect(draft?.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      'SKILL.md',
      'agents/openai.yaml',
      'evals/evals.json',
      'references/skill-spec.yaml',
      'references/ontology-mapping.md',
      'references/input-contract.md',
      'references/output-contract.md',
      'references/eval-cases.yaml',
      'references/governance-boundaries.md',
    ]));
    expect(draft?.files.find((file) => file.path === 'references/skill-spec.yaml')?.content).toContain('production_release_allowed: false');
    expect(draft?.files.find((file) => file.path === 'SKILL.md')?.content).toContain('Inspect each requirement');
    expect(draft?.files.find((file) => file.path === 'references/eval-cases.yaml')?.content).toContain('negative: 4');
    expect(draft?.generator).toMatchObject({ kind: 'model', providerId: 'anthropic', modelId: 'claude-test' });
    const cognitionAssets = await import('../../../../src/main/features/cognition/assets-adapter');
    await expect(cognitionAssets.listCognitionAssets(UID, { category: 'skill_method' })).resolves.toEqual([
      expect.objectContaining({
        id: asset.id,
        recallSkillDraftStatus: 'draft',
        recallSkillDraft: expect.objectContaining({
          draftHash: preview.draftHash,
          fileCount: 15,
          validationOk: true,
          recallContext: { assetCount: 1, sourceCount: 1 },
        }),
      }),
    ]);
  });

  it('sends a traceable Recall context to an ephemeral tool-free model run', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const asset = await createAsset();

    await service.prepareRecallSkillDraft(UID, asset.id);

    expect(modelMocks.buildCalls).toHaveLength(1);
    expect(modelMocks.buildCalls[0]).toMatchObject({
      userId: UID,
      disableTools: true,
      ephemeralSession: true,
      skillList: [],
    });
    expect(modelMocks.runCalls).toHaveLength(1);
    expect(modelMocks.runCalls[0]).toMatchObject({ thinkingLevel: 'off', cacheRetention: 'none' });
    const input = JSON.parse(modelMocks.runCalls[0].message);
    expect(input.schemaVersion).toBe(2);
    expect(input.recallContext.primaryAssetId).toBe(asset.id);
    expect(input.recallContext.assets).toHaveLength(1);
    expect(Object.keys(input.recallContext.assets[0]).sort()).toEqual([
      'id', 'maturity', 'ontologyRefs', 'scope', 'statement', 'title', 'type', 'version',
    ]);
    expect(input.recallContext.sourceRefs).toEqual([
      expect.objectContaining({ kind: 'artifact_file', id: 'context-skill_method' }),
    ]);
    expect(modelMocks.runCalls[0].message).not.toContain('excerpt');
    expect(modelMocks.runCalls[0].message).not.toContain('candidateId');
    expect(modelMocks.runCalls[0].message).not.toContain('learningSignal');
  });

  it('uses Recall retrieval to combine related approved memories before drafting', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const method = await createAsset();
    const relatedRule = await createAsset('rule');
    modelMocks.projectionAssetIds.push(relatedRule.id, method.id);

    const preview = await service.prepareRecallSkillDraft(UID, method.id);
    const input = JSON.parse(modelMocks.runCalls[0].message);

    expect(input.recallContext.assets.map((item: any) => item.id)).toEqual([method.id, relatedRule.id]);
    expect(input.recallContext.sourceRefs).toHaveLength(2);
    expect(preview.recallContext).toMatchObject({
      projectionId: 'proj-auto-skill-context',
      assetCount: 2,
      relatedAssetCount: 1,
      sourceCount: 2,
    });
    await expect(service.readRecallSkillDraft(UID, method.id)).resolves.toMatchObject({
      recallContext: {
        projectionId: 'proj-auto-skill-context',
        primaryAssetId: method.id,
        assetIds: [method.id, relatedRule.id],
      },
    });
  });

  it('rejects markdown and extra fields as invalid model output', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    expect(() => service.parseRecallSkillProposal(`\`\`\`json\n${VALID_PROPOSAL}\n\`\`\``)).toThrow(/strict JSON/i);
    expect(() => service.parseRecallSkillProposal(JSON.stringify({ ...JSON.parse(VALID_PROPOSAL), extra: true }))).toThrow(/invalid fields/i);
  });

  it('persists safe retryable failures and retries without storing provider detail', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const asset = await createAsset();
    modelMocks.errorKind = 'timeout';

    const failed = await service.prepareRecallSkillDraft(UID, asset.id);
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'model_timeout', retryable: true, attempt: 1 });
    const storedFailure = await service.readRecallSkillDraft(UID, asset.id);
    expect(JSON.stringify(storedFailure)).not.toContain('provider detail');
    expect(JSON.stringify(storedFailure)).not.toContain(modelMocks.output);
    const cognitionAssets = await import('../../../../src/main/features/cognition/assets-adapter');
    await expect(cognitionAssets.listCognitionAssets(UID, { category: 'skill_method' })).resolves.toEqual([
      expect.objectContaining({
        id: asset.id,
        recallSkillDraftStatus: 'failed',
        recallSkillDraftErrorCode: 'model_timeout',
      }),
    ]);

    modelMocks.errorKind = null;
    const retried = await service.prepareRecallSkillDraft(UID, asset.id);
    expect(retried).toMatchObject({ status: 'draft', attempt: 2 });
    expect(modelMocks.runCalls).toHaveLength(2);
  });

  it('returns a configuration failure before building a model runner', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const asset = await createAsset();
    modelMocks.configured = false;

    await expect(service.prepareRecallSkillDraft(UID, asset.id)).resolves.toMatchObject({
      status: 'failed', errorCode: 'model_not_configured', retryable: true,
    });
    expect(modelMocks.buildCalls).toHaveLength(0);
  });

  it('does not fall back to fixed files when model output is invalid', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const asset = await createAsset();
    modelMocks.output = '{"description":"partial"}';

    const result = await service.prepareRecallSkillDraft(UID, asset.id);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'invalid_model_output' });
    const stored = await service.readRecallSkillDraft(UID, asset.id);
    expect(stored?.status).toBe('failed');
    expect(stored).not.toHaveProperty('files');
    expect(stored).not.toHaveProperty('draftHash');
  });

  it('maps authorization errors without persisting provider messages', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const asset = await createAsset();
    modelMocks.errorKind = 'auth';

    const result = await service.prepareRecallSkillDraft(UID, asset.id);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'model_auth_required' });
    expect(JSON.stringify(await service.readRecallSkillDraft(UID, asset.id))).not.toContain('provider detail');
  });

  it('deduplicates concurrent generation and reuses a valid draft', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const asset = await createAsset();

    const [first, second] = await Promise.all([
      service.prepareRecallSkillDraft(UID, asset.id),
      service.prepareRecallSkillDraft(UID, asset.id),
    ]);
    const third = await service.prepareRecallSkillDraft(UID, asset.id);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(modelMocks.runCalls).toHaveLength(1);
  });

  it('does not let a stale model failure replace a newer-version draft', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const asset = await createAsset();
    const gate = deferred();
    modelMocks.runGate = gate.promise;

    const staleOutcome = service.prepareRecallSkillDraft(UID, asset.id).then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.waitFor(() => expect(modelMocks.runCalls).toHaveLength(1));
    modelMocks.runGate = null;
    await assets.updateAbilityAsset(UID, asset.id, { statement: `${asset.statement} Use the current approved checklist.`, actor: 'user', reason: 'refresh approved checklist' });
    const current = await service.prepareRecallSkillDraft(UID, asset.id);
    expect(current).toMatchObject({ status: 'draft', assetVersion: '2' });

    modelMocks.errorKind = 'timeout';
    gate.resolve();
    expect(await staleOutcome).toBe('rejected');
    expect(await service.readRecallSkillDraft(UID, asset.id)).toMatchObject({ status: 'draft', sourceAssetVersion: '2' });
  });

  it('installs after confirmation and treats repeated confirmation as idempotent', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const skills = await import('../../../../src/main/features/skills');
    const asset = await createAsset();
    const draft = await service.prepareRecallSkillDraft(UID, asset.id);

    const first = await service.confirmRecallSkillDraft(UID, asset.id, draft.draftHash);
    const second = await service.confirmRecallSkillDraft(UID, asset.id, draft.draftHash);

    expect(second.skill.id).toBe(first.skill.id);
    expect(second.draft.status).toBe('installed');
    expect(await service.readInstalledSkillForAsset(UID, asset.id)).toBe(first.skill.id);
    const installed = await skills.getCustomSkill(first.skill.id);
    expect(installed?.id).toBe(first.skill.id);
    expect(fs.existsSync(path.join(tmpDir, UID, 'cloud', 'skills', first.skill.id, 'references', 'skill-spec.yaml'))).toBe(true);
    const cognitionAssets = await import('../../../../src/main/features/cognition/assets-adapter');
    await expect(cognitionAssets.listCognitionAssets(UID, { category: 'skill_method' })).resolves.toEqual([
      expect.objectContaining({ id: asset.id, generatedSkillId: first.skill.id }),
    ]);
  });

  it('never coalesces or accepts a confirmation with a different draft hash', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const skills = await import('../../../../src/main/features/skills');
    const asset = await createAsset();
    const draft = await service.prepareRecallSkillDraft(UID, asset.id);
    const started = deferred();
    const release = deferred();
    const skillOps = {
      createCustomSkill: async (...args: Parameters<typeof skills.createCustomSkill>) => {
        started.resolve();
        await release.promise;
        return skills.createCustomSkill(...args);
      },
      deleteCustomSkill: skills.deleteCustomSkill,
      getCustomSkill: skills.getCustomSkill,
      writeCustomSkillFileChecked: skills.writeCustomSkillFileChecked,
    };

    const accepted = service.confirmRecallSkillDraft(UID, asset.id, draft.draftHash, skillOps);
    await started.promise;
    const wrongHash = 'f'.repeat(64);
    const rejected = service.confirmRecallSkillDraft(UID, asset.id, wrongHash, skillOps).then(
      () => 'resolved',
      () => 'rejected',
    );
    release.resolve();

    await expect(accepted).resolves.toMatchObject({ draft: { status: 'installed' } });
    expect(await rejected).toBe('rejected');
    await expect(service.confirmRecallSkillDraft(UID, asset.id, wrongHash)).rejects.toThrow(/draft changed/i);
  });

  it('rolls back an install when a newer draft replaces the confirmed draft mid-write', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const skills = await import('../../../../src/main/features/skills');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const asset = await createAsset();
    const firstDraft = await service.prepareRecallSkillDraft(UID, asset.id);
    const started = deferred();
    const release = deferred();
    const skillOps = {
      createCustomSkill: async (...args: Parameters<typeof skills.createCustomSkill>) => {
        const created = await skills.createCustomSkill(...args);
        started.resolve();
        await release.promise;
        return created;
      },
      deleteCustomSkill: skills.deleteCustomSkill,
      getCustomSkill: skills.getCustomSkill,
      writeCustomSkillFileChecked: skills.writeCustomSkillFileChecked,
    };

    const installOutcome = service.confirmRecallSkillDraft(UID, asset.id, firstDraft.draftHash, skillOps).then(
      () => 'resolved',
      () => 'rejected',
    );
    await started.promise;
    await assets.updateAbilityAsset(UID, asset.id, { statement: `${asset.statement} Use the approved release checklist.`, actor: 'user', reason: 'refresh release checklist' });
    const currentDraft = await service.prepareRecallSkillDraft(UID, asset.id);
    expect(currentDraft).toMatchObject({ status: 'draft', assetVersion: '2' });
    release.resolve();

    expect(await installOutcome).toBe('rejected');
    expect(await service.readRecallSkillDraft(UID, asset.id)).toMatchObject({ status: 'draft', sourceAssetVersion: '2' });
    expect(await skills.getCustomSkill(firstDraft.skillName)).toBeNull();
  });

  it('rejects confirmation when the source asset version changes', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const asset = await createAsset();
    const draft = await service.prepareRecallSkillDraft(UID, asset.id);
    await assets.updateAbilityAsset(UID, asset.id, { statement: `${asset.statement} Use the current approved checklist.`, actor: 'user', reason: 'refresh approved checklist' });

    await expect(service.confirmRecallSkillDraft(UID, asset.id, draft.draftHash)).rejects.toThrow(/asset changed/i);
    await expect(service.readInstalledSkillForAsset(UID, asset.id)).resolves.toBeUndefined();
  });

  it('rejects confirmation when a related Recall memory changes after drafting', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const method = await createAsset();
    const relatedRule = await createAsset('rule');
    modelMocks.projectionAssetIds.push(relatedRule.id, method.id);
    const draft = await service.prepareRecallSkillDraft(UID, method.id);

    await assets.updateAbilityAsset(UID, relatedRule.id, {
      statement: `${relatedRule.statement} Preserve the reviewed boundary.`,
      actor: 'user',
      reason: 'preserve reviewed boundary',
    });

    await expect(service.confirmRecallSkillDraft(UID, method.id, draft.draftHash))
      .rejects.toThrow(/Recall context changed/i);
    await expect(service.readInstalledSkillForAsset(UID, method.id)).resolves.toBeUndefined();
  });

  it('rejects confirmation when a persisted draft file no longer matches its content hash', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const asset = await createAsset();
    const draft = await service.prepareRecallSkillDraft(UID, asset.id);
    const recordPath = path.join(tmpDir, UID, 'cloud', 'recall', 'records', 'skill-drafts', `${asset.id}.json`);
    const stored = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    stored.files[0].content += '\nTampered after validation.\n';
    fs.writeFileSync(recordPath, JSON.stringify(stored));

    await expect(service.confirmRecallSkillDraft(UID, asset.id, draft.draftHash)).rejects.toThrow(/file hash mismatch/i);
  });

  it('keeps an installed old-version Skill and generates a separate current-version draft', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const skills = await import('../../../../src/main/features/skills');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const asset = await createAsset();
    const firstDraft = await service.prepareRecallSkillDraft(UID, asset.id);
    if (firstDraft.status !== 'draft') throw new Error('expected first draft');
    const firstInstall = await service.confirmRecallSkillDraft(UID, asset.id, firstDraft.draftHash);
    await assets.updateAbilityAsset(UID, asset.id, { statement: `${asset.statement} Use the approved release checklist.`, actor: 'user', reason: 'refresh release checklist' });

    expect(await service.readInstalledSkillForAsset(UID, asset.id)).toBeUndefined();
    const nextDraft = await service.prepareRecallSkillDraft(UID, asset.id);
    if (nextDraft.status !== 'draft') throw new Error('expected next draft');
    expect(nextDraft.assetVersion).toBe('2');
    expect(nextDraft.skillName).not.toBe(firstInstall.skill.id);
    expect(await skills.getCustomSkill(firstInstall.skill.id)).not.toBeNull();

    const nextInstall = await service.confirmRecallSkillDraft(UID, asset.id, nextDraft.draftHash);
    expect(nextInstall.skill.id).not.toBe(firstInstall.skill.id);
    expect(await skills.getCustomSkill(firstInstall.skill.id)).not.toBeNull();
    expect(await skills.getCustomSkill(nextInstall.skill.id)).not.toBeNull();
  });

  it('rolls back a newly created skill when a checked file write fails', async () => {
    const service = await import('../../../../src/main/features/recall/skill-draft-service');
    const skills = await import('../../../../src/main/features/skills');
    const asset = await createAsset();
    const draft = await service.prepareRecallSkillDraft(UID, asset.id);
    const skillOps = {
      createCustomSkill: skills.createCustomSkill,
      deleteCustomSkill: skills.deleteCustomSkill,
      getCustomSkill: skills.getCustomSkill,
      writeCustomSkillFileChecked: (skillId: string, relpath: string, content: string) => (
        relpath === 'references/validation-contract.md'
          ? { ok: false as const, reason: 'invalid_path' as const }
          : skills.writeCustomSkillFileChecked(skillId, relpath, content)
      ),
    };

    await expect(service.confirmRecallSkillDraft(UID, asset.id, draft.draftHash, skillOps)).rejects.toThrow(/validation failed/i);
    expect(await skills.getCustomSkill(draft.skillName)).toBeNull();
    expect((await service.readRecallSkillDraft(UID, asset.id))?.status).toBe('draft');
  });
});
