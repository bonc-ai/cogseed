import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { CreatorCapabilityDescriptor } from '../../../../src/main/features/creator/catalog';
import type { CreatorSimulationScope } from '../../../../src/main/features/creator/simulation-service';
import type { CreatorPresetManifestV1 } from '../../../../src/main/features/creator/types';
import {
  creatorManifestDigest,
  verifyCreatorPreset,
} from '../../../../src/main/features/creator/verification-service';
import {
  runCreatorValidation,
} from '../../../../src/main/security/creator-validation-runner';

const golden = JSON.parse(fs.readFileSync(
  path.resolve(process.cwd(), 'test/fixtures/creator/golden/local-agent.json'),
  'utf8',
)) as { manifest: CreatorPresetManifestV1; catalog: CreatorCapabilityDescriptor[] };

function deps() {
  return {
    createId: () => 'verification-1',
    now: (() => {
      let tick = 0;
      return () => `2026-08-21T00:00:0${tick++}.000Z`;
    })(),
    onScopeCreated: vi.fn((_scope: CreatorSimulationScope) => undefined),
    onScopeDisposed: vi.fn((_runId: string) => undefined),
    buildCatalog: vi.fn(async () => golden.catalog),
  };
}

const fixedChecks = [
  'schema', 'catalog-resolution', 'tool-allow-list', 'file-grants',
  'side-effects', 'budget', 'timeout', 'cancel',
  'idempotency', 'audit-trajectory', 'agent-usefulness',
];

