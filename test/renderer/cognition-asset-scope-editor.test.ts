import { describe, expect, it } from 'vitest';
import { loadCognitionAssets, renderCognition } from './helpers/cognition-renderer';

describe('cognition asset visibility editor', () => {
  const asset = {
    id: 'aa-scope-editor',
    type: 'personal',
    title: '沟通偏好',
    statement: '使用简洁表达。',
    status: 'active',
    version: '1',
    activeVersion: '1',
    scopePolicy: {
      agentIds: ['agent-id-private', 'agent-id-missing'],
      workspaceIds: ['space-id-private'],
      purposeTags: ['review'],
    },
  };

  it('shows readable names, keeps missing legacy targets reviewable, and retains ids only as control values', () => {
    const html = renderCognition({ name: 'overview', assetId: asset.id, assetEdit: '1' }, {
      assets: [asset],
      assetScopeOptions: {
        status: 'ready',
        agents: [{ agent_id: 'agent-id-private', name: '审阅助手' }],
        spaces: [{ space_id: 'space-id-private', name: '产品工作区' }],
      },
    });
    const visibleText = html.replace(/<[^>]*>/g, ' ');

    expect(visibleText).toContain('审阅助手');
    expect(visibleText).toContain('产品工作区');
    expect(visibleText).toContain('已不可用的旧智能体限制 1');
    expect(visibleText).toContain('不选择不代表解除限制');
    expect((html.match(/data-prototype-scope-mode=/g) || []).length).toBe(2);
    expect(visibleText).not.toContain('agent-id-private');
    expect(visibleText).not.toContain('agent-id-missing');
    expect(visibleText).not.toContain('space-id-private');
    expect(html).toContain('<option value="agent-id-private" selected>审阅助手</option>');
    expect(html).toContain('<option value="space-id-private" selected>产品工作区</option>');
    expect(html).toContain('项目与用途维度保持原样');
  });

  it('preserves the existing policy when the Agent or workspace directory cannot be read', () => {
    const html = renderCognition({ name: 'overview', assetId: asset.id, assetEdit: '1' }, {
      assets: [asset],
      assetScopeOptions: { status: 'error', agents: [], spaces: [], error: 'offline' },
    });

    expect(html).toContain('对象目录尚未就绪');
    expect(html).toContain('当前不能更改对象限制');
    expect(html).toContain('data-act="asset-scope-options-retry"');
  });

  it('preserves an existing restriction when a draft selection is empty and retains unedited dimensions', async () => {
    const current = {
      ...asset,
      scopePolicy: {
        agentIds: ['agent-id-private'],
        workspaceIds: ['space-id-private'],
        purposeTags: ['review'],
        projectIds: ['project-a'],
      },
    };
    const calls: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const card = {
      querySelector(selector: string) {
        if (selector === '[data-f="sensitivity"]') return { getAttribute: () => '' };
        const field = selector.match(/\[data-f="([^"]+)"\]/)?.[1] || '';
        const value: Record<string, string> = {
          title: current.title,
          statement: current.statement,
          applicable: '',
          forbidden: '',
        };
        return field in value ? { value: value[field] } : null;
      },
    };
    const loaded = loadCognitionAssets({
      assets: [current],
      assetScopeOptions: { status: 'ready', agents: [], spaces: [] },
      assetEditDrafts: {
        [current.id]: { baseVersion: String(current.version), baseActiveVersion: String(current.version), scopeSelection: { agentIds: [], workspaceIds: ['space-id-next'] } },
      },
    }, { name: 'overview', assetId: current.id, assetEdit: '1' }, {
      cogseed: {
        invoke: async (channel: string, payload: Record<string, unknown> = {}) => {
          calls.push({ channel, payload });
          return { ok: true, asset: { version: '2' } };
        },
      },
    });
    loaded.context.document.querySelector = (selector: string) => selector === '.ca-asset-edit' ? card : null;

    await loaded.ns.actions.editAsset(current.id);

    const update = calls.find((call) => call.channel === 'recall.assets.update');
    expect(update?.payload.scopePolicy).toEqual({
      agentIds: ['agent-id-private'],
      purposeTags: ['review'],
      projectIds: ['project-a'],
      workspaceIds: ['space-id-next'],
    });
  });

  it('removes an existing dimension only after the explicit unrestrict action', async () => {
    const calls: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const loaded = loadCognitionAssets({
      assets: [asset],
      assetScopeOptions: { status: 'ready', agents: [], spaces: [] },
      assetEditDrafts: {
        [asset.id]: { baseVersion: String(asset.version), baseActiveVersion: String(asset.version), scopeSelection: { agentIds: [] }, scopeUnrestrict: ['agent'] },
      },
    }, { name: 'overview', assetId: asset.id, assetEdit: '1' }, {
      cogseed: {
        invoke: async (channel: string, payload: Record<string, unknown> = {}) => {
          calls.push({ channel, payload });
          return { ok: true, asset: { version: '2' } };
        },
      },
    });
    const card = {
      querySelector(selector: string) {
        if (selector === '[data-f="sensitivity"]') return { getAttribute: () => '' };
        const field = selector.match(/\[data-f="([^"]+)"\]/)?.[1] || '';
        const value: Record<string, string> = {
          title: asset.title,
          statement: asset.statement,
          applicable: '',
          forbidden: '',
        };
        return field in value ? { value: value[field] } : null;
      },
    };
    loaded.context.document.querySelector = (selector: string) => selector === '.ca-asset-edit' ? card : null;

    await loaded.ns.actions.editAsset(asset.id);

    const update = calls.find((call) => call.channel === 'recall.assets.update');
    expect(update?.payload.scopePolicy).toEqual({
      workspaceIds: ['space-id-private'],
      purposeTags: ['review'],
    });
  });
});
