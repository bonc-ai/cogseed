import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { buildCreatorCapabilityCatalog, type CreatorCapabilityDescriptor } from '../../../../src/main/features/creator/catalog';
import {
  CreatorProposalError,
  proposeCreatorPreset,
} from '../../../../src/main/features/creator/proposal-service';
import type { CreatorPresetDraft } from '../../../../src/main/features/creator/store';

const fixtureRoot = path.resolve(process.cwd(), 'test/fixtures/creator/proposals');
const fixture = (name: string): string => fs.readFileSync(path.join(fixtureRoot, name), 'utf8');

function catalog(): CreatorCapabilityDescriptor[] {
  return [
    {
      capabilityId: 'model.provider-main.deepseek-chat', version: '1', kind: 'model',
      displayName: 'Configured model', available: true, permissions: ['cost'],
      sourceRef: 'provider.provider-main', health: 'ready',
    },
    {
      capabilityId: 'tool.search', version: '1', kind: 'tool', displayName: 'Search',
      available: true, permissions: ['read'], sourceRef: 'agent-capability.search', health: 'ready',
    },
  ];
}

function dependencies(output: string) {
  const runModel = vi.fn(async () => output);
  const saveDraft = vi.fn(async (_userId: string, draft: CreatorPresetDraft) => draft);
  return {
    runModel,
    saveDraft,
    buildCatalog: vi.fn(async () => catalog()),
    getLocale: vi.fn((_userId: string) => 'en'),
    now: () => '2026-08-21T00:00:00.000Z',
    createId: () => 'proposal-0001',
  };
}

async function expectProposalError(promise: Promise<unknown>, code: string): Promise<CreatorProposalError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CreatorProposalError);
    expect((error as Error).message).toBe(code);
    return error as CreatorProposalError;
  }
  throw new Error('expected proposal to reject');
}

