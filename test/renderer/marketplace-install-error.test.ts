import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function loadMarketplaceRenderer(): any {
  const userErrorCode = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/user-error.js'),
    'utf8',
  );
  const code = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/marketplace.js'),
    'utf8',
  );
  const storage = new Map<string, string>();
  const monitorErrors: Array<{ action: string; data: Record<string, unknown> }> = [];
  const monitor = {
    error: (action: string, data: Record<string, unknown>) => { monitorErrors.push({ action, data }); },
  };
  const context: any = {
    console,
    clearTimeout: () => {},
    setTimeout: () => 0,
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
    document: {
      hidden: false,
      addEventListener: () => {},
      getElementById: () => null,
      querySelectorAll: () => [],
    },
    window: {
      addEventListener: () => {},
      cogseed: {
        invoke: async () => ({ list: [] }),
      },
      Monitor: monitor,
    },
    Monitor: monitor,
    _monitorErrors: monitorErrors,
    t: (key: string) => ({
      'marketplace.install_failed': 'Install failed: {reason}',
      'marketplace.install_failed_resource': 'Install failed: {kind}: {name}. {reason}',
      'marketplace.action_failed_retry_later': 'Marketplace is temporarily unavailable. Please try again later.',
      'marketplace.app_update_required': 'Requires CogSeed {minimum} or newer (current {current}). Update CogSeed, then install.',
      'marketplace.requires_app': 'Needs CogSeed {version}+',
      'marketplace_request.kind_agent': 'Agent',
      'marketplace_request.kind_skill': 'Skill',
    } as Record<string, string>)[key] || key,
  };
  vm.createContext(context);
  vm.runInContext(userErrorCode, context, { filename: 'user-error.js' });
  vm.runInContext(code, context, { filename: 'marketplace.js' });
  return context;
}

describe('marketplace install error display', () => {
  it('hides the dev review status filter and clears any selected status', () => {
    const ctx = loadMarketplaceRenderer();
    ctx.isDevMode = () => true;
    vm.runInContext('_mpState = { status: "approved" }', ctx);
    const host = { style: {} as Record<string, string> };
    const panel = {
      querySelector: (selector: string) => (
        selector === '.marketplace-status-filter' ? host : null
      ),
    };

    ctx._mpRenderStatusSelect(panel);

    expect(ctx._mpShowReviewStatusUi()).toBe(false);
    expect(host.style.display).toBe('none');
    expect(vm.runInContext('_mpState.status', ctx)).toBe('');
  });

  it('uses the dependency skill name instead of the agent name for cascade failures', () => {
    const ctx = loadMarketplaceRenderer();
    const text = ctx._mpInstallFailedText(
      'agent',
      { id: 'agent-1', name: 'ResearchTutor' },
      {
        marketplaceKind: 'skill',
        marketplaceId: 'stale-skill-id',
        marketplaceName: 'missing-friendly-skill',
        marketplaceReason: 'not_found',
      },
    );

    expect(text).toBe('Install failed: Skill: missing-friendly-skill. not_found');
    expect(text).not.toContain('Skill: ResearchTutor');
    expect(text).not.toContain('stale-skill-id');
  });

  it('shows a localized update prompt for a min-app-version block, not a raw string', () => {
    const ctx = loadMarketplaceRenderer();
    const text = ctx._mpInstallFailedText(
      'agent',
      { id: 'agent-1', name: 'SampleAgent' },
      {
        marketplaceKind: 'agent',
        marketplaceAppUpdateRequired: true,
        marketplaceMinAppVersion: '1.6.0',
        marketplaceCurrentAppVersion: '1.5.1',
        message: 'requires CogSeed >= 1.6.0; current 1.5.1',
      },
    );

    expect(text).toBe(
      'Install failed: Agent: SampleAgent. Requires CogSeed 1.6.0 or newer (current 1.5.1). Update CogSeed, then install.',
    );
    expect(text).not.toContain('requires CogSeed >= 1.6.0');
  });

  it('gates the install button by client app version', () => {
    const ctx = loadMarketplaceRenderer();
    expect(ctx._mpCompareVersions('1.5.1', '1.6.0')).toBeLessThan(0);
    expect(ctx._mpCompareVersions('1.6.0', '1.6.0')).toBe(0);
    expect(ctx._mpCompareVersions('1.7.0', '1.6.0')).toBeGreaterThan(0);

    vm.runInContext('_mpState = { appVersion: "1.5.1" }', ctx);
    expect(ctx._mpItemAppCompatible({ min_app_version: '1.6.0' })).toBe(false);
    expect(ctx._mpItemAppCompatible({ min_app_version: '1.5.0' })).toBe(true);
    expect(ctx._mpItemAppCompatible({ min_app_version: '' })).toBe(true);

    // A declared minimum fails closed until the PC provides its current version.
    vm.runInContext('_mpState = { appVersion: "" }', ctx);
    expect(ctx._mpItemAppCompatible({ kind: 'agent', min_app_version: '1.6.0' })).toBe(false);
    expect(ctx._mpItemAppCompatible({ kind: 'skill', min_app_version: '1.6.0' })).toBe(false);
    expect(ctx._mpItemAppCompatible({ min_app_version: '' })).toBe(true);
  });

  it('maps transport failures to user-facing marketplace copy', () => {
    const ctx = loadMarketplaceRenderer();
    const text = ctx._mpInstallFailedText(
      'agent',
      { id: 'agent-1', name: 'ResearchTutor' },
      {
        message: 'marketplace:/marketplace/agents/detail timed out after 60s',
        code: ctx.window.USER_ERROR_CODE.NETWORK_TIMEOUT,
      },
    );

    expect(text).toBe('Install failed: Agent: ResearchTutor. Marketplace is temporarily unavailable. Please try again later.');
    expect(text).not.toContain('marketplace:/marketplace/agents/detail');
    expect(text).not.toContain('timed out after 60s');
  });

  it('does not send missing dependency skill telemetry in the open build', () => {
    const ctx = loadMarketplaceRenderer();
    ctx._mpTrackInstallFailure('agent', { id: 'agent-1', name: 'ResearchTutor' }, {
      marketplaceKind: 'skill',
      marketplaceId: 'stale-skill-id',
      marketplaceName: 'missing-friendly-skill',
      marketplaceReason: 'not_found',
    });

    expect(ctx._monitorErrors).toEqual([]);
  });

  it('does not report non-missing dependency failures as missing skills', () => {
    const ctx = loadMarketplaceRenderer();
    ctx._mpTrackInstallFailure('agent', { id: 'agent-1', name: 'ResearchTutor' }, {
      marketplaceKind: 'skill',
      marketplaceId: 'dep-skill',
      marketplaceName: 'draft-skill',
      marketplaceReason: 'status_not_approved:reviewing',
    });

    expect(ctx._monitorErrors).toEqual([]);
  });
});

