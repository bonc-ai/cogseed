import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  AGENT_BUILDER_IDS,
  applyAgentBuilderContainers,
} from '../../../../src/main/features/group_chat/agent-builder';

const BUILDER_ID = [...AGENT_BUILDER_IDS][0];
const OTHER_ID = '111111111111';

function container(body: string): string {
  return `好的，以下是配置单。\n<agent>\n${body}\n</agent>`;
}

describe('applyAgentBuilderContainers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects non-whitelist agents without touching text', async () => {
    const text = container('<name>报销审核</name>\n<workflow>你是报销审核智能体</workflow>');
    const result = await applyAgentBuilderContainers({
      uid: 'u1',
      agentId: OTHER_ID,
      workingText: text,
    });
    expect(result.created).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.cleanText).toBe(text);
  });

  it('returns text unchanged when no container is present', async () => {
    const text = '普通回复，没有任何容器。';
    const result = await applyAgentBuilderContainers({
      uid: 'u1',
      agentId: BUILDER_ID,
      workingText: text,
    });
    expect(result.created).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.cleanText).toBe(text);
  });

  it('creates an agent from a whitelist builder container', async () => {
    const created = { agent_id: 'agent-1', name: '报销审核' };
    const createFromBlocks = vi.fn(async () => created);
    const text = container('<name>报销审核</name>\n<workflow>你是报销审核智能体</workflow>');
    const result = await applyAgentBuilderContainers(
      { uid: 'u1', cid: 'c1', agentId: BUILDER_ID, workingText: text },
      { createFromBlocks },
    );
    expect(createFromBlocks).toHaveBeenCalledTimes(1);
    expect(result.created).toEqual([{ agent_id: 'agent-1', name: '报销审核' }]);
    expect(result.rejected).toEqual([]);
    expect(result.cleanText).not.toContain('<agent>');
  });

  it('rejects containers with agent_id (create-only)', async () => {
    const createFromBlocks = vi.fn(async () => null);
    const text = container('<agent_id>some-agent</agent_id>\n<name>改名</name>');
    const result = await applyAgentBuilderContainers(
      { uid: 'u1', agentId: BUILDER_ID, workingText: text },
      { createFromBlocks },
    );
    expect(createFromBlocks).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
    expect(result.rejected.length).toBeGreaterThan(0);
  });

  it('rejects tools in direct mode before creating an agent', async () => {
    const createFromBlocks = vi.fn(async () => ({ agent_id: 'should-not-exist', name: 'x' }));
    const text = container('<name>x</name>\n<workflow>读取文件并审核</workflow>\n<tools>file</tools>');
    const result = await applyAgentBuilderContainers(
      { uid: 'u1', agentId: BUILDER_ID, workingText: text },
      { createFromBlocks },
    );
    expect(createFromBlocks).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
    expect(result.rejected.join(' ')).toContain('governed');
  });

  it('rejects Skills in direct mode before creating an agent', async () => {
    const createFromBlocks = vi.fn(async () => ({ agent_id: 'should-not-exist', name: 'x' }));
    const text = container('<name>x</name>\n<workflow>按技能规范审核</workflow>\n<skills>agent-creator</skills>');
    const result = await applyAgentBuilderContainers(
      { uid: 'u1', agentId: BUILDER_ID, workingText: text },
      { createFromBlocks },
    );
    expect(createFromBlocks).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
    expect(result.rejected.join(' ')).toContain('Skill');
  });

  it('reports creation failure when server rejects (missing required fields)', async () => {
    const createFromBlocks = vi.fn(async () => null);
    const text = container('<name>报销审核</name>');
    const result = await applyAgentBuilderContainers(
      { uid: 'u1', agentId: BUILDER_ID, workingText: text },
      { createFromBlocks },
    );
    expect(createFromBlocks).toHaveBeenCalledTimes(1);
    expect(result.created).toEqual([]);
    expect(result.rejected.length).toBeGreaterThan(0);
  });

  it('auto-adds created agent to space when turnSpaceId present', async () => {
    const created = { agent_id: 'agent-9', name: 'x' };
    const createFromBlocks = vi.fn(async () => created);
    const addSpaceResource = vi.fn(async () => undefined);
    const text = container('<name>x</name>\n<workflow>wf</workflow>');
    const result = await applyAgentBuilderContainers(
      { uid: 'u1', cid: 'c1', turnSpaceId: 'sp1', agentId: BUILDER_ID, workingText: text },
      { createFromBlocks, addSpaceResource },
    );
    expect(addSpaceResource).toHaveBeenCalledWith('u1', 'sp1', 'agent', 'agent-9');
    expect(result.created).toEqual([{ agent_id: 'agent-9', name: 'x' }]);
  });

  it('passes inheritance context (conversation/project)', async () => {
    const created = { agent_id: 'a1', name: 'n' };
    const createFromBlocks = vi.fn(async () => created);
    const text = container('<name>n</name>\n<workflow>wf</workflow>');
    await applyAgentBuilderContainers(
      { uid: 'u1', cid: 'c1', turnProjectId: 'p1', agentId: BUILDER_ID, workingText: text },
      { createFromBlocks },
    );
    expect(createFromBlocks).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ name: 'n' }),
      expect.objectContaining({ userId: 'u1', conversationId: 'c1', projectId: 'p1' }),
    );
  });
});
