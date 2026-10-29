import { describe, it, expect, vi } from 'vitest';
import { containerToCreatorDraft } from '../../../../src/main/features/group_chat/agent-builder-governed';
import type { CreatorCapabilityDescriptor } from '../../../../src/main/features/creator/catalog';
import { validateCreatorPresetManifest } from '../../../../src/main/features/creator/schema';

const FIELDS = {
  name: '报销审核',
  description: '审核报销',
  description_zh: '审核报销',
  description_en: 'Expense review',
  workflow: '读取【material】并识别金额。停止规则：高风险转人工。失败行为：说明原因。',
  category: 'general',
  icon: 'sparkle',
  interactive: true,
  skill_list: [],
  inputs: [{ id: 'material', type: 'file', label: '材料', default: '' }],
};

describe('containerToCreatorDraft', () => {
  it('maps container fields into a valid manifest draft', async () => {
    const draft = await containerToCreatorDraft('u1', FIELDS, { sourceSessionId: 'chat-1' }, {
      save: async (_u: string, d: any) => d,
    });
    expect(draft.manifest.displayName).toBe('报销审核');
    expect(draft.manifest.prompt.systemSections[0]).toContain('读取');
    expect(draft.manifest.agent?.category).toBe('general');
    expect(draft.manifest.agent?.inputs?.[0]?.id).toBe('material');
    expect(draft.manifest.provenance.sourceSessionId).toBe('chat-1');
  });

  it('writes canonical tool ids and catalog versions into governed drafts', async () => {
    const catalog: CreatorCapabilityDescriptor[] = [
      {
        capabilityId: 'tool.file', version: '2', kind: 'tool', displayName: 'Files',
        available: true, permissions: ['read'], sourceRef: 'agent-capability.file', health: 'ready',
      },
    ];
    const draft = await containerToCreatorDraft(
      'u1',
      { name: '文件审核', description: '审核文件', workflow: '使用 tool.file 读取文件', tools: ['file'] },
      { sourceSessionId: 'chat-1' },
      { catalog, save: async (_u: string, d: any) => d },
    );
    expect(draft.manifest.permissions.tools).toEqual(['tool.file']);
    expect(draft.manifest.capabilities).toContainEqual({ capabilityId: 'tool.file', version: '2' });
  });

  it('rejects unknown or unavailable governed capabilities before saving', async () => {
    const save = vi.fn(async (_u: string, d: any) => d);
    await expect(
      containerToCreatorDraft(
        'u1',
        { name: '文件审核', description: '审核文件', workflow: '使用 tool.unknown', tools: ['unknown'] },
        { sourceSessionId: 'chat-1' },
        { catalog: [], save },
      ),
    ).rejects.toThrow('creator_catalog_capability_unavailable');
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects containers with agent_id (create-only)', async () => {
    await expect(containerToCreatorDraft('u1', { agent_id: 'some-agent', name: '改名' }, { sourceSessionId: 'chat-1' }))
      .rejects.toThrow('agent_builder_edit_not_supported');
  });

  it('produces a draft whose manifest passes the Creator schema', async () => {
    const draft = await containerToCreatorDraft('u1', FIELDS, { sourceSessionId: 'chat-1' }, {
      save: async (_u: string, d: any) => d,
    });
    const schema = validateCreatorPresetManifest(draft.manifest);
    expect(schema.ok).toBe(true);
  });
});
