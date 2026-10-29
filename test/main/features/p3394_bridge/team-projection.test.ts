import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { p3394StateFile } from '../../../../src/main/features/p3394_bridge/runtime-paths';

/** 直接落盘投影文件：模拟历史/异常映射（例如绑定到别的 CLI 的 agent_id）。
 *  生产侧每次投影都实时读盘（readProjections 不走缓存），所以这里能生效。 */
function seedProjections(rows: Record<string, string>) {
  const file = p3394StateFile('p3394-team-projection.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schema_version: 1,
    projections: Object.fromEntries(
      Object.entries(rows).map(([node, agentId]) => [node, { agent_id: agentId, at: new Date().toISOString() }]),
    ),
  }));
}

let testUid = '';
let prevWorkspaceRoot: string | undefined;
let testVariant = '';

describe('P3394 node -> AI team projection', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-proj-'));
    prevWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
    process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
    // Agent 目录缓存按用户隔离；每例使用唯一 uid，避免上一个用例的缓存
    // 继续参与下一例的 existing-agent 查重。
    testUid = 'u-projection-' + Math.random().toString(36).slice(2, 10);
    // 每次运行唯一变体：投影状态文件按变体目录隔离，杜绝跨测试/跨运行污染。
    testVariant = 'p3394-proj-test-' + Math.random().toString(36).slice(2, 10);
    process.env.COGSEED_RUNTIME_VARIANT = testVariant;

    // 设置引导为已完成状态，允许 CLI Agent 投影
    const onboardingState = await import('../../../../src/main/features/onboarding_state');
    onboardingState.setOnboardingCompleted(true);
  });

  afterEach(() => {
    if (prevWorkspaceRoot !== undefined) process.env.COGSEED_WORKSPACE_ROOT = prevWorkspaceRoot;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try {
      const variantDir = path.join(os.homedir(), '.cogseed', 'runtime-variants', testVariant);
      fs.rmSync(variantDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('projects a local hermes node into the AI team with the external badge runtime', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    const result = await mod.projectP3394NodeToTeam({
      nodeId: 'hermes',
      alias: 'Hermes',
      endpoints: ['http://127.0.0.1:9000'],
    });
    expect(result.projected).toBe(true);
    expect(result.agent_id).toBeTruthy();

    const agents = await import('../../../../src/main/features/agents');
    const list = await agents.listAgents();
    const created = list.find((a) => a.agent_id === result.agent_id);
    expect(created).toBeTruthy();
    expect(created?.runtime).toEqual({ kind: 'p3394-gateway', cli: 'hermes' });
    expect(created?.name).toContain('Hermes');
    expect(created?.description_zh).toContain('P3394');
    expect(agents.isP3394GatewayAgent(created)).toBe(true);

    const again = await mod.projectP3394NodeToTeam({
      nodeId: 'hermes',
      alias: 'Hermes',
      endpoints: ['http://127.0.0.1:9000'],
    });
    expect(again.projected).toBe(false);
    expect(again.agent_id).toBe(result.agent_id);
    const p3394Agents = (await agents.listAgents()).filter((a) => {
      const rt = a.runtime as { kind?: string; cli?: string } | undefined;
      return rt && rt.kind === 'p3394-gateway' && rt.cli === 'hermes';
    });
    expect(p3394Agents).toHaveLength(1);
  });

  it('repairs a stale projection after its Agent record is deleted', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    const agents = await import('../../../../src/main/features/agents');
    const first = await mod.projectP3394NodeToTeam({
      nodeId: 'claude', alias: 'ClaudeCode', endpoints: ['http://127.0.0.1:8444'],
    });
    expect(first.projected).toBe(true);
    await agents.deleteCustomAgent(first.agent_id!);

    const repaired = await mod.projectP3394NodeToTeam({
      nodeId: 'claude', alias: 'ClaudeCode', endpoints: ['http://127.0.0.1:8444'],
    });
    expect(repaired.projected).toBe(true);
    expect(repaired.agent_id).not.toBe(first.agent_id);
    expect((await agents.listAgents()).filter((agent) => agent.runtime?.kind === 'p3394-gateway')).toHaveLength(1);
  });

  it('removeProjectionsForAgent clears every node mapping that points at the agent', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    const a = await mod.projectP3394NodeToTeam({
      nodeId: 'cli-a', alias: 'Alpha', endpoints: ['http://127.0.0.1:9101'],
    });
    expect(a.projected).toBe(true);
    // 同一个 agent 可能被多个 nodeId 映射（旧版按“列表里第一个 gateway agent”
    // 绑定留下的历史行，或用户手工改过投影文件）。删除 agent 时必须全部清掉，
    // 否则下次 hello 会带着指向已删记录的陈旧映射回来。
    seedProjections({ 'cli-a': a.agent_id!, 'cli-a-final': a.agent_id! });
    expect(mod.projectedTeamAgentId('cli-a-final')).toBe(a.agent_id);

    const removed = mod.removeProjectionsForAgent(a.agent_id!);
    expect(removed).toBe(2);
    expect(mod.projectedTeamAgentId('cli-a')).toBeUndefined();
    expect(mod.projectedTeamAgentId('cli-a-final')).toBeUndefined();
    // 幂等：再次清理返回 0。
    expect(mod.removeProjectionsForAgent(a.agent_id!)).toBe(0);
  });

  it('never binds a node to an unrelated gateway agent (真机 Codex/WorkBuddy 串号)', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    const agents = await import('../../../../src/main/features/agents');
    // 真机前提：机器上先有 Codex 卡片（listAgents 里排在前）。
    const codex = await agents.createCustomAgent({
      name: 'Codex', description_zh: '', description_en: '', icon: 'code', color: 'sage',
      runtime: { kind: 'p3394-gateway', cli: 'codex' }, category: 'general',
    });
    expect(codex?.agent_id).toBeTruthy();

    // 自建节点：绝不能因为"列表里第一个是 Codex"就被挂到 Codex 名下
    // （conversation-runtime 用这条映射决定回复归属 → 否则回答显示成 Codex）。
    const result = await mod.projectP3394NodeToTeam({
      nodeId: 'my-custom-agent', alias: '我的自研智能体', endpoints: ['http://127.0.0.1:9200'],
    });
    expect(result.projected).toBe(true);
    expect(result.agent_id).not.toBe(codex?.agent_id);
    expect(mod.projectedTeamAgentId('my-custom-agent')).toBe(result.agent_id);
    const created = (await agents.listAgents()).find((agent) => agent.agent_id === result.agent_id);
    expect(created?.runtime).toEqual({ kind: 'p3394-gateway', cli: 'my-custom-agent' });
  });

  it('heals a projection that points at a different CLI agent', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    const agents = await import('../../../../src/main/features/agents');
    const codex = await agents.createCustomAgent({
      name: 'Codex', description_zh: '', description_en: '', icon: 'code', color: 'sage',
      runtime: { kind: 'p3394-gateway', cli: 'codex' }, category: 'general',
    });
    const workbuddy = await agents.createCustomAgent({
      name: 'WorkBuddy', description_zh: '', description_en: '', icon: 'code', color: 'sage',
      runtime: { kind: 'p3394-gateway', cli: 'workbuddy' }, category: 'general',
    });
    // 存量错绑：workbuddy 节点被写成 codex 的 agent_id（这正是真机上的状态）。
    seedProjections({ workbuddy: codex?.agent_id || '' });

    const result = await mod.projectP3394NodeToTeam({
      nodeId: 'workbuddy', alias: 'WorkBuddy', endpoints: ['http://127.0.0.1:9210'],
    });
    expect(result.agent_id).toBe(workbuddy?.agent_id);
    expect(mod.projectedTeamAgentId('workbuddy')).toBe(workbuddy?.agent_id);
  });

  it('prefers an exact node-id agent over a prefix lookalike (codex-proxy 不能被绑到真 Codex)', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    const agents = await import('../../../../src/main/features/agents');
    const codex = await agents.createCustomAgent({
      name: 'Codex', description_zh: '', description_en: '', icon: 'code', color: 'sage',
      runtime: { kind: 'p3394-gateway', cli: 'codex' }, category: 'general',
    });
    // 用户自建的代理节点：id 以 codex 开头，但它有自己的卡片。
    const proxy = await agents.createCustomAgent({
      name: 'CodexProxy', description_zh: '', description_en: '', icon: 'code', color: 'sage',
      runtime: { kind: 'p3394-gateway', cli: 'codex-proxy' }, category: 'general',
    });

    const result = await mod.projectP3394NodeToTeam({
      nodeId: 'codex-proxy', alias: 'CodexProxy', endpoints: ['http://127.0.0.1:9220'],
    });

    expect(result.agent_id).toBe(proxy?.agent_id);
    expect(result.agent_id).not.toBe(codex?.agent_id);
  });

  it('reuses the same-CLI card for a suffixed self-reported node id (workbuddy-final)', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    const agents = await import('../../../../src/main/features/agents');
    const workbuddy = await agents.createCustomAgent({
      name: 'WorkBuddy', description_zh: '', description_en: '', icon: 'code', color: 'sage',
      runtime: { kind: 'p3394-gateway', cli: 'workbuddy' }, category: 'general',
    });
    const result = await mod.projectP3394NodeToTeam({
      nodeId: 'workbuddy-final', alias: 'WorkBuddy', endpoints: ['http://127.0.0.1:9211'],
    });
    // 自报 id 带后缀 → 仍是同一个 CLI 的节点：复用同一张卡片，不重复建卡。
    expect(result.projected).toBe(false);
    expect(result.reason).toBe('existing_agent');
    expect(result.agent_id).toBe(workbuddy?.agent_id);
  });

  it('skips non-local nodes and endpoint-less cloud clients', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    const lan = await mod.projectP3394NodeToTeam({ nodeId: 'lan-agent', endpoints: ['http://192.0.2.5:9000'] });
    expect(lan.projected).toBe(false);
    expect(lan.reason).toBe('skip_non_local');

    const cloud = await mod.projectP3394NodeToTeam({ nodeId: 'cloud-agent', endpoints: [] });
    expect(cloud.projected).toBe(false);
    expect(cloud.reason).toBe('skip_non_local');

    const self = await mod.projectP3394NodeToTeam({ nodeId: 'cogseed', endpoints: ['http://127.0.0.1:8444'] });
    expect(self.projected).toBe(false);
    expect(self.reason).toBe('skip_local');
  });

  it('does not auto-recreate a deleted agent whose node is suppressed (gateway still alive)', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    const agents = await import('../../../../src/main/features/agents');
    // 首次投影创建 agent，然后用户删除 → 节点被抑制（模拟 agents.delete 联动）。
    const first = await mod.projectP3394NodeToTeam({
      nodeId: 'codex', alias: 'Codex', endpoints: ['http://127.0.0.1:9301'],
    });
    expect(first.projected).toBe(true);
    expect(await agents.deleteCustomAgent(first.agent_id!)).toBe(true);
    mod.suppressNodeProjection('codex');

    // 孤儿网关仍在线 hello → 不得自动重建同名 agent。
    const again = await mod.projectP3394NodeToTeam({
      nodeId: 'codex', alias: 'Codex', endpoints: ['http://127.0.0.1:9301'],
    });
    expect(again.projected).toBe(false);
    expect(again.reason).toBe('suppressed');
    expect((await agents.listAgents()).filter((agent) => agent.runtime?.kind === 'p3394-gateway')).toHaveLength(0);

    // 用户显式重新外接 → 解除抑制 → 允许再次投影（复用新建记录）。
    mod.unsuppressNodeProjection('codex');
    const reopened = await mod.projectP3394NodeToTeam({
      nodeId: 'codex', alias: 'Codex', endpoints: ['http://127.0.0.1:9301'],
    });
    expect(reopened.projected).toBe(true);
    expect(reopened.agent_id).not.toBe(first.agent_id);
  });

  it('projects an unknown self-built gateway node with a generic description', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    const result = await mod.projectP3394NodeToTeam({ nodeId: 'my-custom-agent', alias: '我的自研智能体', endpoints: ['http://127.0.0.1:9200'] });
    expect(result.projected).toBe(true);
    const agents = await import('../../../../src/main/features/agents');
    const created = (await agents.listAgents()).find((a) => a.agent_id === result.agent_id);
    expect(created?.name).toBe('我的自研智能体');
    expect(created?.runtime).toEqual({ kind: 'p3394-gateway', cli: 'my-custom-agent' });
  });
});