describe('Creator verification harness', () => {
  it('propagates caller cancellation to every simulation and commits no later effect', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const effectStarted = new Promise<void>((resolve) => { started = resolve; });
    let effectCalls = 0;
    const onEffect = vi.fn(async () => {
      effectCalls += 1;
      if (effectCalls === 1) {
        started();
        await released;
      }
    });
    const dependencies = deps();
    dependencies.onEffect = onEffect;

    const running = verifyCreatorPreset('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      signal: controller.signal,
    }, dependencies);
    await effectStarted;
    controller.abort();
    const report = await running;
    release();

    expect(report.status).toBe('cancelled');
    expect(effectCalls).toBe(1);
    expect(report.checks).toHaveLength(fixedChecks.length);
  });

  it('fails closed for an envelope proxy that throws while reading input', async () => {
    const envelope = new Proxy({}, {
      get() { throw new Error('/private/verification ssh://private.invalid token=secret'); },
    });
    const report = await verifyCreatorPreset('user-1', envelope as any, deps());

    expect(report.status).toBe('failed');
    expect(report.presetId).toBe('invalid-preset');
    expect(report.checks).toHaveLength(fixedChecks.length);
    expect(report.checks.every((entry) => entry.status === 'failed')).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/\/private\/verification|private\.invalid|token=secret/);
  });

  it('returns a complete failed report and skips dynamic checks for malformed manifests', async () => {
    const malformed: any = structuredClone(golden.manifest);
    malformed.prompt.systemSections = undefined;
    const onEffect = vi.fn();
    const report = await verifyCreatorPreset('user-1', {
      manifest: malformed,
      catalogSnapshot: golden.catalog,
    }, { onEffect });
    expect(report.status).toBe('failed');
    expect(report.checks).toHaveLength(11);
    expect(report.checks.every((entry) => entry.status === 'failed')).toBe(true);
    expect(onEffect).not.toHaveBeenCalled();
  });
  it('generates a deterministic manifest digest and passes every fixed check', async () => {
    const dependencies = deps();
    const report = await verifyCreatorPreset('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
    }, dependencies);

    expect(report).toMatchObject({
      schemaVersion: 1,
      runId: 'verification-1',
      presetId: 'local-research',
      status: 'passed',
      startedAt: '2026-08-21T00:00:00.000Z',
      completedAt: '2026-08-21T00:00:01.000Z',
    });
    expect(report.checks.map((check) => check.id)).toEqual(fixedChecks);
    expect(report.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(report.manifestDigest).toBe(creatorManifestDigest(golden.manifest));
    expect(report.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
      if (value && typeof value === 'object') {
        return `{${Object.keys(value as Record<string, unknown>).sort()
          .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
      }
      return JSON.stringify(value);
    };
    expect(report.manifestDigest).toBe(`sha256:${createHash('sha256')
      .update(canonical(golden.manifest))
      .digest('hex')}`);
  });

  it('fails the agent-usefulness check when a config-sheet workflow is incomplete', async () => {
    const manifest = structuredClone(golden.manifest);
    manifest.agent = {
      description_zh: '报销助手',
      description_en: 'Expense assistant',
      inputs: [{ id: 'material', type: 'file', label: '材料' }],
    };
    manifest.prompt.systemSections = ['读取其他内容。'];
    const report = await verifyCreatorPreset('user-1', {
      manifest, catalogSnapshot: golden.catalog,
    }, deps());
    const check = report.checks.find((item) => item.id === 'agent-usefulness');
    expect(report.status).toBe('failed');
    expect(check?.status).toBe('failed');
    expect(check?.evidence).toEqual(expect.arrayContaining([
      'input material not referenced in workflow',
      'workflow lacks explicit stop rule',
      'workflow lacks failure behavior',
    ]));
  });

  it('passes agent-usefulness for a complete bilingual workflow', async () => {
    const manifest = structuredClone(golden.manifest);
    manifest.agent = {
      description_zh: '报销助手',
      description_en: 'Expense assistant',
      inputs: [{ id: 'material', type: 'file', label: '材料' }],
    };
    manifest.prompt.systemSections = ['读取 material。停止规则：高风险转人工。失败行为：说明原因。'];
    const report = await verifyCreatorPreset('user-1', {
      manifest, catalogSnapshot: golden.catalog,
    }, deps());
    expect(report.status).toBe('passed');
    expect(report.checks.find((item) => item.id === 'agent-usefulness')?.status).toBe('passed');
  });

  it('passes idempotency as not applicable for a valid model-only preset', async () => {
    const manifest = structuredClone(golden.manifest);
    manifest.capabilities = [];
    manifest.permissions.tools = [];
    manifest.permissions.files = [];
    const catalog = golden.catalog.filter((entry) => entry.kind === 'model');

    const report = await verifyCreatorPreset('user-1', { manifest, catalogSnapshot: catalog }, deps());

    expect(report.status).toBe('passed');
    expect(report.checks.find((check) => check.id === 'idempotency')).toEqual({
      id: 'idempotency',
      status: 'passed',
      evidence: ['no effect-capable tool selected; idempotency is not applicable'],
    });
  });

  it('keeps the digest stable across object key insertion order', () => {
    const reordered = {
      ...golden.manifest,
      model: {
        modelId: golden.manifest.model.modelId,
        providerId: golden.manifest.model.providerId,
        reasoningProfile: golden.manifest.model.reasoningProfile,
      },
    } as CreatorPresetManifestV1;
    expect(creatorManifestDigest(reordered)).toBe(creatorManifestDigest(golden.manifest));
  });

  it.each([
    ['schema', (manifest: any, _catalog: CreatorCapabilityDescriptor[]) => { manifest.runtime.timeoutMs = 10; }],
    ['catalog-resolution', (manifest: any, _catalog: CreatorCapabilityDescriptor[]) => { manifest.capabilities[0].capabilityId = 'tool.unknown'; }],
    ['tool-allow-list', (manifest: any, _catalog: CreatorCapabilityDescriptor[]) => { manifest.permissions.tools.push('tool.browser'); }],
    ['file-grants', (manifest: any, _catalog: CreatorCapabilityDescriptor[]) => { manifest.permissions.files = ['home.readonly']; }],
    ['side-effects', (manifest: any, _catalog: CreatorCapabilityDescriptor[]) => { manifest.permissions.sideEffects = ['shell.execute']; }],
    ['budget', (manifest: any, _catalog: CreatorCapabilityDescriptor[]) => { manifest.runtime.budget.maxCost = 10001; }],
  ])('returns a failed report rather than throwing when %s fails', async (checkId, mutate) => {
    const manifest = structuredClone(golden.manifest);
    const catalog = structuredClone(golden.catalog);
    mutate(manifest, catalog);
    const dependencies = deps();

    const report = await verifyCreatorPreset('user-1', { manifest, catalogSnapshot: catalog }, dependencies);

    expect(report.status).toBe('failed');
    expect(report.checks.find((check) => check.id === checkId)?.status).toBe('failed');
    expect(report.checks.every((check) => check.evidence.every((item) => !item.includes('/Users/')))).toBe(true);
    if (checkId !== 'schema' && checkId !== 'budget') {
      expect(dependencies.onScopeDisposed.mock.calls.length).toBeGreaterThan(0);
    }
  });

  it('returns a complete failed report for a structurally malformed manifest instead of throwing', async () => {
    const dependencies = deps();

    const report = await verifyCreatorPreset('user-1', {
      manifest: { schemaVersion: 1, presetId: 'broken' } as CreatorPresetManifestV1,
      catalogSnapshot: golden.catalog,
    }, dependencies);

    expect(report.status).toBe('failed');
    expect(report.presetId).toBe('broken');
    expect(report.checks.map((check) => check.id)).toEqual(fixedChecks);
    expect(report.checks.find((check) => check.id === 'schema')?.status).toBe('failed');
    expect(report.checks.slice(1).every((check) => check.status === 'failed')).toBe(true);
  });

  it.each([
    ['null manifest', null],
    ['undefined manifest', undefined],
    ['missing prompt system sections', { schemaVersion: 1, presetId: 'broken', capabilities: [], permissions: { tools: [], files: [], sideEffects: [] } }],
  ])('returns a complete failed report without dynamic execution for a %s', async (_name, malformed) => {
    const dependencies = deps();
    const report = await verifyCreatorPreset('user-1', {
      manifest: malformed as CreatorPresetManifestV1,
      catalogSnapshot: golden.catalog,
    }, dependencies);

    expect(report.status).toBe('failed');
    expect(report.presetId).toBe(
      malformed && typeof malformed === 'object' && typeof malformed.presetId === 'string'
        ? malformed.presetId
        : 'invalid-preset',
    );
    expect(report.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(report.checks).toHaveLength(fixedChecks.length);
    expect(report.checks.map((check) => check.id)).toEqual(fixedChecks);
    expect(report.checks.every((check) => check.status === 'failed')).toBe(true);
    expect(dependencies.onScopeCreated).not.toHaveBeenCalled();
    expect(dependencies.onScopeDisposed).not.toHaveBeenCalled();
  });

  it.each([
    ['cyclic manifest', () => {
      const value: Record<string, unknown> = { schemaVersion: 1, presetId: 'cyclic' };
      value.self = value;
      return value;
    }],
    ['BigInt manifest', () => ({ schemaVersion: 1, presetId: 'bigint', displayName: 1n })],
    ['unclonable manifest', () => ({ schemaVersion: 1, presetId: 'unclonable', callback: () => undefined })],
  ])('returns a complete failed report without digest errors for a %s', async (_name, createManifest) => {
    const dependencies = deps();
    const report = await verifyCreatorPreset('user-1', {
      manifest: createManifest() as CreatorPresetManifestV1,
      catalogSnapshot: golden.catalog,
    }, dependencies);

    expect(report.status).toBe('failed');
    expect(report.presetId).toBe('invalid-preset');
    expect(report.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(report.checks).toHaveLength(fixedChecks.length);
    expect(report.checks.map((check) => check.id)).toEqual(fixedChecks);
    expect(report.checks.every((check) => check.status === 'failed')).toBe(true);
    expect(dependencies.onScopeCreated).not.toHaveBeenCalled();
    expect(dependencies.onScopeDisposed).not.toHaveBeenCalled();
  });

  it('returns cancelled and disposes the active scope when the caller aborts verification', async () => {
    const controller = new AbortController();
    controller.abort();
    const dependencies = deps();

    const report = await verifyCreatorPreset('user-1', {
      manifest: golden.manifest,
      catalogSnapshot: golden.catalog,
      signal: controller.signal,
    }, dependencies);

    expect(report.status).toBe('cancelled');
    expect(dependencies.onScopeDisposed).not.toHaveBeenCalled();
  });

  it('cancels while the trusted catalog is resolving without running simulations', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const catalogReady = new Promise<void>((resolve) => { release = resolve; });
    let catalogStarted!: () => void;
    const started = new Promise<void>((resolve) => { catalogStarted = resolve; });
    const onEffect = vi.fn();
    const dependencies = deps();
    dependencies.onEffect = onEffect;
    dependencies.buildCatalog = vi.fn(async (_userId: string, signal?: AbortSignal) => {
      catalogStarted();
      await catalogReady;
      expect(signal).toBe(controller.signal);
      return golden.catalog;
    });
    const running = verifyCreatorPreset('user-1', {
      manifest: golden.manifest, catalogSnapshot: golden.catalog, signal: controller.signal,
    }, dependencies);
    await started;
    controller.abort();
    const result = await Promise.race([
      running,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
    ]);
    release();
    await running;
    expect(result).not.toBe('hung');
    expect((result as CreatorVerificationReport).status).toBe('cancelled');
    expect(onEffect).not.toHaveBeenCalled();
  });

  it.each([
    ['null envelope', null],
    ['undefined envelope', undefined],
    ['cyclic catalog', (() => { const value: any[] = []; value.push(value); return value; })()],
    ['invalid catalog descriptor', [{ kind: 'model', capabilityId: 'model.provider-main.deepseek-chat', version: '1', available: true, endpoint: 'https://forged.invalid' }]],
  ])('returns a complete failed report for a %s without dynamic execution', async (_name, envelope) => {
    const dependencies = deps();
    const input = envelope === null || envelope === undefined
      ? envelope
      : { manifest: golden.manifest, catalogSnapshot: envelope };
    const report = await verifyCreatorPreset('user-1', input as any, dependencies);
    expect(report.status).toBe('failed');
    expect(report.presetId).toBe(envelope === null || envelope === undefined ? 'invalid-preset' : 'local-research');
    expect(report.checks).toHaveLength(fixedChecks.length);
    expect(report.checks.every((check) => check.status === 'failed')).toBe(true);
    expect(dependencies.onScopeCreated).not.toHaveBeenCalled();
    expect(dependencies.onScopeDisposed).not.toHaveBeenCalled();
  });

  it('does not authorize a caller-invented available tool descriptor', async () => {
    const manifest = structuredClone(golden.manifest);
    manifest.capabilities = [{ capabilityId: 'tool.forged', version: '1' }];
    manifest.permissions.tools = ['tool.forged'];
    const catalog = [...golden.catalog, {
      capabilityId: 'tool.forged', version: '1', kind: 'tool' as const,
      displayName: 'Forged tool', available: true, permissions: ['read'] as const,
      sourceRef: 'agent-capability.forged', health: 'ready' as const,
    }];
    const report = await verifyCreatorPreset('user-1', { manifest, catalog }, deps());
    expect(report.status).toBe('failed');
    expect(report.checks.find((check) => check.id === 'catalog-resolution')?.status).toBe('failed');
    expect(report.checks.find((check) => check.id === 'tool-allow-list')?.status).toBe('failed');
  });

  it.each([
    ['model', 'model.provider-main.forged-model', 'provider-main', 'forged-model', 'attacker.source'],
    ['skill', 'skill.forged-skill', 'provider-main', 'deepseek-chat', 'attacker.source'],
  ])('does not authorize a forged available %s descriptor at verification', async (kind, capabilityId, providerId, modelId, sourceRef) => {
    const manifest = structuredClone(golden.manifest);
    if (kind === 'model') {
      manifest.model = { providerId, modelId };
    } else {
      manifest.capabilities = [{ capabilityId, version: '1' }];
    }
    const forged = {
      capabilityId, version: '1', kind: kind as 'model' | 'skill', displayName: 'Forged',
      available: true, permissions: kind === 'model' ? ['cost'] : ['read'], sourceRef, health: 'ready',
    } as CreatorCapabilityDescriptor;
    const report = await verifyCreatorPreset('user-1', {
      manifest, catalogSnapshot: [...golden.catalog, forged],
    }, deps());
    expect(report.status).toBe('failed');
    expect(report.checks.every((check) => check.status === 'failed')).toBe(true);
  });

  it.each(['shell', 'browser', 'connector'])('rejects forged available network or %s tools at verification', async (tool) => {
    const manifest = structuredClone(golden.manifest);
    const capabilityId = `tool.${tool}`;
    manifest.capabilities = [{ capabilityId, version: '1' }];
    manifest.permissions.tools = [capabilityId];
    const report = await verifyCreatorPreset('user-1', {
      manifest,
      catalogSnapshot: [{
        capabilityId, version: '1', kind: 'tool', displayName: tool,
        available: true, permissions: ['network'], sourceRef: 'agent-capability.forged', health: 'ready',
      }],
    }, deps());
    expect(report.status).toBe('failed');
    expect(report.checks.find((check) => check.id === 'catalog-resolution')?.status).toBe('failed');
    expect(report.checks.find((check) => check.id === 'tool-allow-list')?.status).toBe('failed');
  });

  it('rejects oversized scalar fields in a verification report before evidence traversal', async () => {
    const report = await verifyCreatorPreset('user-1', {
      manifest: golden.manifest, catalogSnapshot: golden.catalog,
    }, deps());
    const oversized = { ...report, runId: 'x'.repeat(10_000) };
    const serviceLike = await import('../../../../src/main/features/creator/lifecycle-service');
    const lifecycle = serviceLike.createCreatorLifecycleService({
      getActiveUserId: () => 'user-1',
      readDraft: async () => null,
    });
    await expect(lifecycle.recordVerification('user-1', 'draft-missing', oversized as any))
      .rejects.toThrow('creator_verification_report_invalid');
  });
});

describe('Creator validation isolation', () => {
  it('dispatches only an immutable allow-listed plan through the injected executor', async () => {
    const execute = vi.fn(async (plan) => {
      expect(Object.isFrozen(plan)).toBe(true);
      expect(Object.isFrozen(plan.args)).toBe(true);
      expect(plan).toMatchObject({
        checkId: 'typecheck',
        command: 'npm',
        args: ['run', 'typecheck'],
        cwd: process.cwd(),
        shell: false,
      });
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    });
    let tick = 10;

    const result = await runCreatorValidation('user-1', {
      checkId: 'typecheck',
    }, {
      execute,
      getActiveUserId: () => 'user-1',
      getWorkspacePath: (userId) => {
        expect(userId).toBe('user-1');
        return process.cwd();
      },
      now: () => tick++,
    });

    expect(result).toEqual({
      check_id: 'typecheck',
      status: 'passed',
      exit_code: 0,
      duration_ms: 1,
      output: 'ok',
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects unknown users, workspaces, path escapes, and checks before dispatch', async () => {
    const execute = vi.fn(async () => ({ exitCode: 0 }));
    const trusted = {
      execute,
      getActiveUserId: () => 'user-1',
      getWorkspacePath: () => process.cwd(),
    };
    await expect(runCreatorValidation('user-2', { checkId: 'test' }, trusted))
      .rejects.toThrow('creator_user_not_active');
    await expect(runCreatorValidation('user-1', { checkId: 'test' }, {
      ...trusted, getWorkspacePath: () => '/definitely/not/a/workspace',
    })).rejects.toThrow('creator_validation_workspace_invalid');
    await expect(runCreatorValidation('user-1', { checkId: 'test' }, {
      ...trusted, getWorkspacePath: () => '../escape',
    })).rejects.toThrow('creator_validation_workspace_invalid');
    await expect(runCreatorValidation('user-1', { checkId: 'typecheck && echo unsafe' }, trusted))
      .rejects.toThrow('creator_validation_check_invalid');
    expect(execute).not.toHaveBeenCalled();
  });

  it('ignores attacker-selected path fields and uses only the trusted user workspace', async () => {
    const execute = vi.fn(async (plan) => {
      expect(plan.cwd).toBe(process.cwd());
      return { exitCode: 0 };
    });
    const attackerInput = {
      checkId: 'smoke',
      workingDir: '/tmp/attacker-selected',
      allowedRoots: ['/tmp'],
    } as any;

    await runCreatorValidation('user-1', attackerInput, {
      execute,
      getActiveUserId: () => 'user-1',
      getWorkspacePath: () => process.cwd(),
    });

    expect(execute).toHaveBeenCalledOnce();
  });

  it('caps executor output and reports timeout without exposing execution controls', async () => {
    const result = await runCreatorValidation('user-1', {
      checkId: 'test',
    }, {
      execute: async () => ({ exitCode: null, timedOut: true, stdout: 'x'.repeat(9_000) }),
      getActiveUserId: () => 'user-1',
      getWorkspacePath: () => process.cwd(),
      now: () => 1,
    });

    expect(result.status).toBe('timed_out');
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(8_003);
    expect(result.output.endsWith('…')).toBe(true);
  });
});
