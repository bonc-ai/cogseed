import { describe, expect, it } from 'vitest';

import {
  assertAbilityAssetId,
  createAbilityAsset,
  recommendAbilityAssetAction,
  setAbilityAssetStatus,
  updateAbilityAsset,
  type AbilityAssetScope,
  type CreateAbilityAssetInput,
} from '../../../../src/main/features/p3394/ability-assets';

const CREATED_AT = '2026-08-05T10:00:00';
const UPDATED_AT = '2026-08-05T10:15:00';
const SECOND_UPDATE_AT = '2026-08-05T10:30:00';

function baseScope(): AbilityAssetScope {
  return {
    purpose_tags: ['planning', 'review'],
    agent_ids: ['agent-1'],
    role_ids: ['reviewer'],
    project_ids: ['project-1'],
    workspace_ids: ['workspace-1'],
    conversation_kinds: ['group_chat'],
    file_kinds: ['markdown'],
  };
}

function baseInput(overrides: Partial<CreateAbilityAssetInput> = {}): CreateAbilityAssetInput {
  return {
    id: 'asset-1',
    sourceCandidateId: 'candidate-1',
    sourceRunId: 'run-1',
    type: 'template',
    capabilityStatement: 'Review the plan before implementation.',
    scope: baseScope(),
    evidenceRefs: [
      { kind: 'candidate', id: 'candidate-1' },
      { kind: 'episode', id: 'episode-1' },
    ],
    workspaceRefs: [{ workspace_id: 'workspace-1', enabled: true }],
    actor: { by: 'user', id: 'user-1' },
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe('P3394 AbilityAsset domain', () => {
  it('creates one seed active asset from an approved candidate input', () => {
    const input = baseInput();

    const asset = createAbilityAsset(input);

    expect(asset).toEqual({
      id: 'asset-1',
      source_candidate_id: 'candidate-1',
      source_run_id: 'run-1',
      type: 'template',
      capability_statement: 'Review the plan before implementation.',
      scope: baseScope(),
      evidence_refs: [
        { kind: 'candidate', id: 'candidate-1' },
        { kind: 'episode', id: 'episode-1' },
      ],
      workspace_refs: [{ workspace_id: 'workspace-1', enabled: true }],
      status: 'active',
      maturity: 'seed',
      version: 1,
      versions: [{
        version: 1,
        statement: 'Review the plan before implementation.',
        scope: baseScope(),
        changed_at: CREATED_AT,
        reason: 'candidate_approved',
      }],
      audit: [{ action: 'candidate_approved', at: CREATED_AT, by: 'user' }],
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    });
    expect(asset.scope).not.toBe(input.scope);
    expect(asset.versions[0].scope).not.toBe(asset.scope);
  });

  it('rejects system-created candidate approval', () => {
    expect(() => createAbilityAsset(baseInput({
      actor: { by: 'system', id: 'policy-1' },
    }))).toThrow(/user/i);
  });

  it('rejects empty capability statements and invalid scope ids', () => {
    expect(() => createAbilityAsset(baseInput({ capabilityStatement: '   ' })))
      .toThrow(/capability statement/i);

    for (const field of ['agent_ids', 'role_ids', 'project_ids', 'workspace_ids'] as const) {
      expect(() => createAbilityAsset(baseInput({
        scope: { ...baseScope(), [field]: ['../escape'] },
      }))).toThrow(/invalid scope .* id/i);
    }

    expect(() => assertAbilityAssetId('../asset-1')).toThrow(/invalid ability asset id/i);
    expect(() => assertAbilityAssetId('asset_1-safe')).not.toThrow();
  });

  it('updates an asset by appending version history instead of mutating prior versions', () => {
    const asset = createAbilityAsset(baseInput());
    const original = structuredClone(asset);
    const updatedScope: AbilityAssetScope = {
      purpose_tags: ['implementation'],
      project_ids: ['project-2'],
      workspace_ids: ['workspace-2'],
    };

    const updated = updateAbilityAsset(asset, {
      capabilityStatement: 'Validate the plan before implementation.',
      scope: updatedScope,
      reason: 'Clarify the validation requirement.',
      actor: { by: 'user', id: 'user-1' },
      at: UPDATED_AT,
    });

    expect(asset).toEqual(original);
    expect(updated).not.toBe(asset);
    expect(updated).toMatchObject({
      capability_statement: 'Validate the plan before implementation.',
      scope: updatedScope,
      status: 'active',
      maturity: 'seed',
      version: 2,
      updated_at: UPDATED_AT,
    });
    expect(updated.versions).toEqual([
      original.versions[0],
      {
        version: 2,
        statement: 'Validate the plan before implementation.',
        scope: updatedScope,
        changed_at: UPDATED_AT,
        reason: 'Clarify the validation requirement.',
      },
    ]);
    expect(updated.audit.at(-1)).toEqual({ action: 'asset_updated', at: UPDATED_AT, by: 'user' });
    expect(updated.scope).not.toBe(updatedScope);
    expect(updated.versions[1].scope).not.toBe(updated.scope);
  });

  it('allows active to paused and paused to active transitions', () => {
    const active = createAbilityAsset(baseInput());

    const paused = setAbilityAssetStatus(active, 'paused', { by: 'user', id: 'user-1' }, UPDATED_AT);
    const reactivated = setAbilityAssetStatus(paused, 'active', { by: 'user', id: 'user-1' }, SECOND_UPDATE_AT);

    expect(active.status).toBe('active');
    expect(paused).toMatchObject({ status: 'paused', updated_at: UPDATED_AT });
    expect(paused.audit.at(-1)).toEqual({ action: 'asset_paused', at: UPDATED_AT, by: 'user' });
    expect(reactivated).toMatchObject({ status: 'active', updated_at: SECOND_UPDATE_AT });
    expect(reactivated.audit.at(-1)).toEqual({ action: 'asset_activated', at: SECOND_UPDATE_AT, by: 'user' });
  });

  it('rejects system actors for every status transition', () => {
    const active = createAbilityAsset(baseInput());
    const paused = setAbilityAssetStatus(active, 'paused', { by: 'user' }, UPDATED_AT);

    expect(() => setAbilityAssetStatus(active, 'paused', { by: 'system' }, UPDATED_AT))
      .toThrow(/user/i);
    expect(() => setAbilityAssetStatus(paused, 'active', { by: 'system' }, SECOND_UPDATE_AT))
      .toThrow(/user/i);
    expect(() => setAbilityAssetStatus(active, 'revoked', { by: 'system' }, UPDATED_AT))
      .toThrow(/user/i);
    expect(() => setAbilityAssetStatus(paused, 'revoked', { by: 'system' }, SECOND_UPDATE_AT))
      .toThrow(/user/i);
  });

  it('allows active/paused to revoked but never revokes by recommendation alone', () => {
    const active = createAbilityAsset(baseInput());
    const paused = setAbilityAssetStatus(active, 'paused', { by: 'user' }, UPDATED_AT);

    const activeRecommendation = recommendAbilityAssetAction(active, 'pause', { by: 'system' }, UPDATED_AT);
    const pausedRecommendation = recommendAbilityAssetAction(paused, 'rework', { by: 'user' }, SECOND_UPDATE_AT);
    const revokedFromActive = setAbilityAssetStatus(active, 'revoked', { by: 'user' }, UPDATED_AT);
    const revokedFromPaused = setAbilityAssetStatus(paused, 'revoked', { by: 'user' }, SECOND_UPDATE_AT);

    expect(activeRecommendation.status).toBe('active');
    expect(pausedRecommendation.status).toBe('paused');
    expect(revokedFromActive.status).toBe('revoked');
    expect(revokedFromPaused.status).toBe('revoked');
    expect(revokedFromActive.audit.at(-1)).toEqual({ action: 'asset_revoked', at: UPDATED_AT, by: 'user' });
    expect(() => setAbilityAssetStatus(revokedFromActive, 'active', { by: 'user' }, SECOND_UPDATE_AT))
      .toThrow(/revoked/i);
  });

  it('records pause/rework recommendations without changing asset status', () => {
    const asset = createAbilityAsset(baseInput());

    const pauseRecommended = recommendAbilityAssetAction(asset, 'pause', { by: 'system', id: 'policy-1' }, UPDATED_AT);
    const reworkRecommended = recommendAbilityAssetAction(pauseRecommended, 'rework', { by: 'user', id: 'user-1' }, SECOND_UPDATE_AT);

    expect(asset.recommended_action).toBeUndefined();
    expect(pauseRecommended).toMatchObject({
      status: 'active',
      maturity: 'seed',
      version: 1,
      recommended_action: 'pause',
      updated_at: UPDATED_AT,
    });
    expect(pauseRecommended.audit.at(-1)).toEqual({ action: 'pause_recommended', at: UPDATED_AT, by: 'system' });
    expect(reworkRecommended).toMatchObject({
      status: 'active',
      maturity: 'seed',
      version: 1,
      recommended_action: 'rework',
      updated_at: SECOND_UPDATE_AT,
    });
    expect(reworkRecommended.audit.at(-1)).toEqual({ action: 'rework_recommended', at: SECOND_UPDATE_AT, by: 'user' });
  });

  it('rejects system rework recommendations', () => {
    const asset = createAbilityAsset(baseInput());

    expect(() => recommendAbilityAssetAction(
      asset,
      'rework',
      { by: 'system', id: 'policy-1' },
      UPDATED_AT,
    )).toThrow(/user/i);
  });
});
