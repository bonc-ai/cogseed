import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let prevRoot: string | undefined;
const UID = 'uCognition';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cognition-'));
  prevRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe('cognition feature aggregate layer', () => {
  it('lists ability assets rather than marketplace skills or raw memory rows', async () => {
    const users = await import('../../../src/main/features/users');
    users.activateUser(UID);
    const memory = await import('../../../src/main/features/memory');
    const groups = await import('../../../src/main/features/personal_ontology_groups');
    const recallCandidates = await import('../../../src/main/features/recall/candidate-service');
    const { userLocalRoot } = await import('../../../src/main/paths');
    const cognition = await import('../../../src/main/features/cognition');

    expect(memory.addEntry(UID, 'user', 'Prefers local-first memory flows.').ok).toBe(true);
    const created = await groups.createGroup(UID, 'Research ontology');
    expect(created.ok).toBe(true);
    const recallCandidate = await recallCandidates.saveRecallCandidate(UID, {
      judgment: 'Keep review evidence traceable.',
      suggestedType: 'rule',
      suggestedScope: 'project',
      sourceRefs: [
        { kind: 'artifact_file', subtype: 'context_file', id: 'context-a' },
        { kind: 'execution_evaluation', subtype: 'evaluation', id: 'evaluation-a' },
        { kind: 'conversation', subtype: 'message', id: 'message-a' },
        { kind: 'user_teaching_signal', subtype: 'teaching', id: 'teaching-a' },
      ],
    });
    const { asset: recallAsset } = await recallCandidates.promoteRecallCandidate(UID, recallCandidate.id);

    const statePath = path.join(userLocalRoot(UID), 'p3394', 'kstar-state.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      runs: [],
      experience_candidates: [{
        id: 'exp-a',
        source_run_id: 'run-a',
        conversation_id: 'gconv-a',
        agent_id: 'agent-a',
        summary: 'PRD decisions must preserve source and open questions',
        status: 'pending',
        created_at: '2026-08-04T00:00:00.000Z',
        updated_at: '2026-08-04T00:00:00.000Z',
      }],
      patch_candidates: [{
        id: 'patch-a',
        source_run_id: 'run-a',
        conversation_id: 'gconv-a',
        agent_id: 'agent-a',
        type: 'skill_patch',
        target: { kind: 'custom_skill', id: 'skill-a' },
        proposal: { title: 'Improve PRD rewrite method', summary: 'Keep source layering', proposed_content: 'new content' },
        engine: {},
        status: 'needs_review',
        created_at: '2026-08-04T00:00:00.000Z',
        updated_at: '2026-08-04T00:00:00.000Z',
      }],
      updated_at: '2026-08-04T00:00:00.000Z',
    }, null, 2));

    const assets = await cognition.listCognitionAssets(UID);
    expect(assets.some((asset) => asset.id === 'memory:user')).toBe(false);
    expect(assets.some((asset) => asset.category === 'skill' || asset.type === 'skill')).toBe(false);
    expect(assets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `CA-PERSONAL-${created.group?.group_id}`,
        category: 'personal',
        type: 'personal',
        title: 'Research ontology',
        maturity: 'transfer_validated',
        status: 'active',
        owner: expect.any(String),
        scope: expect.any(String),
        workspaceRefs: expect.any(Array),
        receiptRefs: expect.any(Array),
        candidateRefs: expect.any(Array),
      }),
      expect.objectContaining({
        id: 'candidate:exp-a',
        category: 'rule',
        maturity: 'bud',
        status: 'candidate',
      }),
      expect.objectContaining({
        id: 'candidate:patch-a',
        category: 'skill_method',
        maturity: 'bud',
        status: 'candidate',
        baselineSkillRef: 'skill:skill-a',
      }),
      expect.objectContaining({
        id: recallAsset.id,
        source: 'recall_ability_asset',
        relationRefs: expect.arrayContaining([
          expect.objectContaining({ type: 'knowledge', id: 'context-a' }),
          expect.objectContaining({ type: 'evaluation', id: 'evaluation-a' }),
          expect.objectContaining({ type: 'conversation', id: 'message-a' }),
          expect.objectContaining({ type: 'memory', id: 'teaching-a' }),
        ]),
      }),
    ]));

    const dashboard = await cognition.buildCognitionDashboard(UID);
    expect(dashboard.counts.assets).toBe(assets.length);
  });

  it('normalizes and filters candidates from personal ontology and KSTAR patches', async () => {
    const users = await import('../../../src/main/features/users');
    users.activateUser(UID);
    const { userLocalRoot } = await import('../../../src/main/paths');
    const { serializeCandidatesMarkdown } = await import('../../../src/main/features/personal_ontology_candidates');
    const cognition = await import('../../../src/main/features/cognition');

    const candidatesDir = path.join(userLocalRoot(UID), 'ontology_candidates');
    fs.mkdirSync(candidatesDir, { recursive: true });
    fs.writeFileSync(path.join(candidatesDir, 'candidates.md'), serializeCandidatesMarkdown([{
      candidate_id: 'personal-a',
      kind: 'preference',
      confidence: 'high',
      summary: 'Prefers concise answers',
      memory_scope: 'user',
      memory_text: 'Prefers concise answers',
      source_memory_refs: ['mem-a'],
    }]));

    const statePath = path.join(userLocalRoot(UID), 'p3394', 'kstar-state.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      runs: [],
      experience_candidates: [],
      patch_candidates: [{
        id: 'patch-a',
        source_run_id: 'run-a',
        conversation_id: 'gconv-a',
        agent_id: 'agent-a',
        type: 'skill_patch',
        target: { kind: 'custom_skill', id: 'skill-a' },
        proposal: { title: 'Improve skill', summary: 'Tighten checks', rationale: 'Reduce regressions', proposed_content: 'new content' },
        engine: {},
        status: 'needs_review',
        created_at: '2026-08-04T00:00:00.000Z',
        updated_at: '2026-08-04T00:00:00.000Z',
      }],
      updated_at: '2026-08-04T00:00:00.000Z',
    }, null, 2));

    const pending = await cognition.listCognitionCandidates(UID, { status: 'pending' });
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'personal_ontology',
        sourceId: 'personal-a',
        type: 'preference',
        title: 'Prefers concise answers',
        targetAssetId: undefined,
        sourceRefs: ['memory:mem-a'],
        evidenceRefs: ['memory:mem-a'],
        diffAvailable: false,
        actions: ['open_personal_ontology', 'import_to_recall'],
      }),
      expect.objectContaining({
        source: 'p3394_patch',
        sourceId: 'patch-a',
        type: 'skill_evolution',
        skillId: 'skill-a',
        targetAssetId: 'skill:skill-a',
        actions: ['source', 'accept', 'modify', 'defer', 'reject'],
      }),
    ]));

    await expect(cognition.listCognitionCandidates(UID, { skillId: 'skill-a' })).resolves.toEqual([
      expect.objectContaining({ sourceId: 'patch-a' }),
    ]);
  });

  it('skill summary exposes version history rollback availability', async () => {
    const users = await import('../../../src/main/features/users');
    users.activateUser(UID);
    const { appendSkillVersion } = await import('../../../src/main/features/skills/version-store');
    const cognition = await import('../../../src/main/features/cognition');

    await appendSkillVersion(UID, 'skill-a', { version: '0.1.0', note: 'legacy' });
    await appendSkillVersion(UID, 'skill-a', { version: '0.1.1', note: 'snapshot', content: 'version 0.1.1 content' });

    const summary = await cognition.getSkillCognitionSummary(UID, 'skill-a');
    expect(summary.versions).toEqual([
      expect.objectContaining({ version: '0.1.1', canRollback: true }),
      expect.objectContaining({ version: '0.1.0', canRollback: false }),
    ]);
  });

});
