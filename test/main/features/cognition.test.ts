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
    const { asset: recallAsset } = await recallCandidates.promoteRecallCandidate(UID, recallCandidate.id, { actor: 'user' });

    const assets = await cognition.listCognitionAssets(UID);
    expect(assets.some((asset) => asset.id === 'memory:user')).toBe(false);
    expect(assets.some((asset) => asset.category === 'skill' || asset.type === 'skill')).toBe(false);
    // 个人本体「分组」是 PRD 3.3 的非资产支撑对象，不占四类一级分类。它曾被
    // 合成为 `CA-PERSONAL-*` 条目并硬编码 maturity: 'transfer_validated' —— 在
    // 没有 TransferProof / Receipt 的情况下伪造成熟度（PRD 3.6）。分组的入口在
    // 「关于我」tab，不该在资产列表里重复出现。
    expect(assets.some((asset) => asset.id === `CA-PERSONAL-${created.group?.group_id}`)).toBe(false);
    expect(assets.some((asset) => asset.source === 'personal_ontology')).toBe(false);
    expect(assets).toEqual(expect.arrayContaining([
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

  it('normalizes and filters personal ontology candidates without reading legacy KSTAR state', async () => {
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
    ]));

    await expect(cognition.listCognitionCandidates(UID, { conversationId: 'gconv-b' })).resolves.toEqual([]);
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

  it('exposes complete version metadata, file diffs, and rollback previews', async () => {
    const users = await import('../../../src/main/features/users');
    users.activateUser(UID);
    const versions = await import('../../../src/main/features/skills/version-store');
    const cognition = await import('../../../src/main/features/cognition');
    const first = await versions.appendFullSkillVersion(UID, 'skill-versioned', {
      operation: 'install',
      files: [
        { path: 'SKILL.md', content: '---\nname: skill-versioned\ndescription: first\n---\n' },
        { path: 'references/contract.md', content: 'first\n' },
      ],
      source: { kind: 'recall_asset', assetId: 'asset-a', assetVersion: '1' },
      security: { outcome: 'pass', findingCount: 0 },
    });
    const second = await versions.appendFullSkillVersion(UID, 'skill-versioned', {
      operation: 'upgrade',
      files: [
        { path: 'SKILL.md', content: '---\nname: skill-versioned\ndescription: second\n---\n' },
        { path: 'references/contract.md', content: 'first\n' },
        { path: 'references/example.md', content: 'new\n' },
      ],
      source: { kind: 'recall_asset', assetId: 'asset-a', assetVersion: '2' },
      security: { outcome: 'pass', findingCount: 0 },
      expectedCurrentRevisionId: first.revisionId,
    });

    await expect(cognition.getSkillCognitionSummary(UID, 'skill-versioned')).resolves.toMatchObject({
      version: '2',
      versions: [
        { version: '2', revisionId: second.revisionId, operation: 'upgrade', rollbackScope: 'full_tree', canRollback: true },
        { version: '1', revisionId: first.revisionId, operation: 'install', rollbackScope: 'full_tree', canRollback: true },
      ],
    });
    await expect(cognition.diffSkillCognitionVersions(UID, 'skill-versioned', '1', '2')).resolves.toMatchObject({
      added: 1, modified: 1, deleted: 0, unchanged: 1,
    });
    await expect(cognition.previewSkillCognitionRollback(UID, 'skill-versioned', '1')).resolves.toMatchObject({
      currentVersion: '2',
      currentRevisionId: second.revisionId,
      targetVersion: '1',
      targetRevisionId: first.revisionId,
      rollbackScope: 'full_tree',
      diff: { added: 0, modified: 1, deleted: 1, unchanged: 1 },
    });
  });

});