describe('Creator proposal service', () => {
  it('rejects oversized model output before parsing or exposing it', async () => {
    const deps = dependencies('x'.repeat(200_000));
    await expectProposalError(
      proposeCreatorPreset('user-1', { goal: 'Create a research agent', sourceSessionId: 'source-session' }, deps),
      'creator_proposal_invalid_output',
    );
    expect(deps.saveDraft).not.toHaveBeenCalled();
  });

  it('rejects deeply nested model output before recursive inspection overflows', async () => {
    const deep = `${'{"x":'.repeat(2_000)}null${'}'.repeat(2_000)}`;
    const deps = dependencies(deep);
    await expectProposalError(
      proposeCreatorPreset('user-1', { goal: 'Create a research agent', sourceSessionId: 'source-session' }, deps),
      'creator_proposal_invalid_output',
    );
    expect(deps.saveDraft).not.toHaveBeenCalled();
  });

  it('does not expose sensitive or oversized model-controlled object keys in issues', async () => {
    const sensitiveKeys = [
      'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      'ssh://private.internal/model',
      '/opt/private/catalog-secret',
      'x'.repeat(500),
    ];
    for (const key of sensitiveKeys) {
      const output = JSON.stringify({
        schemaVersion: 1,
        [key]: 'attacker-controlled value',
      });
      const error = await expectProposalError(
        proposeCreatorPreset('user-1', { goal: 'Create a research agent', sourceSessionId: 'source-session' }, dependencies(output)),
        'creator_proposal_invalid_output',
      );
      expect(JSON.stringify(error.issues)).not.toContain(key);
      expect(JSON.stringify(error)).not.toContain(key);
    }
  });
  it('replaces raw catalog dependency failures without logging sensitive details', async () => {
    const secrets = [
      '/opt/private/proposal-source',
      'C:\\private\\proposal-source',
      'custom+scheme://private.internal/proposal',
      'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    ];
    const deps = dependencies(fixture('valid-local-agent.json'));
    deps.buildCatalog.mockRejectedValue(new Error(`catalog failed: ${secrets.join(' ')}`));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const failure = await expectProposalError(
        proposeCreatorPreset('user-1', { goal: 'Create a research agent', sourceSessionId: 'source-session' }, deps),
        'creator_proposal_dependency_failed',
      );
      const exposed = [
        failure.stack ?? '',
        JSON.stringify(consoleError.mock.calls),
        JSON.stringify(consoleWarn.mock.calls),
      ].join('\n');
      for (const secret of secrets) expect(exposed).not.toContain(secret);
      expect(deps.runModel).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it('keeps the static prompt generic with one trailing runtime injection section', () => {
    const prompt = fs.readFileSync(path.resolve(process.cwd(), 'src/main/prompts/creator_preset.md'), 'utf8');
    expect(prompt.match(/^## Runtime injection$/gm)).toHaveLength(1);
    expect(prompt.trimEnd().endsWith('## Runtime injection')).toBe(true);
    expect(prompt).not.toMatch(/CogSeed|Codex|Hermes|Claude|OpenAI/i);
    expect(prompt).not.toMatch(/(?:^|\s)(?:\/Users\/|[A-Za-z]:\\)|src\/main|data\//i);
    expect(prompt).not.toMatch(/tool\.[A-Za-z0-9_-]+/);
  });

  it.each([
    ['plain JSON', (json: string) => json],
    ['one fenced JSON object', (json: string) => `\`\`\`json\n${json}\n\`\`\``],
    ['one JSON object surrounded by prose', (json: string) => `Here is the proposal.\n${json}\nPlease review it.`],
  ])('accepts %s, resolves the catalog, and saves only a draft', async (_name, wrap) => {
    const deps = dependencies(wrap(fixture('valid-local-agent.json')));

    const result = await proposeCreatorPreset('user-1', {
      goal: 'Create a read-only research collaborator.\u0000',
      sourceSessionId: 'trusted-source-session',
    }, deps);

    expect(result.issues).toEqual([]);
    expect(result.draft).toMatchObject({
      schemaVersion: 1,
      draftId: 'draft-proposal-0001',
      updatedAt: '2026-08-21T00:00:00.000Z',
      manifest: {
        presetId: 'local-research',
        provenance: {
          createdBy: 'creator-agent',
          sourceSessionId: 'trusted-source-session',
          sourceAssetRefs: [],
        },
      },
    });
    expect(deps.saveDraft).toHaveBeenCalledTimes(1);
    expect(deps.saveDraft).toHaveBeenCalledWith('user-1', result.draft);

    const call = deps.runModel.mock.calls[0]?.[0];
    expect(Object.keys(call).sort()).toEqual(['message', 'systemPrompt']);
    expect(call.systemPrompt.match(/## Runtime injection/g)).toHaveLength(1);
    expect(call.systemPrompt).toContain('tool.search');
    expect(call.systemPrompt).toContain('Create a read-only research collaborator.');
    expect(call.systemPrompt).not.toContain('\u0000');
    expect(call.systemPrompt).not.toMatch(/\/Users\/|api.?key|authorization|base.?url/i);
    expect(deps.getLocale).toHaveBeenCalledWith('user-1');
  });

  it('creates a local CogSeed agent draft from the local catalog', async () => {
    const deps = dependencies(fixture('valid-cogseed-agent.json'));

    const result = await proposeCreatorPreset('user-1', {
      goal: 'Create a local read-only research agent.',
      sourceSessionId: 'trusted-source-session',
    }, deps);

    expect(result.draft.manifest).toMatchObject({
      presetId: 'local-research',
      presetType: 'cogseed-agent',
      permissions: { files: ['workspace.readonly'] },
    });
    expect(deps.saveDraft).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['empty output', '', 'creator_proposal_invalid_output'],
    ['array root', `[${fixture('valid-local-agent.json')}]`, 'creator_proposal_invalid_output'],
    ['duplicate JSON objects', `${fixture('valid-local-agent.json')}\n${fixture('valid-local-agent.json')}`, 'creator_proposal_multiple_objects'],
    ['unknown field', fixture('valid-local-agent.json').replace('"schemaVersion": 1,', '"schemaVersion": 1, "unexpected": true,'), 'creator_proposal_invalid_output'],
    ['URL in an allowed string field', fixture('rejected-url.json'), 'creator_proposal_invalid_output'],
    ['secret-looking value in an allowed string field', fixture('rejected-secret.json'), 'creator_proposal_invalid_output'],
  ])('rejects %s without saving', async (_name, output, expectedCode) => {
    const deps = dependencies(output);
    await expectProposalError(
      proposeCreatorPreset('user-1', { goal: 'Create a research agent', sourceSessionId: 'source-session' }, deps),
      expectedCode,
    );
    expect(deps.saveDraft).not.toHaveBeenCalled();
  });

  it('rejects forbidden URLs even when they appear only in surrounding prose', async () => {
    const deps = dependencies(`See https://outside.invalid/context\n${fixture('valid-local-agent.json')}`);
    await expectProposalError(
      proposeCreatorPreset('user-1', { goal: 'Create a research agent', sourceSessionId: 'source-session' }, deps),
      'creator_proposal_invalid_output',
    );
    expect(deps.saveDraft).not.toHaveBeenCalled();
  });

  it('replaces model-authored provenance with trusted proposal provenance', async () => {
    const output = fixture('valid-local-agent.json')
      .replace('"sourceAssetRefs": []', '"sourceAssetRefs": ["asset.untrusted"], "verificationRunId": "run-untrusted"');
    const deps = dependencies(output);

    const result = await proposeCreatorPreset('user-1', {
      goal: 'Create a research agent', sourceSessionId: 'trusted-session',
    }, deps);

    expect(result.draft.manifest.provenance).toEqual({
      createdBy: 'creator-agent',
      sourceSessionId: 'trusted-session',
      sourceAssetRefs: [],
    });
  });

  it('resolves model selections with punctuation through the same catalog-id encoder', async () => {
    const specialCatalog = await buildCreatorCapabilityCatalog('user-1', {
      getActiveUserId: () => 'user-1',
      listProviders: async () => ({ providers: [{ id: 'provider.main', label: 'Main', profiles: [{}] }] as never[] }),
      listModels: async () => ({ models: [{ id: 'model.chat', name: 'Chat' }] }),
      listSkills: async () => [],
    });
    const output = fixture('valid-local-agent.json')
      .replace('"provider-main"', '"provider.main"')
      .replace('"deepseek-chat"', '"model.chat"')
    const deps = dependencies(output);
    deps.buildCatalog.mockResolvedValue([
      ...specialCatalog,
      catalog().find((item) => item.capabilityId === 'tool.search')!,
    ]);

    const result = await proposeCreatorPreset('user-1', {
      goal: 'Create a local research agent', sourceSessionId: 'source-session',
    }, deps);

    expect(result.draft.manifest.model).toMatchObject({ providerId: 'provider.main', modelId: 'model.chat' });
  });

  it('rejects capabilities and model selections outside the current catalog', async () => {
    const output = fixture('valid-local-agent.json')
      .replace('"deepseek-chat"', '"unregistered-model"')
      .replace('"tool.search", "version": "1"', '"tool.admin", "version": "1"');
    const deps = dependencies(output);

    const error = await expectProposalError(
      proposeCreatorPreset('user-1', { goal: 'Create a research agent', sourceSessionId: 'source-session' }, deps),
      'creator_proposal_catalog_mismatch',
    );
    expect(error.issues.map((issue) => issue.path)).toContain('model');
    expect(deps.saveDraft).not.toHaveBeenCalled();
  });

  it('rejects unavailable catalog capabilities', async () => {
    const deps = dependencies(fixture('valid-local-agent.json'));
    deps.buildCatalog.mockResolvedValue([{
      capabilityId: 'tool.search', version: '1', kind: 'tool', displayName: 'Search',
      available: false, permissions: ['read'], sourceRef: 'agent-capability.search', health: 'unavailable',
    }]);

    const error = await expectProposalError(
      proposeCreatorPreset('user-1', { goal: 'Create a research agent', sourceSessionId: 'source-session' }, deps),
      'creator_proposal_catalog_mismatch',
    );
    expect(error.issues.map((issue) => issue.path)).toContain('capabilities.0.capabilityId');
    expect(deps.saveDraft).not.toHaveBeenCalled();
  });

  it('does not make forged shell or network tools proposal-eligible', async () => {
    const deps = dependencies(fixture('valid-local-agent.json').replaceAll('tool.search', 'tool.shell'));
    deps.buildCatalog.mockResolvedValue([
      catalog()[0],
      {
        capabilityId: 'tool.shell', version: '1', kind: 'tool', displayName: 'Shell',
        available: true, permissions: ['side-effect'], sourceRef: 'agent-capability.shell', health: 'ready',
      },
    ]);
    const error = await expectProposalError(
      proposeCreatorPreset('user-1', { goal: 'Create a research agent', sourceSessionId: 'source-session' }, deps),
      'creator_proposal_catalog_mismatch',
    );
    expect(error.issues.some((issue) => issue.path.includes('capabilities'))).toBe(true);
    expect(deps.saveDraft).not.toHaveBeenCalled();
  });

  it('uses a separate ephemeral, tool-free model session in the default adapter', async () => {
    const calls: unknown[] = [];
    const deps = {
      ...dependencies(fixture('valid-local-agent.json')),
      runModel: undefined,
      chatModel: vi.fn(async (options: unknown) => {
        calls.push(options);
        return { ok: true, text: fixture('valid-local-agent.json'), error: '', aborted: false };
      }),
    };

    await proposeCreatorPreset('user-1', {
      goal: 'Create a research agent',
      sourceSessionId: 'source-session',
    }, deps);

    expect(calls).toEqual([expect.objectContaining({
      userId: 'user-1',
      sessionId: 'creator-proposal-0001',
      disableTools: true,
      ephemeralSession: true,
      skillList: [],
      systemPrompt: expect.any(String),
      message: expect.any(String),
    })]);
    expect(calls[0]).not.toHaveProperty('workingDir');
    expect(calls[0]).not.toHaveProperty('extraRoots');
  });

  it('fails closed on invalid goals, invalid source sessions, and model failures', async () => {
    const invalidGoal = dependencies(fixture('valid-local-agent.json'));
    await expectProposalError(
      proposeCreatorPreset('user-1', { goal: '\u0000\u0001', sourceSessionId: 'source-session' }, invalidGoal),
      'creator_goal_invalid',
    );
    expect(invalidGoal.runModel).not.toHaveBeenCalled();

    const sensitiveGoal = dependencies(fixture('valid-local-agent.json'));
    await expectProposalError(
      proposeCreatorPreset('user-1', {
        goal: 'Use sk-example-only-1234567890 while creating it',
        sourceSessionId: 'source-session',
      }, sensitiveGoal),
      'creator_goal_invalid',
    );
    expect(sensitiveGoal.runModel).not.toHaveBeenCalled();

    const invalidSession = dependencies(fixture('valid-local-agent.json'));
    await expectProposalError(
      proposeCreatorPreset('user-1', { goal: 'Create one', sourceSessionId: '../session' }, invalidSession),
      'creator_source_session_invalid',
    );
    expect(invalidSession.runModel).not.toHaveBeenCalled();

    const failed = dependencies(fixture('valid-local-agent.json'));
    failed.runModel.mockRejectedValue(new Error('provider leaked detail'));
    const error = await expectProposalError(
      proposeCreatorPreset('user-1', { goal: 'Create one', sourceSessionId: 'source-session' }, failed),
      'creator_proposal_model_failed',
    );
    expect(error.message).not.toContain('provider leaked detail');
    expect(failed.saveDraft).not.toHaveBeenCalled();
  });
});
