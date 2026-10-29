import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
/** Promotion must preserve the complete body or reject explicitly; it never slices. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  },
  embedTexts: async (texts: string[]) => texts.map((text) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  }),
}));

const UID = 'promotion-limit-user';
let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-promotion-content-limit-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function service() {
  return import('../../../../src/main/features/recall/candidate-service');
}

function candidateFile(candidateId: string): string {
  return path.join(tmpDir, UID, 'cloud', 'recall', 'records', 'candidates', `${candidateId}.json`);
}

async function seeded(summary: string) {
  return createNightlyCandidateFixture(UID, {
    judgment: `晋升正文：${summary}。`,
    summary,
    value: `晋升用途：${summary}。`,
    suggestedType: 'cognition',
    suggestedScope: 'project',
    sourceRefs: [{ kind: 'conversation', id: `conv-${summary}` }],
  });
}

describe('晋升内容契约', () => {
  it('4001 字存量候选被明确拒绝，候选保持原状且不产生资产', async () => {
    const candidates = await service();
    const created = await seeded('超长晋升');
    const initialStatus = (await candidates.readRecallCandidate(UID, created.id)).status;
    const file = candidateFile(created.id);
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    record.judgment = 'x'.repeat(4_001);
    fs.writeFileSync(file, JSON.stringify(record));

    await expect(candidates.promoteRecallCandidate(UID, created.id, { actor: 'user', forceCreateSimilar: true }))
      .rejects.toMatchObject({ code: 'recall_candidate_content_too_long' });

    const after = await candidates.readRecallCandidate(UID, created.id);
    expect(after.status).toBe(initialStatus);
    expect(after.promotedAssetId).toBeUndefined();
    expect(after.reviewDecisionId).toBeUndefined();
    expect(after.judgment).toHaveLength(4_001);

    const assets = await import('../../../../src/main/features/recall/asset-service');
    expect(await assets.listAbilityAssets(UID)).toHaveLength(0);
    const versionDir = path.join(tmpDir, UID, 'cloud', 'recall', 'jsonl', 'ability-asset-versions');
    expect(fs.existsSync(versionDir) ? fs.readdirSync(versionDir) : []).toEqual([]);
  });

  it('恰好 4000 字正文从候选到资产、版本与派发提示块完整保留', async () => {
    const candidates = await service();
    const tail = '完整正文末尾标记ABCD';
    const statement = '乙'.repeat(4_000 - tail.length) + tail;
    expect(statement).toHaveLength(4_000);
    const created = await createNightlyCandidateFixture(UID, {
      judgment: statement,
      summary: '完整正文晋升',
      value: '验证完整正文不被截断。',
      suggestedType: 'cognition',
      suggestedScope: 'project',
      sourceRefs: [{ kind: 'conversation', id: 'conv-full-body' }],
    });
    expect(created.judgment).toHaveLength(4_000);

    const promoted = await candidates.promoteRecallCandidate(UID, created.id, { actor: 'user', forceCreateSimilar: true });
    expect(promoted.asset.statement).toBe(statement);
    expect(promoted.asset.statement).toHaveLength(4_000);

    const assets = await import('../../../../src/main/features/recall/asset-service');
    const versions = await assets.listAbilityAssetVersions(UID, promoted.asset.id);
    expect(versions.at(-1)?.snapshot.statement).toBe(statement);

    const promptInjection = await import('../../../../src/main/features/recall/prompt-injection');
    const dispatched = await promptInjection.buildDispatchedAssetsPromptBlock(UID, [promoted.asset.id]);
    expect(dispatched.promptBlock).toContain(tail);
    expect(dispatched.assets).toEqual([{ id: promoted.asset.id, version: promoted.asset.version }]);
  });
});
