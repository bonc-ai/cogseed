import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recall-source-control-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets, controls] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/source-control'),
  ]);
  return { candidates, assets, controls };
}

const conversationSource = {
  kind: 'conversation' as const,
  subtype: 'session' as const,
  scope: 'conversation' as const,
  id: 'conv-a',
  title: 'Architecture review',
};

describe('Recall source controls', () => {
  it('persists pause, resume, removal, and reconnection without deleting the source', async () => {
    const { controls } = await modules();

    const paused = await controls.pauseCognitionSource('user-a', conversationSource as any);
    expect(paused.availability).toBe('paused');
    expect(await controls.isCognitionSourceEnabled('user-a', conversationSource)).toBe(false);

    vi.resetModules();
    const reloaded = await import('../../../../src/main/features/recall/source-control');
    expect(await reloaded.readCognitionSourceControl('user-a', conversationSource)).toMatchObject({
      availability: 'paused',
      title: 'Architecture review',
    });

    await reloaded.resumeCognitionSource('user-a', conversationSource as any);
    expect(await reloaded.isCognitionSourceEnabled('user-a', conversationSource)).toBe(true);

    const removed = await reloaded.removeCognitionSource('user-a', conversationSource as any, false);
    expect(removed.control.availability).toBe('removed');
    expect(removed.revokedAssetIds).toEqual([]);
    expect(await reloaded.isCognitionSourceEnabled('user-a', conversationSource)).toBe(false);

    await reloaded.reconnectCognitionSource('user-a', conversationSource as any);
    expect(await reloaded.isCognitionSourceEnabled('user-a', conversationSource)).toBe(true);
  });

  it('previews affected assets and revokes only matching assets after explicit confirmation', async () => {
    const { candidates, assets, controls } = await modules();
    const matchingCandidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Record architecture decisions.',
      suggestedType: 'rule',
      suggestedScope: 'architecture',
      sourceRefs: [conversationSource],
    });
    const otherCandidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Prefer concise status reports.',
      suggestedType: 'personal',
      suggestedScope: 'global',
      sourceRefs: [{ kind: 'conversation', subtype: 'session', id: 'conv-b' }],
    });
    const matchingAsset = (await candidates.promoteRecallCandidate('user-a', matchingCandidate.id)).asset;
    const otherAsset = (await candidates.promoteRecallCandidate('user-a', otherCandidate.id)).asset;

    await expect(controls.previewCognitionSourceRemoval('user-a', conversationSource as any)).resolves.toEqual({
      affectedAssetCount: 1,
      revocableAssetCount: 1,
    });

    const result = await controls.removeCognitionSource('user-a', conversationSource as any, true);
    expect(result.affectedAssetIds).toEqual([matchingAsset.id]);
    expect(result.revokedAssetIds).toEqual([matchingAsset.id]);
    expect(result.failedAssetIds).toEqual([]);
    await expect(assets.readAbilityAsset('user-a', matchingAsset.id)).resolves.toMatchObject({ status: 'revoked' });
    await expect(assets.readAbilityAsset('user-a', otherAsset.id)).resolves.toMatchObject({ status: 'active' });
  });
});
