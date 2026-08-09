import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const MOD = '../../../../src/main/features/workbench/main-skill-baseline';
const PATHS = '../../../../src/main/paths';

let uid = '';
beforeEach(() => { uid = `baseline-${randomUUID()}`; });
afterEach(async () => {
  const { userRoot } = await import(PATHS);
  await fs.rm(userRoot(uid), { recursive: true, force: true });
});

/** Materialize a skill tree inside the user's local root so it is sandbox-legal. */
async function makeSkillDir(name = 'main-skill', body = 'Baseline body.\n'): Promise<string> {
  const { userLocalRoot } = await import(PATHS);
  const dir = path.join(userLocalRoot(uid), name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: baseline fixture\n---\n${body}`,
  );
  return dir;
}

const freezeInput = (skillDir: string, over: Record<string, unknown> = {}) => ({
  assetId: 'asset-cross-agent-continuity',
  version: '1.0',
  skillDir,
  allowedRoots: [skillDir],
  source: 'workspace-builtin' as const,
  ...over,
});

describe('main skill baseline — freeze', () => {
  it('freezes an asset reference with a content digest and user provenance', async () => {
    const mod = await import(MOD);
    const skillDir = await makeSkillDir();

    const baseline = await mod.freezeBaseline(uid, freezeInput(skillDir, {
      actionPlanRef: 'plan/continuity-v1',
      ontologyBindingRef: 'ontology/delivery-v1',
      evaluationContractRef: 'evaluation/contract-v1',
    }));

    expect(baseline.skill_ref.asset_id).toBe('asset-cross-agent-continuity');
    expect(baseline.skill_ref.version).toBe('1.0');
    expect(baseline.skill_ref.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(baseline.source).toBe('workspace-builtin');
    expect(baseline.action_plan_ref).toBe('plan/continuity-v1');
    expect(baseline.evaluation_contract_ref).toBe('evaluation/contract-v1');
    // Agents must never author a formal asset (RG-S3-13).
    expect(baseline.frozen_by).toBe('user');

    // Round-trips through disk with identical values.
    await expect(mod.readBaseline(uid, baseline.baseline_id)).resolves.toEqual(baseline);
  });

  it('refuses to overwrite an existing baseline so a frozen episode stays immutable', async () => {
    const mod = await import(MOD);
    const skillDir = await makeSkillDir();
    const first = await mod.freezeBaseline(uid, freezeInput(skillDir));

    await expect(
      mod.freezeBaseline(uid, freezeInput(skillDir, { baselineId: first.baseline_id, version: '2.0' })),
    ).rejects.toThrow(/already exists/);

    // The original pin survived the rejected re-freeze.
    const stored = await mod.readBaseline(uid, first.baseline_id);
    expect(stored.skill_ref.version).toBe('1.0');
  });

  it('rejects a source outside the closed US-11 set', async () => {
    const mod = await import(MOD);
    const skillDir = await makeSkillDir();
    await expect(
      mod.freezeBaseline(uid, freezeInput(skillDir, { source: 'agent-invented' })),
    ).rejects.toThrow(/invalid baseline source/);
  });

  it('rejects a skill directory outside the allowed roots', async () => {
    const mod = await import(MOD);
    const skillDir = await makeSkillDir();
    await expect(
      mod.freezeBaseline(uid, freezeInput(skillDir, { allowedRoots: [path.join(skillDir, 'nested-only')] })),
    ).rejects.toThrow(/outside allowed roots/);
  });

  it('refuses to freeze an unhashable tree instead of persisting an empty digest', async () => {
    const mod = await import(MOD);
    const { userLocalRoot } = await import(PATHS);
    const missing = path.join(userLocalRoot(uid), 'never-created');
    await expect(
      mod.freezeBaseline(uid, freezeInput(missing, { allowedRoots: [userLocalRoot(uid)] })),
    ).rejects.toThrow(/unreadable or empty/);
  });

  it('rejects a malformed asset version', async () => {
    const mod = await import(MOD);
    const skillDir = await makeSkillDir();
    await expect(
      mod.freezeBaseline(uid, freezeInput(skillDir, { version: '../escape' })),
    ).rejects.toThrow(/invalid asset version/);
  });
});

describe('main skill baseline — verify', () => {
  it('passes when the skill tree is byte-identical', async () => {
    const mod = await import(MOD);
    const skillDir = await makeSkillDir();
    const baseline = await mod.freezeBaseline(uid, freezeInput(skillDir));

    await expect(mod.verifyBaseline(uid, baseline.baseline_id, skillDir, [skillDir]))
      .resolves.toEqual({ ok: true });
  });

  it('reports drift when skill content changes, and does not auto-refreeze', async () => {
    const mod = await import(MOD);
    const skillDir = await makeSkillDir();
    const baseline = await mod.freezeBaseline(uid, freezeInput(skillDir));
    const frozenHash = baseline.skill_ref.content_hash;

    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: main-skill\n---\nMutated body.\n');

    await expect(mod.verifyBaseline(uid, baseline.baseline_id, skillDir, [skillDir]))
      .resolves.toEqual({ ok: false, reason: 'drift' });

    // The stored digest must still be the ORIGINAL one: a drift check never
    // silently re-pins the baseline.
    const stored = await mod.readBaseline(uid, baseline.baseline_id);
    expect(stored.skill_ref.content_hash).toBe(frozenHash);
  });

  it('detects drift from an added content file, not just an edited one', async () => {
    const mod = await import(MOD);
    const skillDir = await makeSkillDir();
    const baseline = await mod.freezeBaseline(uid, freezeInput(skillDir));

    await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(skillDir, 'scripts', 'run.py'), 'print("added")\n');

    await expect(mod.verifyBaseline(uid, baseline.baseline_id, skillDir, [skillDir]))
      .resolves.toEqual({ ok: false, reason: 'drift' });
  });

  it('ignores volatile OS and install files so they cannot masquerade as drift', async () => {
    const mod = await import(MOD);
    const skillDir = await makeSkillDir();
    const baseline = await mod.freezeBaseline(uid, freezeInput(skillDir));

    await fs.writeFile(path.join(skillDir, '.DS_Store'), 'finder noise');
    await fs.writeFile(path.join(skillDir, '_install.json'), '{"installedAt":"now"}');

    await expect(mod.verifyBaseline(uid, baseline.baseline_id, skillDir, [skillDir]))
      .resolves.toEqual({ ok: true });
  });

  it('reports unreadable when the tree is gone rather than passing vacuously', async () => {
    const mod = await import(MOD);
    const skillDir = await makeSkillDir();
    const baseline = await mod.freezeBaseline(uid, freezeInput(skillDir));

    await fs.rm(skillDir, { recursive: true, force: true });

    await expect(mod.verifyBaseline(uid, baseline.baseline_id, skillDir, [skillDir]))
      .resolves.toEqual({ ok: false, reason: 'unreadable' });
  });

  it('reports not_found for an unknown baseline', async () => {
    const mod = await import(MOD);
    const skillDir = await makeSkillDir();
    await expect(mod.verifyBaseline(uid, 'baseline-absent', skillDir, [skillDir]))
      .resolves.toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('main skill baseline — list', () => {
  it('returns an empty list before any baseline exists', async () => {
    const mod = await import(MOD);
    await expect(mod.listBaselines(uid)).resolves.toEqual([]);
  });

  it('lists newest first and skips malformed records', async () => {
    const mod = await import(MOD);
    const { userLocalRoot } = await import(PATHS);
    const dirA = await makeSkillDir('skill-a', 'A body\n');
    const dirB = await makeSkillDir('skill-b', 'B body\n');

    const first = await mod.freezeBaseline(uid, freezeInput(dirA, {
      baselineId: 'baseline-older', assetId: 'asset-a',
    }));
    // Distinct frozen_at so ordering is deterministic rather than tie-broken.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await mod.freezeBaseline(uid, freezeInput(dirB, {
      baselineId: 'baseline-newer', assetId: 'asset-b', source: 'external-admitted',
    }));

    await fs.writeFile(
      path.join(userLocalRoot(uid), 'kstar', 'baselines', 'baseline-broken.json'),
      '{ not json',
    );

    const rows = await mod.listBaselines(uid);
    expect(rows.map((row: { baseline_id: string }) => row.baseline_id))
      .toEqual([second.baseline_id, first.baseline_id]);
  });
});