describe('S4 智能体 / 技能页安装（quiet）：失败可重试、成功不跳转', () => {
  function setup(invoke: (channel: string, payload: any) => Promise<any>) {
    const ctx = loadMarketplaceRenderer();
    const alerts: string[] = [];
    const toasts: Array<{ text: string; variant?: string }> = [];
    const modals: unknown[] = [];
    ctx.window.cogseed.invoke = invoke;
    ctx.HubContentStatus = { isHubContentDisabled: () => false };
    ctx.uiAlert = async (m: string) => { alerts.push(m); };
    ctx.uiToast = (text: string, opts: any) => { toasts.push({ text, variant: opts && opts.variant }); };
    ctx.uiModal = async (opts: unknown) => { modals.push(opts); return { value: 'install' }; };
    vm.runInContext('_mpState = _mpNewState("agent")', ctx);
    return { ctx, alerts, toasts, modals };
  }
  const row = { id: 'abcdef123456', name: '报销助手', version: '1.0.0', published_at: 1, updated_at: 2 };

  it('失败：返回 false、记下原因供卡片显示「重试」，用提示条而不是弹窗', async () => {
    const { ctx, alerts, toasts } = setup(async (channel) => {
      if (channel === 'marketplace.agentInstallPlan') return { items: [] };
      return { ok: false, error: 'network down' };
    });
    expect(await ctx._mpInstall('agent', row.id, row, { quiet: true })).toBe(false);
    expect(vm.runInContext('_mpState.installFailed.get("agent:abcdef123456")', ctx)).toContain('报销助手');
    expect(vm.runInContext('_mpState.installing.size', ctx)).toBe(0);
    expect(alerts).toEqual([]);
    expect(toasts[0].variant).toBe('error');
  });

  it('重试成功：返回 true、清掉失败记录、标为已安装', async () => {
    let fail = true;
    const { ctx } = setup(async (channel) => {
      if (channel === 'marketplace.agentInstallPlan') return { items: [] };
      return fail ? { ok: false, error: 'x' } : { ok: true };
    });
    await ctx._mpInstall('agent', row.id, row, { quiet: true });
    fail = false;
    expect(await ctx._mpInstall('agent', row.id, row, { quiet: true })).toBe(true);
    expect(vm.runInContext('_mpState.installFailed.has("agent:abcdef123456")', ctx)).toBe(false);
    expect(vm.runInContext('_mpState.installedAgentIds.has("abcdef123456")', ctx)).toBe(true);
  });

  it('带依赖的智能体：不弹「将同时安装」确认', async () => {
    const { ctx, modals } = setup(async (channel) => {
      if (channel === 'marketplace.agentInstallPlan') {
        return { items: [{ id: 's1', name: '发票字段抽取', kind: 'hub', action: 'install' }], appUpdateRequired: false };
      }
      return { ok: true };
    });
    expect(await ctx._mpInstall('agent', row.id, row, { quiet: true })).toBe(true);
    expect(modals).toEqual([]);
  });

  it('非 quiet（市场页）：失败仍然弹窗说明', async () => {
    const { ctx, alerts, toasts } = setup(async () => ({ ok: false, error: 'x' }));
    expect(await ctx._mpInstall('skill', row.id, row)).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(toasts).toEqual([]);
  });

  it('有新版本时判为「有更新」', () => {
    const { ctx } = setup(async () => ({}));
    vm.runInContext('_mpState.installedSkillIds = new Set(["s1"]); _mpState.installedSkillMeta = new Map([["s1", { id: "s1", version: "1.0.0" }]])', ctx);
    expect(ctx._mpInstallStatus('skill', { id: 's1', version: '1.1.0' }).updateAvailable).toBe(true);
    expect(ctx._mpInstallStatus('skill', { id: 's1', version: '1.0.0' }).updateAvailable).toBe(false);
  });
});
