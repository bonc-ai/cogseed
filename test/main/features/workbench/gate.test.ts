import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const GATE = '../../../../src/main/features/workbench/gate';
const BASELINE = '../../../../src/main/features/workbench/main-skill-baseline';
const RECEIPT = '../../../../src/main/features/p3394/context-reuse-receipt';
const VALIDATION = '../../../../src/main/features/p3394/skill-validation-run';
const INVOCABILITY = '../../../../src/main/features/p3394/skill-invocability';
const PATHS = '../../../../src/main/paths';

const ASSET_ID = 'asset-cross-agent-continuity';

let uid = '';
beforeEach(() => { uid = `gate-${randomUUID()}`; });
afterEach(async () => {
  const { userRoot } = await import(PATHS);
  await fs.rm(userRoot(uid), { recursive: true, force: true });
});

async function makeSkillDir(): Promise<string> {
  const { userLocalRoot } = await import(PATHS);
  const dir = path.join(userLocalRoot(uid), ASSET_ID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: continuity\n---\nBaseline body.\n');
  return dir;
}

async function freeze(skillDir: string): Promise<string> {
  const mod = await import(BASELINE);
  const baseline = await mod.freezeBaseline(uid, {
    assetId: ASSET_ID,
    version: '1.0',
    skillDir,
    allowedRoots: [skillDir],
    source: 'workspace-builtin',
    evaluationContractRef: 'evaluation/contract-v1',
  });
  return baseline.baseline_id;
}

/** Prepare + complete a receipt at the requested boundary. */
async function makeReceipt(
  executionId: string,
  opts: { boundary?: 'real' | 'degraded' | 'test-double'; complete?: boolean } = {},
): Promise<string> {
  const mod = await import(RECEIPT);
  const targetSessionId = 'session-target-1';
  await mod.prepareReceipt(uid, {
    executionId,
    targetSessionId,
    reusedRefs: ['rule/delivery-format'],
    omittedRefs: ['rule/private-note'],
    permissionMode: 'ask',
    allowedScopes: ['workspace:delivery'],
    boundary: opts.boundary ?? 'real',
  }, { sessionId: targetSessionId });
  if (opts.complete !== false) {
    await mod.completeReceipt(uid, executionId, { status: 'completed' });
  }
  return executionId;
}

async function gateInput(over: Record<string, unknown> = {}) {
  const skillDir = await makeSkillDir();
  const baselineId = await freeze(skillDir);
  const receiptExecutionId = await makeReceipt(`run-${randomUUID()}`);
  return {
    baselineId,
    skillDir,
    allowedRoots: [skillDir],
    receiptExecutionId,
    ...over,
  };
}

describe('workspace gate — ready', () => {
  it('opens the workspace when all four conditions hold', async () => {
    const mod = await import(GATE);
    const input = await gateInput();

    const decision = await mod.evaluateWorkspaceGate(uid, input);

    expect(decision.status).toBe('ready');
    expect(decision.reasons).toEqual([]);
    expect(decision.baselineId).toBe(input.baselineId);
    expect(mod.isWorkspaceViewable(decision)).toBe(true);
  });

  it('stays ready when a validation exists and merely flags risk', async () => {
    const mod = await import(GATE);
    const validation = await import(VALIDATION);
    const input = await gateInput();

    await validation.validateSkillPatchContent(uid, ASSET_ID, '---\nname: continuity\n---\nbody\n');

    const decision = await mod.evaluateWorkspaceGate(uid, input);
    expect(decision.reasons).not.toContain('validation_blocked');
    expect(decision.status).toBe('ready');
    expect(decision.validationId).toBeTruthy();
  });
});

// PRD §8.2's third admission requirement. The gate consults it, but the three
// verdicts are not interchangeable: only `not_invocable` is evidence of a defect.
describe('workspace gate — invocability (PRD §8.2)', () => {
  it('blocks a baseline whose skill cannot be invoked', async () => {
    const mod = await import(GATE);
    const invocability = await import(INVOCABILITY);
    const input = await gateInput();

    // The baseline's skill dir is not a skill root, so the skill does not
    // resolve where the runtime would look for it.
    const run = await invocability.verifySkillInvocability(uid, ASSET_ID);
    expect(run.status).toBe('not_invocable');

    const decision = await mod.evaluateWorkspaceGate(uid, input);
    expect(decision.reasons).toContain('skill_not_invocable');
    expect(decision.status).toBe('blocked');
    expect(decision.invocabilityId).toBe(run.invocabilityId);
  }, 60_000);

  // Absent is not negative: invocability is a separate track, and a missing
  // record is not evidence the skill is broken.
  it('stays ready when no invocability record exists', async () => {
    const mod = await import(GATE);
    const input = await gateInput();

    const decision = await mod.evaluateWorkspaceGate(uid, input);
    expect(decision.reasons).not.toContain('skill_not_invocable');
    expect(decision.invocabilityId).toBeUndefined();
  }, 60_000);
});

describe('workspace gate — each condition blocks on its own', () => {
  it('blocks on baseline drift', async () => {
    const mod = await import(GATE);
    const input = await gateInput();

    await fs.writeFile(path.join(input.skillDir, 'SKILL.md'), '---\nname: continuity\n---\nMutated.\n');

    const decision = await mod.evaluateWorkspaceGate(uid, input);
    expect(decision.status).toBe('blocked');
    expect(decision.reasons).toContain('baseline_drift');
    expect(mod.isWorkspaceViewable(decision)).toBe(false);
  });

  it('blocks when no baseline was frozen', async () => {
    const mod = await import(GATE);
    const input = await gateInput({ baselineId: 'baseline-absent' });

    const decision = await mod.evaluateWorkspaceGate(uid, input);
    expect(decision.reasons).toContain('baseline_missing');
  });

  it('blocks when the receipt does not exist', async () => {
    const mod = await import(GATE);
    const input = await gateInput({ receiptExecutionId: 'run-never-created' });

    const decision = await mod.evaluateWorkspaceGate(uid, input);
    expect(decision.reasons).toContain('receipt_missing');
  });

  it('blocks while the receipt is still merely prepared', async () => {
    const mod = await import(GATE);
    const skillDir = await makeSkillDir();
    const baselineId = await freeze(skillDir);
    const receiptExecutionId = await makeReceipt(`run-${randomUUID()}`, { complete: false });

    const decision = await mod.evaluateWorkspaceGate(uid, {
      baselineId, skillDir, allowedRoots: [skillDir], receiptExecutionId,
    });
    expect(decision.reasons).toContain('receipt_not_completed');
  });

  it('blocks a test-double boundary even when the receipt completed', async () => {
    const mod = await import(GATE);
    const skillDir = await makeSkillDir();
    const baselineId = await freeze(skillDir);
    const receiptExecutionId = await makeReceipt(`run-${randomUUID()}`, { boundary: 'test-double' });

    const decision = await mod.evaluateWorkspaceGate(uid, {
      baselineId, skillDir, allowedRoots: [skillDir], receiptExecutionId,
    });
    expect(decision.status).toBe('blocked');
    expect(decision.reasons).toContain('receipt_not_real');
  });

  it('blocks a degraded boundary — a fallback run is not a shipped integration', async () => {
    const mod = await import(GATE);
    const skillDir = await makeSkillDir();
    const baselineId = await freeze(skillDir);
    const receiptExecutionId = await makeReceipt(`run-${randomUUID()}`, { boundary: 'degraded' });

    const decision = await mod.evaluateWorkspaceGate(uid, {
      baselineId, skillDir, allowedRoots: [skillDir], receiptExecutionId,
    });
    expect(decision.reasons).toContain('receipt_not_real');
  });

  it('blocks when the main skill validation verdict is blocked', async () => {
    const mod = await import(GATE);
    const validation = await import(VALIDATION);
    const input = await gateInput();

    // An EXTREME violation yields a `blocked` verdict.
    await validation.validateSkillPatchContent(
      uid, ASSET_ID, 'no frontmatter at all, which the validator rejects outright',
    );
    const latest = await validation.findLatestSkillValidation(uid, ASSET_ID);
    expect(latest?.status).toBe('blocked');

    const decision = await mod.evaluateWorkspaceGate(uid, input);
    expect(decision.status).toBe('blocked');
    expect(decision.reasons).toContain('validation_blocked');
  });
});

describe('workspace gate — reporting', () => {
  it('reports every gap at once rather than only the first', async () => {
    const mod = await import(GATE);
    const skillDir = await makeSkillDir();
    const baselineId = await freeze(skillDir);
    // Drifted baseline AND a non-real, still-prepared receipt.
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: continuity\n---\nMutated.\n');
    const receiptExecutionId = await makeReceipt(`run-${randomUUID()}`, {
      boundary: 'test-double', complete: false,
    });

    const decision = await mod.evaluateWorkspaceGate(uid, {
      baselineId, skillDir, allowedRoots: [skillDir], receiptExecutionId,
    });

    expect(decision.reasons).toEqual(expect.arrayContaining([
      'baseline_drift', 'receipt_not_completed', 'receipt_not_real',
    ]));
  });

  it('is a pure judgement — it neither repairs drift nor finalizes the receipt', async () => {
    const mod = await import(GATE);
    const baselineMod = await import(BASELINE);
    const receiptMod = await import(RECEIPT);
    const skillDir = await makeSkillDir();
    const baselineId = await freeze(skillDir);
    const frozenHash = (await baselineMod.readBaseline(uid, baselineId)).skill_ref.content_hash;
    const receiptExecutionId = await makeReceipt(`run-${randomUUID()}`, { complete: false });

    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: continuity\n---\nMutated.\n');
    await mod.evaluateWorkspaceGate(uid, {
      baselineId, skillDir, allowedRoots: [skillDir], receiptExecutionId,
    });

    // Baseline digest untouched, receipt still awaiting its real completion.
    expect((await baselineMod.readBaseline(uid, baselineId)).skill_ref.content_hash).toBe(frozenHash);
    expect((await receiptMod.readReceipt(uid, receiptExecutionId)).status).toBe('prepared');
  });

  it('rejects a malformed baseline id', async () => {
    const mod = await import(GATE);
    const input = await gateInput();
    await expect(mod.evaluateWorkspaceGate(uid, { ...input, baselineId: '../escape' }))
      .rejects.toThrow(/invalid baseline id/);
  });
});
