import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recall-assets-')); previousRoot = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previousRoot; fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function modules() {
  const [candidates, assets] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
  ]);
  return { candidates, assets };
}

describe('Recall ability assets', () => {
  it('updates immutable-id assets with append-only snapshots and lifecycle audit events', async () => {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', { judgment: 'Keep decision records with evidence.', suggestedType: 'rule', suggestedScope: 'architecture', sourceRefs: [{ kind: 'execution', id: 'exec-a' }] });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id);

    const updated = await assets.updateAbilityAsset('user-a', asset.id, { statement: 'Keep architecture decision records with source evidence.', scope: 'architecture-review' });
    expect(updated.id).toBe(asset.id);
    expect(updated.version).toBe('2');
    expect(updated.statement).toContain('architecture decision');

    const paused = await assets.pauseAbilityAsset('user-a', asset.id, 'needs review');
    expect(paused.status).toBe('paused');
    const revoked = await assets.revokeAbilityAsset('user-a', asset.id, 'unsafe');
    expect(revoked.status).toBe('revoked');

    const versions = await assets.listAbilityAssetVersions('user-a', asset.id);
    expect(versions.map((entry) => entry.version)).toEqual(['1', '2']);
    expect(versions[0].snapshot.statement).toBe(asset.statement);
    expect(versions[1].snapshot.scope).toBe('architecture-review');

    const audit = await assets.listAbilityAssetAudit('user-a', asset.id);
    expect(audit.map((entry) => entry.action)).toEqual(['created', 'updated', 'paused', 'revoked']);
  });

  it('never changes asset ownership or accepts mutable identity fields', async () => {
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', { judgment: 'Prefer local evidence.', suggestedType: 'personal', suggestedScope: 'personal', sourceRefs: [{ kind: 'memory', id: 'mem-a' }] });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id);

    await expect(assets.updateAbilityAsset('user-a', asset.id, { id: 'aa-other' } as never)).rejects.toThrow(/identity/i);
    await expect(assets.readAbilityAsset('user-b', asset.id)).rejects.toThrow(/not found/i);
  });
});
